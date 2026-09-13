// Removing a temporary directory is a courtesy, not an assertion.
//
// Windows will not unlink a file that some handle still has open, so a suite that leaks one
// connection fails in *teardown* — where the failure is attributed to whatever test happened to
// be last, and where it can turn an otherwise green file red. POSIX has never cared, which is why
// every `afterAll` in this tree was written as a bare `rmSync`.
//
// `fs.rmSync` already knows how to wait out an `EBUSY`; it just needs to be told to. A few passes
// covers a handle the platform is still closing, and anything that outlives them is litter under
// `os.tmpdir()` rather than a result — so it is dropped rather than reported. The test that
// actually leaked the handle is the one worth failing, and it is not this one.

import fs from "node:fs"

export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })
  } catch {
    // Still held. Leave it; the operating system sweeps its own temp directory.
  }
}
