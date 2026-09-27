import { expect, test } from "bun:test"
import { qualifyAmbiguousRecovery } from "../../../../deploy/shared/recovery-fault.ts"
import { FakeObjectStore } from "./fake-store.ts"
test("provider fault qualification proves persisted lost responses recover without SQL replay", async () => {
  const result = await qualifyAmbiguousRecovery(new FakeObjectStore())
  expect(result.checks).toEqual(["lost-root-response", "empty-disk-recovery", "same-key-resolution"])
})
