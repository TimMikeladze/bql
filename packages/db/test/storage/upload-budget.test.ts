// L6. `ShipperPool.attach` creates one `Shipper` per open database, each with its own drain timer,
// and 1024 shipping databases were 1024 upload chains on one thread. The budget is the ceiling;
// what is asserted here is the ceiling itself, the ordering that keeps a stalled database from
// being starved by a busy one, and the give-up that stops a second queue forming behind the first.
//
// `UploadBudget` is exercised directly rather than through a real bucket: what the milestone
// promises is about admission, and a fake S3 would measure the fake.

import { afterAll, describe, expect, test } from "bun:test"
import { UploadBudget, UploadBudgetTimeout } from "../../src/storage/budget.ts"
import { cleanup, openBackend, openRegistry, openTenant, writeRows } from "./harness.ts"
import { ShipperPool } from "../../src/storage/pool.ts"

afterAll(() => cleanup())

/** A promise plus the handle to settle it, so a test can hold uploads open on purpose. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

describe("the budget itself", () => {
  test("at most `permits` uploads run at once, however many are offered", async () => {
    const budget = new UploadBudget(4)
    let running = 0
    let peak = 0
    const held = gate()
    const all = Array.from({ length: 200 }, (_, i) =>
      budget.run(i, 0, async () => {
        running++
        peak = Math.max(peak, running)
        await held.promise
        running--
      }),
    )
    // Nothing has been let go yet, so exactly the permits are in flight and the rest are queued.
    await Bun.sleep(5)
    expect(budget.inflight).toBe(4)
    expect(budget.waiting).toBe(196)
    held.open()
    await Promise.all(all)
    expect(peak).toBe(4)
    expect(budget.inflight).toBe(0)
    expect(budget.waiting).toBe(0)
  })

  test("the furthest-behind caller goes first, and equal priorities are FIFO", async () => {
    const budget = new UploadBudget(1)
    const order: string[] = []
    const held = gate()
    // One upload holds the only permit while the rest queue behind it out of order.
    const blocking = budget.run(0, 0, async () => {
      order.push("blocking")
      await held.promise
    })
    await Bun.sleep(5)
    const queued = [
      budget.run(900, 0, async () => void order.push("newest")),
      budget.run(100, 0, async () => void order.push("furthest-behind")),
      budget.run(500, 0, async () => void order.push("middle-a")),
      budget.run(500, 0, async () => void order.push("middle-b")),
    ]
    held.open()
    await Promise.all([blocking, ...queued])
    expect(order).toEqual(["blocking", "furthest-behind", "middle-a", "middle-b", "newest"])
  })

  test("a caller that runs out of patience is refused rather than queued forever", async () => {
    const budget = new UploadBudget(1)
    const held = gate()
    const blocking = budget.run(0, 0, () => held.promise)
    await Bun.sleep(5)
    const refused = budget.run(0, 20, async () => void 0)
    await expect(refused).rejects.toBeInstanceOf(UploadBudgetTimeout)
    expect(budget.timedOut).toBe(1)
    // And the permit is not leaked: the next caller gets it once the blocker lets go.
    held.open()
    await blocking
    await budget.run(0, 100, async () => void 0)
    expect(budget.inflight).toBe(0)
  })
})

describe("the pool", () => {
  test("every shipper draws on one budget, and its gauges reach the pool's metrics", async () => {
    const backend = await openBackend()
    const registry = openRegistry()
    const pool = new ShipperPool({
      registry,
      store: backend.store(),
      prefix: backend.prefix(),
      shipIntervalMs: 5,
      maxConcurrentUploads: 3,
      snapshotIntervalMs: 0,
      snapshotEveryBytes: 0,
      retentionMs: 0,
    })
    expect(pool.budget.permits).toBe(3)

    // Sixty databases shipping at once, which before L6 was sixty independent upload chains. The
    // ceiling is sampled *while* they run, because asserting it after they have all finished would
    // assert nothing.
    for (let i = 0; i < 60; i++) {
      const tenant = await openTenant(registry, `d${i}`)
      writeRows(tenant, 0, 5)
      pool.attach(tenant)
    }
    let peakInflight = 0
    let peakWaiting = 0
    const sampler = setInterval(() => {
      peakInflight = Math.max(peakInflight, pool.budget.inflight)
      peakWaiting = Math.max(peakWaiting, pool.budget.waiting)
    }, 1)
    try {
      await Promise.all([...pool.shippers.values()].map((one) => one.flush()))
    } finally {
      clearInterval(sampler)
    }

    expect(peakInflight).toBeGreaterThan(0)
    expect(peakInflight).toBeLessThanOrEqual(3)
    // Sixty shippers against three permits: somebody waited, which is the budget doing its job.
    expect(peakWaiting).toBeGreaterThan(0)

    // And nothing is left holding one.
    expect(pool.budget.inflight).toBe(0)
    expect(pool.budget.granted).toBeGreaterThan(60)
    const metrics = pool.metrics()
    expect(metrics.uploadInflight).toBe(0)
    expect(metrics.uploadWaiting).toBe(0)
    expect(metrics.shippedTxid).toBeGreaterThan(0)
    await pool.close()
  })
})
