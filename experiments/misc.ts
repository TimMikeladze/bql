import fs from "node:fs";
import { Database } from "bun:sqlite";
// 1) instant snapshot via Bun.write (clonefile on APFS?)
const big = import.meta.dir + "/big.bin"; fs.writeFileSync(big, Buffer.alloc(512 * 1024 * 1024, 7));
let t = Bun.nanoseconds(); await Bun.write(big + ".copy", Bun.file(big)); console.log("Bun.write copy 512MB:", ((Bun.nanoseconds() - t) / 1e6).toFixed(1), "ms");
t = Bun.nanoseconds(); fs.copyFileSync(big, big + ".copy2", fs.constants.COPYFILE_FICLONE); console.log("fs.copyFileSync FICLONE 512MB:", ((Bun.nanoseconds() - t) / 1e6).toFixed(1), "ms");
t = Bun.nanoseconds(); Bun.spawnSync(["cp", "-c", big, big + ".copy3"]); console.log("cp -c (clonefile) 512MB:", ((Bun.nanoseconds() - t) / 1e6).toFixed(1), "ms");
for (const x of [big, big + ".copy", big + ".copy2", big + ".copy3"]) fs.unlinkSync(x);
// 2) zstd on realistic pages: use the walproto replica wal (881KB) if present
const wal = import.meta.dir + "/wp/replica.db-wal"; if (!fs.existsSync(wal)) { console.log("run walproto.ts first for zstd/shm checks"); process.exit(0); } const buf = fs.readFileSync(wal);
for (const lvl of [1, 3]) { t = Bun.nanoseconds(); const c = Bun.zstdCompressSync(buf, { level: lvl }); const ms = (Bun.nanoseconds() - t) / 1e6; console.log(`zstd L${lvl}: ${buf.length} -> ${c.length} bytes (${(100 * c.length / buf.length).toFixed(0)}%) in ${ms.toFixed(2)}ms = ${(buf.length / 1048576 / (ms / 1000)).toFixed(0)} MB/s`); }
t = Bun.nanoseconds(); const h = Bun.hash.xxHash3(buf); console.log("xxHash3 of", buf.length, "bytes:", ((Bun.nanoseconds() - t) / 1e3).toFixed(0), "us");
// 3) replica apply while an EXTERNAL process holds an open read txn on the replica
const R = import.meta.dir + "/wp/replica.db";
const holder = Bun.spawn(["sqlite3", R], { stdin: "pipe", stdout: "pipe" });
holder.stdin.write("begin; select count(*) from t;\n"); holder.stdin.flush(); await Bun.sleep(300);
const r = new Database(R, { readonly: true });
console.log("replica read while external txn open:", r.query("select count(*) c from t").get());
// zero shm header (simulate apply) and read again -> needs recovery while external reader holds a read lock
const sfd = fs.openSync(R + "-shm", "r+"); fs.writeSync(sfd, new Uint8Array(136), 0, 136, 0); fs.closeSync(sfd);
try { console.log("after shm invalidate w/ external reader:", r.query("select count(*) c from t").get()); } catch (e: any) { console.log("after shm invalidate w/ external reader -> error:", e.message); }
holder.stdin.write("commit;\n.quit\n"); holder.stdin.flush(); await holder.exited;
console.log("after external reader gone:", r.query("select count(*) c from t").get());
