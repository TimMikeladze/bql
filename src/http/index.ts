// The execution half of "one operation, three renderings" (`docs/plan-surfaces.md`): a `Registry`
// of operations, served either by `Bun.serve` or by a function call in this process.
//
// Invariant: both paths run one compiled pipeline per operation, so they cannot answer the same
// request differently. `mountRegistry` composes the operations into a `Bun.serve` routes table —
// Bun keeps doing the path matching, and an existing table's entries, including the CORS
// preflight `src/server/app.ts` writes, survive. `createDispatcher` is the same operations behind
// a `fetch`-shaped function, which is what milestone H5 hands `openapi-x-graphql` so a GraphQL
// field costs an in-process call rather than a TCP connection.
//
// Nothing here defines an error vocabulary: `src/server/errors.ts` owns the codes and the body
// shape, and `src/server/json.ts` owns the `{"$i"}` / `{"$b"}` encoding of the values JSON cannot
// carry. This module only reuses them.

export { encode, encodeJson } from "./encode.ts"
export {
  bodyReader,
  compileOperation,
  type ContextFactory,
  type Execute,
  executeOperation,
  type HttpOptions,
  type Invocation,
  type Invoke,
  newInvocation,
  type OperationInput,
  RequestInvalid,
  ResponseInvalid,
} from "./handler.ts"
export {
  type CompiledOperation,
  compileRegistry,
  compileRoutes,
  mountRegistry,
  type RoutedRequest,
  type RouteTable,
} from "./routes.ts"
export { createDispatcher, type DispatchOptions, type Dispatcher } from "./dispatch.ts"
