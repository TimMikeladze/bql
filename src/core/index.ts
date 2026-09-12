// The piece every surface is a rendering of: a schema that is a JSON Schema, a validator that
// interprets that same object, and the operation/registry model `src/http/`, `src/openapi/` and
// `src/graphql/` consume. Design of record: `docs/plan-surfaces.md`.
//
// Invariant: this module imports nothing from the rest of BunQL, nothing from `bun:*` and nothing
// from `node:*`. It is pure and usable standalone, which is what "a bun http" and "a bun openapi"
// mean — the dependency direction in `docs/plan-surfaces.md` is strictly downward and this is the
// bottom of it.

export {
  cloneValue,
  collectNamed,
  codecOf,
  type ArraySchema,
  type Codec,
  type EnumMember,
  type Infer,
  type InferProps,
  isOptional,
  isSchema,
  type JsonSchemaNode,
  type JsonSchemaType,
  type NumberSchema,
  type ObjectSchema,
  type OptionalSchema,
  type Props,
  ref,
  s,
  type Schema,
  type SchemaNode,
  type StringSchema,
  toJsonSchema,
} from "./schema.ts"
export {
  type Problem,
  type Result,
  validate,
  type ValidateOptions,
} from "./validate.ts"
export {
  defineOperation,
  type ErrorCode,
  type GraphqlBinding,
  type HttpMethod,
  type Operation,
  type OperationBody,
  type OperationParams,
  type OperationResponse,
  pathParameters,
  Registry,
  type RegistryInfo,
  type Security,
  type ServerInfo,
} from "./operation.ts"
