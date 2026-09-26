// Invariant: these types describe exactly the document `buildDocument` emits — no wider, so a
// consumer can read a field without a cast, and no narrower, so nothing the emitter writes is
// untyped. H5 hands an `OpenApiDocument` straight to `openapi-x-graphql`, which takes a document
// object; typing it as `unknown` there would put a cast on the one hop that matters.
//
// OpenAPI 3.1's own schema dialect *is* JSON Schema 2020-12, which is the dialect
// `src/core/schema.ts` builds. So `SchemaObject` is core's `JsonSchemaNode`, not a parallel
// declaration of the same keywords — the two cannot drift because there is one of them.
//
// Only the parts of 3.1 this emitter produces are modelled. `webhooks`, `callbacks`, `links`,
// `discriminator` and the OAuth2 flow objects are absent because nothing in bql.sh's operation
// model produces them; the `[extension: string]: unknown` index signatures carry `x-` keys and
// anything a later milestone adds.

import type { JsonSchemaNode } from "../core/index.ts"

/** One JSON Schema (2020-12) node, which is what OpenAPI 3.1 means by a Schema Object. */
export type SchemaObject = JsonSchemaNode

/** `{"$ref": "#/components/schemas/User"}`. */
export interface ReferenceObject {
  $ref: string
  summary?: string
  description?: string
}

export interface ContactObject {
  name?: string
  url?: string
  email?: string
}

export interface LicenseObject {
  name: string
  identifier?: string
  url?: string
}

export interface InfoObject {
  title: string
  version: string
  summary?: string
  description?: string
  termsOfService?: string
  contact?: ContactObject
  license?: LicenseObject
  [extension: string]: unknown
}

export interface ServerVariableObject {
  enum?: string[]
  default: string
  description?: string
}

export interface ServerObject {
  url: string
  description?: string
  variables?: Record<string, ServerVariableObject>
}

export interface ExternalDocumentationObject {
  url: string
  description?: string
}

export interface TagObject {
  name: string
  description?: string
  externalDocs?: ExternalDocumentationObject
}

export interface ExampleObject {
  summary?: string
  description?: string
  value?: unknown
  externalValue?: string
}

export interface MediaTypeObject {
  schema?: SchemaObject | ReferenceObject
  example?: unknown
  examples?: Record<string, ExampleObject>
  [extension: string]: unknown
}

/** A Header Object is a Parameter Object without `name` and `in`. */
export interface HeaderObject {
  description?: string
  required?: boolean
  deprecated?: boolean
  schema?: SchemaObject | ReferenceObject
  example?: unknown
  [extension: string]: unknown
}

export type ParameterLocation = "path" | "query" | "header" | "cookie"

export interface ParameterObject extends HeaderObject {
  name: string
  in: ParameterLocation
}

export interface RequestBodyObject {
  description?: string
  required?: boolean
  content: Record<string, MediaTypeObject>
}

export interface ResponseObject {
  /** Required by the specification, so `buildDocument` always writes one. */
  description: string
  headers?: Record<string, HeaderObject>
  content?: Record<string, MediaTypeObject>
  [extension: string]: unknown
}

/** Keyed by status as a string (`"200"`, `"409"`); this emitter never writes `"default"`. */
export type ResponsesObject = Record<string, ResponseObject>

/** `{ bearerAuth: [] }`; an empty object is "no credential", which is what `security: "none"` is. */
export type SecurityRequirementObject = Record<string, string[]>

export interface OperationObject {
  operationId: string
  tags?: string[]
  summary?: string
  description?: string
  externalDocs?: ExternalDocumentationObject
  parameters?: ParameterObject[]
  requestBody?: RequestBodyObject
  responses: ResponsesObject
  deprecated?: boolean
  security?: SecurityRequirementObject[]
  servers?: ServerObject[]
  [extension: string]: unknown
}

/** The methods `src/core/operation.ts` allows, which is what a path item can carry here. */
export interface PathItemObject {
  summary?: string
  description?: string
  get?: OperationObject
  put?: OperationObject
  post?: OperationObject
  delete?: OperationObject
  patch?: OperationObject
  parameters?: ParameterObject[]
  [extension: string]: unknown
}

export type PathsObject = Record<string, PathItemObject>

/** The two schemes of design §6: the EdDSA JWT, and the config admin key. Both are HTTP bearer. */
export interface SecuritySchemeObject {
  type: "http" | "apiKey" | "oauth2" | "openIdConnect" | "mutualTLS"
  description?: string
  scheme?: string
  bearerFormat?: string
  name?: string
  in?: "query" | "header" | "cookie"
  openIdConnectUrl?: string
}

export interface ComponentsObject {
  schemas?: Record<string, SchemaObject>
  securitySchemes?: Record<string, SecuritySchemeObject>
  [extension: string]: unknown
}

export interface OpenApiDocument {
  openapi: string
  info: InfoObject
  jsonSchemaDialect?: string
  servers?: ServerObject[]
  paths: PathsObject
  components?: ComponentsObject
  security?: SecurityRequirementObject[]
  tags?: TagObject[]
  externalDocs?: ExternalDocumentationObject
  [extension: string]: unknown
}
