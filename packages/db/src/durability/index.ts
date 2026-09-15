// The durability layer's public surface: one sweep per thread, which is where the `"interval"`
// fsync policy's barriers go when `[durability] fsyncSweep` is `"shared"`.

export { FsyncSweep, type FsyncSweepOptions, type SweepTarget } from "./sweep.ts"
