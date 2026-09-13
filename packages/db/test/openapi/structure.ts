// The rules that decide whether a document can be *consumed*, as opposed to whether it looks
// right. There are no runtime dependencies in this repo, so this is a checker rather than a
// validator: it asserts the handful of structural invariants a code generator actually trips over,
// and says nothing about the rest of OpenAPI 3.1.

import type { OpenApiDocument } from "../../src/openapi/index.ts"

const POINTER = "#/components/schemas/"

/** Everything wrong with `document`, as sentences. An empty list is the assertion. */
export function checkDocument(document: OpenApiDocument): string[] {
  const problems: string[] = []
  const schemas = document.components?.schemas ?? {}
  const schemes = document.components?.securitySchemes ?? {}
  const seenIds = new Set<string>()

  for (const [pointer, value] of refs(document)) {
    if (!value.startsWith(POINTER)) {
      problems.push(`${pointer}: $ref "${value}" is not a components/schemas pointer`)
      continue
    }
    const name = value.slice(POINTER.length)
    if (!Object.hasOwn(schemas, name)) {
      problems.push(`${pointer}: $ref "${value}" resolves to nothing`)
    }
  }

  for (const [path, item] of Object.entries(document.paths)) {
    const bound = [...path.matchAll(/\{([^}]*)\}/g)].map((found) => found[1] as string)
    for (const method of ["get", "put", "post", "delete", "patch"] as const) {
      const operation = item[method]
      if (!operation) continue
      const where = `${method.toUpperCase()} ${path}`

      if (seenIds.has(operation.operationId)) {
        problems.push(`${where}: operationId "${operation.operationId}" is used twice`)
      }
      seenIds.add(operation.operationId)

      const declared = (operation.parameters ?? []).filter((one) => one.in === "path")
      for (const name of bound) {
        const parameter = declared.find((one) => one.name === name)
        if (!parameter) {
          problems.push(`${where}: the template binds {${name}}, which no parameter declares`)
        } else if (parameter.required !== true) {
          problems.push(`${where}: path parameter "${name}" is not required:true`)
        }
      }
      for (const parameter of declared) {
        if (!bound.includes(parameter.name)) {
          problems.push(`${where}: declares path parameter "${parameter.name}", not in the template`)
        }
      }

      const statuses = Object.keys(operation.responses)
      if (statuses.length === 0) problems.push(`${where}: has no responses`)
      for (const status of statuses) {
        const response = operation.responses[status]
        if (!response || typeof response.description !== "string" || response.description === "") {
          problems.push(`${where}: response ${status} has no description`)
        }
      }

      for (const requirement of operation.security ?? []) {
        for (const name of Object.keys(requirement)) {
          if (!Object.hasOwn(schemes, name)) {
            problems.push(`${where}: requires security scheme "${name}", which is not defined`)
          }
        }
      }
    }
  }
  return problems
}

/** Every `$ref` string anywhere in the document, with a JSON-pointer-ish path to it. */
function* refs(value: unknown, at = ""): Generator<[string, string]> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* refs(item, `${at}/${index}`)
    return
  }
  if (typeof value !== "object" || value === null) return
  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref" && typeof item === "string") yield [at || "/", item]
    else yield* refs(item, `${at}/${key}`)
  }
}
