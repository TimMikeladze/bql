// Invariant: path matching stays Bun's. `Operation.path` is already stored in `Bun.serve`'s own
// `:param` syntax precisely so it can be handed over unchanged, so this module builds the `routes`
// table `src/server/app.ts` already builds by hand and adds nothing to the request hot path. There
// is no matcher here — the one in `dispatch.ts` exists only because an in-process call has no
// `Bun.serve` to ask, and `test/http/dispatch.test.ts` holds the two to the same answers.
//
// `mountRegistry` *composes*: it merges method keys into whatever table it is given rather than
// replacing entries. That is what keeps the CORS preflight alive — `app.ts` writes
// `OPTIONS: options` on every path it owns, this module never writes an `OPTIONS` key, and a
// registry mounted onto that table gains its methods beside the preflight instead of shadowing it.
// Bun answers `HEAD` from the `GET` route by itself, so there is no `HEAD` key either.
//
// Two operations claiming the same method on the same path is a mistake in the source, and it
// throws at mount time rather than letting one silently win. `Registry.add` already refuses that
// within one registry; this catches it across a registry and a hand-written table.

import type { Operation, Registry } from "../core/index.ts"
import {
  compileOperation,
  type ContextFactory,
  type HttpOptions,
  type Invoke,
} from "./handler.ts"

/** Bun hands a route handler the request with its matched `:param` values already attached. */
export type RoutedRequest = Request & { params?: Record<string, string> }

/** What `Bun.serve` takes as `routes`. Values are opaque to Bun's own types, and to ours. */
export type RouteTable = Record<string, unknown>

/** One operation and the pipeline compiled for it, which both surfaces run. */
export interface CompiledOperation<Ctx> {
  operation: Operation<any, any, Ctx>
  invoke: Invoke
}

/**
 * Compiles every operation in a registry once. `mountRegistry` and `createDispatcher` both build
 * on this, which is how a GraphQL field and the REST call it stands for cannot drift: there is one
 * compiled pipeline per operation, not one per surface.
 */
export function compileRegistry<Ctx>(
  registry: Registry<Ctx>,
  contextFor: ContextFactory<Ctx>,
  options: HttpOptions = {},
): CompiledOperation<Ctx>[] {
  return registry
    .operations()
    .map((operation) => ({ operation, invoke: compileOperation(operation, contextFor, options) }))
}

/** A `Bun.serve` route handler around a compiled operation. */
function routeHandler(invoke: Invoke) {
  return (request: RoutedRequest, server: unknown): Promise<Response> =>
    invoke(request, request.params ?? {}, server)
}

/**
 * Merges a registry's operations into `routes`, in place, and returns it. Existing entries —
 * another surface's methods, `app.ts`'s `OPTIONS` preflight — are kept.
 */
export function mountRegistry<Ctx>(
  routes: RouteTable,
  registry: Registry<Ctx>,
  contextFor: ContextFactory<Ctx>,
  options: HttpOptions = {},
): RouteTable {
  for (const { operation, invoke } of compileRegistry(registry, contextFor, options)) {
    mount(routes, operation, routeHandler(invoke))
  }
  return routes
}

/** The same thing onto a fresh table, for a server that serves nothing else. */
export function compileRoutes<Ctx>(
  registry: Registry<Ctx>,
  contextFor: ContextFactory<Ctx>,
  options: HttpOptions = {},
): RouteTable {
  return mountRegistry({}, registry, contextFor, options)
}

function mount(
  routes: RouteTable,
  operation: Operation<any, any, any>,
  handler: (request: RoutedRequest, server: unknown) => Promise<Response>,
): void {
  const method = operation.method.toUpperCase()
  const existing = routes[operation.path]
  if (existing === undefined) {
    routes[operation.path] = { [method]: handler }
    return
  }
  if (typeof existing !== "object" || existing === null || existing instanceof Response) {
    // A bare handler or a static `Response` at that path serves every method, so adding one
    // beside it would shadow the operation without saying so.
    throw new Error(
      `operation "${operation.id}": ${operation.path} is already served by a single handler for every method`,
    )
  }
  const table = existing as Record<string, unknown>
  if (table[method] !== undefined) {
    throw new Error(
      `operation "${operation.id}": ${method} ${operation.path} is already in the route table`,
    )
  }
  table[method] = handler
}
