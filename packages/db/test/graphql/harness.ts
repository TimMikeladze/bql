// A real tenant, a real `src/server/exec.ts`, a real generated registry and a real GraphQL schema
// over all of it. Nothing here is a mock: what these tests are for is that the token's ACL still
// applies after the request has been through a generated resolver and an in-process dispatch, and
// that cannot be shown against a fake.
//
// The token is carried the way the server will carry it — an `Authorization: Bearer <name>` header
// this fixture maps to a principal — so the per-request path the tests exercise is the real one
// and not a closure the test handed the handler.

import { ADMIN, type Principal } from "../../src/server/auth.ts"
import type { Execute } from "../../src/dataapi/index.ts"
import {
  type GraphQLHandler,
  type GraphQLHandlerOptions,
  graphqlHandler,
} from "../../src/graphql/index.ts"
import { dataApiFixture, type DataApiFixture } from "../dataapi/harness.ts"

export const ORIGIN = "http://graphql.test"

export interface GraphQLResponse<T = unknown> {
  status: number
  body: {
    data?: T
    errors?: {
      message: string
      path?: (string | number)[]
      extensions?: Record<string, unknown>
    }[]
  }
}

export interface AskOptions {
  /** The bearer name to send. Default `"admin"`, which the fixture grants the server's own rights. */
  as?: string
  variables?: Record<string, unknown>
  operationName?: string
  method?: "GET" | "POST"
}

export interface GraphQLFixture {
  data: DataApiFixture
  db: string
  handler: GraphQLHandler
  /** Mints a token principal under `name`, scoped to the tables given (all of them when absent). */
  grant(name: string, tables?: Record<string, "r" | "rw">): string
  ask<T = unknown>(query: string, options?: AskOptions): Promise<GraphQLResponse<T>>
  /** A raw request, for the protocol tests. */
  send(init: RequestInit & { path?: string }): Promise<Response>
  close(): Promise<void>
}

export interface GraphQLFixtureOptions {
  /** Merged into the handler's options: `maxDepth`, `peers`, `graphiql`, … */
  handler?: Partial<Omit<GraphQLHandlerOptions, "context" | "introspect">>
  /** Wraps the caller's `exec`, so a test can interleave two requests deliberately. */
  wrapExec?: (exec: Execute, as: string) => Execute
}

export async function graphqlFixture(
  db: string,
  schema: string,
  options: GraphQLFixtureOptions = {},
): Promise<GraphQLFixture> {
  const data = await dataApiFixture(db, schema)
  const principals = new Map<string, Principal>([["admin", ADMIN]])

  const handler = graphqlHandler({
    introspect: () => data.admin,
    context: (request, name) => {
      const as = bearer(request) ?? "admin"
      const principal = principals.get(as)
      if (!principal) throw new Error(`test harness: no principal named ${JSON.stringify(as)}`)
      const exec = data.execAs(principal)
      return { db: name, exec: options.wrapExec ? options.wrapExec(exec, as) : exec }
    },
    onError: () => {},
    ...options.handler,
  })

  const url = `${ORIGIN}/v1/db/${db}/graphql`

  return {
    data,
    db,
    handler,
    grant(name: string, tables?: Record<string, "r" | "rw">): string {
      principals.set(name, data.token(tables))
      return name
    },
    async ask<T>(query: string, ask: AskOptions = {}): Promise<GraphQLResponse<T>> {
      const payload = {
        query,
        ...(ask.variables ? { variables: ask.variables } : {}),
        ...(ask.operationName ? { operationName: ask.operationName } : {}),
      }
      const headers: Record<string, string> = {
        authorization: `Bearer ${ask.as ?? "admin"}`,
      }
      const response =
        ask.method === "GET"
          ? await handler(
              new Request(`${url}?query=${encodeURIComponent(query)}`, { headers }),
            )
          : await handler(
              new Request(url, {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify(payload),
              }),
            )
      const text = await response.text()
      return {
        status: response.status,
        body: (text.length > 0 ? JSON.parse(text) : {}) as GraphQLResponse<T>["body"],
      }
    },
    send({ path, ...init }: RequestInit & { path?: string }): Promise<Response> {
      return handler(new Request(`${ORIGIN}${path ?? `/v1/db/${db}/graphql`}`, init))
    },
    close(): Promise<void> {
      return data.close()
    },
  }
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization")
  if (!header) return undefined
  const [scheme, value] = header.split(" ")
  return scheme?.toLowerCase() === "bearer" ? value : undefined
}
