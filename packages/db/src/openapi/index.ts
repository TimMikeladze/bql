// Registry → OpenAPI 3.1 JSON (`docs/plan-surfaces.md`, milestone H3; as-built notes in
// `docs/h3-openapi.md`).
//
// Invariant: pure. A registry in, a document out — no I/O, no Bun API, no `node:` import and no
// route. `GET /v1/openapi.json` and `GET /v1/db/{db}/openapi.json` are `src/server/routes.ts`,
// which H6 owns; this module only builds the thing they serve.
//
// The document is the input to a code generator. H5 does not read the registry — it reads this
// document and hands it to `openapi-x-graphql` — so `operationId`s, component names, `$ref`s and
// descriptions decide what the generated GraphQL schema is called.
//
// JSON only: Bun parses YAML and does not serialise it, and a YAML writer would cost the
// zero-dependency rule for a convenience (`docs/plan-surfaces.md`).

export {
  ADMIN_SCHEME,
  BEARER_SCHEME,
  buildDocument,
  type DocumentOptions,
  templatePath,
} from "./document.ts"
export { errorBodySchema, reasonPhrase, statusForCode } from "./errors.ts"
export { componentPointer } from "./schemas.ts"
export type {
  ComponentsObject,
  ContactObject,
  ExampleObject,
  ExternalDocumentationObject,
  HeaderObject,
  InfoObject,
  LicenseObject,
  MediaTypeObject,
  OpenApiDocument,
  OperationObject,
  ParameterLocation,
  ParameterObject,
  PathItemObject,
  PathsObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
  SchemaObject,
  SecurityRequirementObject,
  SecuritySchemeObject,
  ServerObject,
  ServerVariableObject,
  TagObject,
} from "./types.ts"
