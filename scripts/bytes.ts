// Invariant: no tracked file carries a raw control byte. A separator or a magic number written as
// the byte itself rather than as an escape is a real defect, and an unusually quiet one.
//
// Git decides a blob is binary by looking for a NUL in the **first 8000 bytes** only. Past that
// window the file still gets a normal line diff, `file(1)` still calls it UTF-8 text, and nothing
// warns anyone — while the byte breaks `grep`, some editors, and any tool that assumes text. Both
// halves of that were observed here on the same day: one file was caught because its NUL landed
// inside the window and an identical one in a longer file was not. So the check is a byte scan,
// not a heuristic, and it runs in CI.
//
// Tab, newline and carriage return are the three control bytes that legitimately appear in source.
// Everything else has an escape and should be written as one: `"\0"`, `"\x01"`.
//
//   bun run scripts/bytes.ts          # report
//   bun run scripts/bytes.ts --check  # exit 1 if anything is found

const ALLOWED = new Set([0x09, 0x0a, 0x0d])

/** Files whose bytes are their content, where a control byte carries no meaning about the source. */
const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|zip|gz|wasm|pdf|db|sqlite3?|so|dylib)$/i

const listed = await new Response(
  Bun.spawn(["git", "ls-files", "-z"], { stdout: "pipe" }).stdout,
).text()
const files = listed.split("\0").filter((name) => name.length > 0 && !BINARY.test(name))

interface Finding {
  file: string
  offset: number
  byte: number
  line: number
  context: string
}

const findings: Finding[] = []

for (const file of files) {
  // A path can be tracked and absent at once — a staged deletion, a sparse checkout. That is a
  // normal state, not a finding, and reading it would end the scan on the first one.
  const handle = Bun.file(file)
  if (!(await handle.exists())) continue
  const bytes = new Uint8Array(await handle.arrayBuffer())
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number
    if ((byte >= 0x20 && byte !== 0x7f) || ALLOWED.has(byte)) continue
    let line = 1
    for (let j = 0; j < i; j++) if (bytes[j] === 0x0a) line++
    const from = Math.max(0, i - 40)
    const context = new TextDecoder().decode(bytes.subarray(from, i))
    findings.push({ file, offset: i, byte, line, context })
  }
}

for (const found of findings) {
  const hex = `0x${found.byte.toString(16).padStart(2, "0")}`
  console.error(`${found.file}:${found.line}: raw ${hex} at byte ${found.offset}`)
  console.error(`  …${found.context}  <${hex}>`)
  console.error(`  write it as an escape: ${found.byte === 0 ? '"\\0"' : `"\\x${found.byte.toString(16).padStart(2, "0")}"`}`)
}

if (findings.length === 0) {
  console.log(`no raw control bytes in ${files.length} tracked files`)
} else {
  console.error(`\n${findings.length} raw control byte(s) in ${new Set(findings.map((f) => f.file)).size} file(s)`)
}

if (Bun.argv.includes("--check") && findings.length > 0) process.exit(1)
