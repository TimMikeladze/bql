// A type-level test: `bun run typecheck` is the assertion, and the runtime case below only keeps
// `bun test` honest about the file being reachable. What is being checked is that `Infer` tells
// the truth — above all that `.optional()` produces `{ a?: string }` and `.nullable()` produces
// `{ a: string | null }`, which are different things an OpenAPI client treats differently.

import { expect, test } from "bun:test"
import { ref, s, validate, type Infer, type Schema } from "../../src/core/index.ts"

/** Compiles only when `A` and `B` are the same type, in both directions. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
function exact<A, B>(_assertion: Exact<A, B>): void {}

const User = s
  .object({
    id: s.int(),
    name: s.string().describe("display name"),
    email: s.string().format("email").optional(),
    nickname: s.string().nullable(),
    tags: s.array(s.string()).default([]),
    role: s.enum(["admin", "member"]),
    rowid: s.int64(),
  })
  .id("User")

type User = Infer<typeof User>

exact<User["id"], number>(true)
exact<User["name"], string>(true)
exact<User["nickname"], string | null>(true)
exact<User["tags"], string[]>(true)
exact<User["role"], "admin" | "member">(true)
exact<User["rowid"], number | bigint>(true)

// `.optional()` is the key it leaves off, not a `| undefined` on the value.
const optionalKey: { email?: string } = {} as Pick<User, "email">
void optionalKey
// @ts-expect-error — a nullable property is required, so an empty object is not one.
const nullableIsRequired: Pick<User, "nickname"> = {}
void nullableIsRequired
// @ts-expect-error — `.nullable()` widens the value; `undefined` is not what it widened to.
const nullableIsNotOptional: Pick<User, "nickname"> = { nickname: undefined }
void nullableIsNotOptional

exact<Infer<typeof User>, User>(true)
exact<Infer<ReturnType<typeof s.string>>, string>(true)
exact<Infer<ReturnType<typeof s.blob>>, Uint8Array>(true)
exact<Infer<ReturnType<typeof s.sqliteValue>>, null | number | bigint | string | Uint8Array>(true)
exact<Infer<typeof point>, { x: number; y: number }>(true)
const point = s.object({ x: s.number(), y: s.number() })

exact<Infer<ReturnType<typeof User.partial>>, { [K in keyof User]?: User[K] }>(true)
exact<Infer<ReturnType<typeof extended>>, Omit<User, "name"> & { name: number }>(true)
const extended = () => User.extend({ name: s.int() })
exact<Infer<ReturnType<typeof picked>>, Pick<User, "id" | "email">>(true)
const picked = () => User.pick(["id", "email"])
exact<Infer<ReturnType<typeof omitted>>, Omit<User, "email">>(true)
const omitted = () => User.omit(["email"])

// A builder is a `Schema`, which is what every operation field and `validate()` take.
const asSchema: Schema = User
void asSchema
exact<Infer<typeof forward>, { name: string }>(true)
const forward = ref<{ name: string }>("Node")

test("validate narrows to the inferred type", () => {
  const result = validate(User, {
    id: 1,
    name: "ann",
    nickname: null,
    role: "admin",
    rowid: { $i: "9007199254740993" },
  })
  if (!result.ok) throw new Error(result.problems.map((p) => p.path).join(", "))
  const role: "admin" | "member" = result.value.role
  const rowid: number | bigint = result.value.rowid
  expect(role).toBe("admin")
  expect(rowid).toBe(9007199254740993n)
  expect(result.value.email).toBeUndefined()
})
