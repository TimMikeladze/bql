import { expect, test } from "bun:test"
import { containerEnvironment, routeRequest } from "../src/routing.ts"

const vars = {
  BQL_DEPLOYMENT_ENV: "preview", BQL_DATA_DEPLOYMENT_ID: "preview-demo",
  BQL_STORAGE_DEPLOYMENT_ID: "preview-demo", BQL_ADMIN_KEY: "private-admin",
  BQL_JWT_ED25519: "private-signing-key", BQL_S3_BUCKET: "preview-bucket",
  BQL_S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  BQL_S3_ACCESS_KEY_ID: "private-access", BQL_S3_SECRET_ACCESS_KEY: "private-secret",
}

test("only explicit server settings and secrets enter the container", () => {
  const env = containerEnvironment({ ...vars, PATH: "host-path", BQL_DATA_STORAGE_MODE: "disk" })
  expect(env.BQL_ADMIN_KEY).toBe(vars.BQL_ADMIN_KEY)
  expect(env.BQL_DATA_STORAGE_MODE).toBe("object")
  expect(env.BQL_DATA_DIR).toBe("/tmp/bql")
  expect(env.BQL_S3_REGION).toBe("auto")
  expect(env.PATH).toBeUndefined()
  expect(() => containerEnvironment({ ...vars, BQL_STORAGE_DEPLOYMENT_ID: "production-demo" })).toThrow("identity")
  expect(() => containerEnvironment({ ...vars, BQL_ADMIN_KEY: "" })).toThrow("BQL_ADMIN_KEY")
})

test("routing uses the configured deployment identity and preserves HTTP data", async () => {
  const names: string[] = []
  const request = new Request("https://example.test/v1/db/test/query?target=other", {
    method: "POST", headers: { authorization: "Bearer key", "idempotency-key": "retry-one" }, body: '{"sql":"SELECT 1"}',
  })
  const response = await routeRequest(request, { ...vars, DATABASE: {
    getByName(name: string) {
      names.push(name)
      return { async fetch(forwarded: Request) {
        expect(forwarded.url).toBe(request.url)
        expect(forwarded.headers.get("authorization")).toBe("Bearer key")
        expect(forwarded.headers.get("idempotency-key")).toBe("retry-one")
        return new Response(await forwarded.text(), { status: 409, headers: { "bql-revision": "12" } })
      } }
    },
  } })
  expect(names).toEqual(["preview:preview-demo"])
  expect(response.status).toBe(409)
  expect(response.headers.get("bql-revision")).toBe("12")
  expect(await response.json()).toEqual({ sql: "SELECT 1" })
})

test("misconfigured routing fails closed without revealing secrets or starting a container", async () => {
  let starts = 0
  const response = await routeRequest(new Request("https://example.test"), {
    ...vars, BQL_STORAGE_DEPLOYMENT_ID: "production-demo",
    DATABASE: { getByName() { starts++; throw new Error("unexpected") } },
  })
  expect(response.status).toBe(503)
  expect(starts).toBe(0)
  expect(await response.text()).not.toContain("private")
})
