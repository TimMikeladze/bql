// Invariant: **the caller's rights are ambient per request and are never captured by anything the
// schema cache holds.** This is the security boundary of the GraphQL surface and it is the one
// thing in this milestone that is easy to get silently wrong.
//
// The schema, the generated resolvers and the dispatcher behind them are built **once per tenant**
// and cached on `PRAGMA schema_version`. The caller's token is **per request**, and it is what the
// per-table ACLs in `src/server/exec.ts` are enforced from. Three ways of joining those that do
// not work, and why:
//
//   * baking the token into `ExecutorOptions.headers` — the generator's static header map is part
//     of the schema, so every later caller would send the first caller's token;
//   * putting the token in the cache key — correct, and it defeats the cache: a schema per token
//     is an introspection per token;
//   * a `fetch` closure that captured a token — the closure lives as long as the schema, so caller
//     B's fields would resolve with caller A's rights. A silent privilege escalation with no error
//     anywhere, which is exactly the bug this module exists to make impossible.
//
// So the context travels in an `AsyncLocalStorage` store entered around `execute()` and **read**
// inside the in-process `fetch`, once per dispatch. `experiments/graphql-inproc.ts` proved the
// store survives the resolver chain under Bun before any of this was designed
// (`docs/plan-surfaces.md`, "Proven before designing").
//
// It fails closed: a dispatch with no store is a programming error, not an anonymous request, and
// `currentCall` throws rather than returning anything a resolver could run with.

import { AsyncLocalStorage } from "node:async_hooks"
import type { DataApiContext } from "../dataapi/index.ts"

/** One GraphQL request in flight: which database, and the rights the caller brought to it. */
export interface GraphQLCall {
  /** The database the request addressed. */
  readonly db: string
  /** The caller's own `{db, exec}` — `exec` closes over `src/server/exec.ts` as this principal. */
  readonly context: DataApiContext
}

const calls = new AsyncLocalStorage<GraphQLCall>()

/** Runs `fn` with `call` ambient, for the whole resolver chain `fn` starts. */
export function runInCall<T>(call: GraphQLCall, fn: () => T): T {
  return calls.run(call, fn)
}

/** The call in flight. Throws rather than guessing: no store means no rights, never full rights. */
export function currentCall(): GraphQLCall {
  const call = calls.getStore()
  if (!call) {
    throw new Error(
      "bql/graphql: no request is in flight. A generated resolver dispatched outside " +
        "`runInCall`, so the caller's rights are unknown — refusing rather than running with " +
        "anyone else's.",
    )
  }
  return call
}

/** The call in flight, or `undefined`. For a caller that means to branch, not to run a statement. */
export function peekCall(): GraphQLCall | undefined {
  return calls.getStore()
}
