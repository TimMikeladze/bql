// A database's own tables as a GraphQL schema, generated from the OpenAPI document those tables
// already produce and resolved **in this process** (`docs/plan-surfaces.md`, milestone H5;
// as-built notes in `docs/h5-graphql.md`).
//
// Three invariants, one per module that is not wiring:
//
//   1. **No static import of `graphql` or `openapi-x-graphql`.** Both are optional peers and
//      BunQL's runtime dependency count is zero; they load through `import()` at the first request
//      that needs a schema, and their absence is a named error carrying the install command
//      (`src/graphql/peers.ts`).
//   2. **The caller's rights are ambient per request and never captured.** The schema is built
//      once per tenant and cached on `PRAGMA schema_version`; the token is per request and is what
//      the table ACLs are enforced from. A `fetch` closure holding one would hand caller A's
//      rights to caller B (`src/graphql/ambient.ts`).
//   3. **Every operation is measured before it runs.** A query past `maxDepth` or `maxComplexity`
//      dispatches nothing (`src/graphql/limits.ts`).
//
// And the one that makes the whole milestone cheap: **the schema is generated from the document,
// not from a second description of the same tables.** `src/dataapi/` introspects once,
// `src/openapi/` describes that registry, and the generator reads the description — so a GraphQL
// field is a REST operation by construction. Resolvers dispatch through
// `createDispatcher` (`src/http/`), which is the very pipeline the served route runs, so a field
// and the REST call it stands for cannot answer differently.
//
// Nothing here mounts a route: `POST /v1/db/{db}/graphql` is `src/server/routes.ts`. Nothing here
// runs a statement either — every dispatch ends in `src/server/exec.ts`, which is where the ACLs,
// deadlines, row caps, quotas, txids and write forwarding already live.
//
// Subscriptions are milestone H7, over the change feed in `src/realtime/`. They are not here: a
// REST document cannot describe one, so there is nothing for the generator to make of it.

export { currentCall, type GraphQLCall, peekCall, runInCall } from "./ambient.ts"
export {
  DEFAULT_API_PREFIX,
  INTERNAL_ORIGIN,
  tenantBaseUrl,
  tenantDocument,
  type TenantDocumentOptions,
  tenantPrefix,
} from "./document.ts"
export {
  type FormattedGraphQLError,
  liftBunQLError,
  nullOnNotFound,
  REQUEST_FAILED,
} from "./errors.ts"
export {
  databaseFromPath,
  type GraphQLHandler,
  type GraphQLHandlerOptions,
  graphqlHandler,
} from "./handler.ts"
export {
  checkLimits,
  DEFAULT_MAX_COMPLEXITY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_ROWS,
  type LimitOptions,
  type LimitProblem,
  type LimitReport,
} from "./limits.ts"
export {
  graphqlAvailable,
  loadPeers,
  MissingPeersError,
  PEER_INSTALL,
  PEER_PACKAGES,
  type PeerLoaders,
  type Peers,
} from "./peers.ts"
export {
  DEFAULT_MAX_SCHEMAS,
  SchemaCache,
  schemaFor,
  type SchemaOptions,
  type TenantGraphQL,
} from "./schema.ts"
export { prepareDocument } from "./handler.ts"
export {
  type ChangeFeedHost,
  pushIterator,
  type SubscriptionContext,
  withSubscription,
} from "./subscription.ts"
export {
  GRAPHQL_WS_PROTOCOL,
  GraphQLSocket,
  type GraphQLSocketHost,
  type GraphQLSocketLike,
  type PreparedOperation,
  WS_CLOSE,
} from "./ws.ts"
