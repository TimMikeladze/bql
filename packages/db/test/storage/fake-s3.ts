// An in-process S3-compatible server, enough of the REST API for `Bun.S3Client` and for
// `src/storage/` to be exercised end to end without a container.
//
// What it implements: `PUT`, `GET`, `HEAD`, `DELETE` on an object, `GET /<bucket>?list-type=2`
// with `prefix`, `start-after`, `max-keys`, `delimiter` and `continuation-token`, and the
// multipart upload trio (`?uploads`, `?partNumber=&uploadId=`, `POST ?uploadId=`) that Bun's
// streaming writer uses for anything past its part size.
//
// What it deliberately does not implement: **signature checking**. The point of this harness is
// the layout and the shipper, not SigV4, which is Bun's code and not ours. Anything with an
// `Authorization` header is accepted.
//
// Fault injection is what makes it worth having: `failNext`, `failUntilMs` and `offline` reproduce
// a transient 500, a bucket that is down for a while, and a bucket that is unreachable — the three
// things `docs/r3-storage.md` promises never reach the write path.

export interface FakeS3Options {
  bucket?: string
  /** Port to listen on. 0 picks a free one, which is what every test wants. */
  port?: number
}

interface StoredObject {
  body: Uint8Array
  type: string
  lastModified: number
  etag: string
}

export class FakeS3 {
  readonly bucket: string
  readonly objects = new Map<string, StoredObject>()

  /** Requests answered `500` before anything is stored. Decremented per request. */
  failNext = 0
  /** Answer `503` until this wall clock. 0 is off. */
  failUntilMs = 0
  /** Refuse the connection outright, which is what a bucket behind a dead network looks like. */
  offline = false
  /** Answer `403 AccessDenied`, which is the one failure that must never be retried. */
  denyAll = false
  /**
   * Every request the server saw, for assertions about ordering. `bytes` is the request body's
   * length on a `PUT` and 0 otherwise — which is what makes "how many bytes did this workload
   * upload" a question the harness can answer (`docs/r9-open-segment.md`).
   */
  readonly log: Array<{ method: string; key: string; status: number; bytes: number }> = []

  /** Bytes uploaded, by key. A key uploaded twice counts twice, which is the whole point. */
  uploadedBytes(match?: (key: string) => boolean): number {
    let total = 0
    for (const entry of this.log) {
      if (entry.method !== "PUT" || entry.status !== 200) continue
      if (match && !match(entry.key)) continue
      total += entry.bytes
    }
    return total
  }

  /** How many `PUT`s landed on each key, oldest first. */
  uploadCounts(match?: (key: string) => boolean): Map<string, number> {
    const counts = new Map<string, number>()
    for (const entry of this.log) {
      if (entry.method !== "PUT" || entry.status !== 200) continue
      if (match && !match(entry.key)) continue
      counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
    }
    return counts
  }

  #server: ReturnType<typeof Bun.serve> | null = null
  #port = 0
  #uploads = new Map<string, Map<number, Uint8Array>>()
  #uploadKeys = new Map<string, string>()
  #nextUpload = 1

  constructor(options: FakeS3Options = {}) {
    this.bucket = options.bucket ?? "bql-test"
  }

  static async start(options: FakeS3Options = {}): Promise<FakeS3> {
    const fake = new FakeS3(options)
    fake.#listen(options.port ?? 0)
    return fake
  }

  #listen(port: number): void {
    this.#server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: (request) => this.#handle(request),
    })
    this.#port = this.#server.port ?? port
  }

  get port(): number {
    return this.#port
  }

  /** Takes the bucket off the network entirely — the connection is refused, not answered. */
  goOffline(): void {
    if (!this.#server) return
    this.offline = true
    this.#server.stop(true)
    this.#server = null
  }

  /** Puts it back on the same port, with every object still in it. */
  goOnline(): void {
    if (this.#server) return
    this.offline = false
    this.#listen(this.#port)
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** The options an `S3Store` needs to reach this server. */
  get storeOptions(): {
    bucket: string
    endpoint: string
    region: string
    accessKeyId: string
    secretAccessKey: string
  } {
    return {
      bucket: this.bucket,
      endpoint: this.endpoint,
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test-secret",
    }
  }

  /** Keys under a prefix, sorted, for assertions. */
  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort()
  }

  /** Removes an object behind the shipper's back: what a bucket with a hole in it looks like. */
  drop(key: string): boolean {
    return this.objects.delete(key)
  }

  /** Replaces an object's body without touching the manifest, for a corruption test. */
  corrupt(key: string, body: Uint8Array): void {
    const existing = this.objects.get(key)
    if (!existing) throw new Error(`no object ${key}`)
    this.objects.set(key, { ...existing, body, lastModified: Date.now() })
  }

  stop(): void {
    this.#server?.stop(true)
    this.#server = null
  }

  /** Runs `fn` with the bucket unreachable, then puts it back. */
  async whileOffline<T>(fn: () => Promise<T>): Promise<T> {
    this.goOffline()
    try {
      return await fn()
    } finally {
      this.goOnline()
    }
  }

  // -------------------------------------------------------------------------

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // Path-style: `/<bucket>/<key…>`. Bun uses path style unless told otherwise.
    const parts = url.pathname.replace(/^\//, "")
    const slash = parts.indexOf("/")
    const bucket = slash < 0 ? parts : parts.slice(0, slash)
    const key = slash < 0 ? "" : decodeURIComponent(parts.slice(slash + 1))

    if (this.denyAll) {
      return this.#error(request.method, key, 403, "AccessDenied", "access denied")
    }
    if (this.failNext > 0) {
      this.failNext -= 1
      return this.#error(request.method, key, 500, "InternalError", "we encountered an error")
    }
    if (this.failUntilMs > Date.now()) {
      return this.#error(request.method, key, 503, "ServiceUnavailable", "reduce your rate")
    }
    if (bucket !== this.bucket) {
      return this.#error(request.method, key, 404, "NoSuchBucket", `no bucket ${bucket}`)
    }

    if (key === "" && url.searchParams.get("list-type") === "2") return this.#list(url)
    if (key === "") return this.#error(request.method, key, 400, "InvalidRequest", "no key")

    const uploadId = url.searchParams.get("uploadId")
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      return this.#startUpload(key)
    }
    if (request.method === "PUT" && uploadId !== null) {
      return await this.#uploadPart(request, url, uploadId)
    }
    if (request.method === "POST" && uploadId !== null) return this.#finishUpload(key, uploadId)
    if (request.method === "DELETE" && uploadId !== null) {
      this.#uploads.delete(uploadId)
      this.#uploadKeys.delete(uploadId)
      return this.#note(request.method, key, 204), new Response(null, { status: 204 })
    }

    switch (request.method) {
      case "PUT":
        return await this.#put(request, key)
      case "GET":
        return this.#get(key, false)
      case "HEAD":
        return this.#get(key, true)
      case "DELETE":
        return this.#delete(key)
      default:
        return this.#error(request.method, key, 405, "MethodNotAllowed", request.method)
    }
  }

  async #put(request: Request, key: string): Promise<Response> {
    const body = new Uint8Array(await request.arrayBuffer())
    const etag = `"${Bun.hash.xxHash3(body).toString(16)}"`
    this.objects.set(key, {
      body,
      type: request.headers.get("content-type") ?? "application/octet-stream",
      lastModified: Date.now(),
      etag,
    })
    this.#note("PUT", key, 200, body.byteLength)
    return new Response(null, { status: 200, headers: { etag } })
  }

  #get(key: string, headOnly: boolean): Response {
    const object = this.objects.get(key)
    if (!object) {
      return this.#error(headOnly ? "HEAD" : "GET", key, 404, "NoSuchKey", `no key ${key}`)
    }
    this.#note(headOnly ? "HEAD" : "GET", key, 200)
    const headers: Record<string, string> = {
      "content-type": object.type,
      "content-length": String(object.body.byteLength),
      etag: object.etag,
      "last-modified": new Date(object.lastModified).toUTCString(),
    }
    return new Response(headOnly ? null : object.body, { status: 200, headers })
  }

  #delete(key: string): Response {
    this.objects.delete(key)
    this.#note("DELETE", key, 204)
    return new Response(null, { status: 204 })
  }

  #list(url: URL): Response {
    const prefix = url.searchParams.get("prefix") ?? ""
    const delimiter = url.searchParams.get("delimiter") ?? ""
    const after = url.searchParams.get("continuation-token") ?? url.searchParams.get("start-after") ?? ""
    const maxKeys = Number(url.searchParams.get("max-keys") ?? "1000") || 1000

    const all = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix) && (after === "" || key > after))
      .sort()

    const contents: string[] = []
    const commonPrefixes = new Set<string>()
    let taken = 0
    let truncated = false
    for (const key of all) {
      if (delimiter) {
        const rest = key.slice(prefix.length)
        const at = rest.indexOf(delimiter)
        if (at >= 0) {
          commonPrefixes.add(prefix + rest.slice(0, at + delimiter.length))
          continue
        }
      }
      if (taken >= maxKeys) {
        truncated = true
        break
      }
      const object = this.objects.get(key) as StoredObject
      contents.push(
        `<Contents><Key>${escapeXml(key)}</Key>` +
          `<LastModified>${new Date(object.lastModified).toISOString()}</LastModified>` +
          `<ETag>&quot;${object.etag.replaceAll('"', "")}&quot;</ETag>` +
          `<Size>${object.body.byteLength}</Size>` +
          `<StorageClass>STANDARD</StorageClass></Contents>`,
      )
      taken += 1
    }

    const last = contents.length > 0 ? all[taken - 1] : null
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      `<Name>${escapeXml(this.bucket)}</Name>` +
      `<Prefix>${escapeXml(prefix)}</Prefix>` +
      `<KeyCount>${contents.length}</KeyCount>` +
      `<MaxKeys>${maxKeys}</MaxKeys>` +
      `<IsTruncated>${truncated}</IsTruncated>` +
      (truncated && last
        ? `<NextContinuationToken>${escapeXml(last)}</NextContinuationToken>`
        : "") +
      contents.join("") +
      [...commonPrefixes]
        .sort()
        .map((one) => `<CommonPrefixes><Prefix>${escapeXml(one)}</Prefix></CommonPrefixes>`)
        .join("") +
      `</ListBucketResult>`
    this.#note("GET", `?list-type=2&prefix=${prefix}`, 200)
    return new Response(body, { status: 200, headers: { "content-type": "application/xml" } })
  }

  #startUpload(key: string): Response {
    const uploadId = `upload-${this.#nextUpload++}`
    this.#uploads.set(uploadId, new Map())
    this.#uploadKeys.set(uploadId, key)
    this.#note("POST", `${key}?uploads`, 200)
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<InitiateMultipartUploadResult><Bucket>${escapeXml(this.bucket)}</Bucket>` +
        `<Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId>` +
        `</InitiateMultipartUploadResult>`,
      { status: 200, headers: { "content-type": "application/xml" } },
    )
  }

  async #uploadPart(request: Request, url: URL, uploadId: string): Promise<Response> {
    const parts = this.#uploads.get(uploadId)
    if (!parts) return this.#error("PUT", uploadId, 404, "NoSuchUpload", uploadId)
    const number = Number(url.searchParams.get("partNumber") ?? "1")
    const part = new Uint8Array(await request.arrayBuffer())
    parts.set(number, part)
    this.#note("PUT", `${uploadId}#${number}`, 200, part.byteLength)
    return new Response(null, { status: 200, headers: { etag: `"part-${number}"` } })
  }

  #finishUpload(key: string, uploadId: string): Response {
    const parts = this.#uploads.get(uploadId)
    const target = this.#uploadKeys.get(uploadId) ?? key
    if (!parts) return this.#error("POST", key, 404, "NoSuchUpload", uploadId)
    const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, body]) => body)
    const total = ordered.reduce((sum, one) => sum + one.byteLength, 0)
    const body = new Uint8Array(total)
    let at = 0
    for (const part of ordered) {
      body.set(part, at)
      at += part.byteLength
    }
    this.objects.set(target, {
      body,
      type: "application/octet-stream",
      lastModified: Date.now(),
      etag: `"${Bun.hash.xxHash3(body).toString(16)}"`,
    })
    this.#uploads.delete(uploadId)
    this.#uploadKeys.delete(uploadId)
    this.#note("POST", target, 200)
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult>` +
        `<Bucket>${escapeXml(this.bucket)}</Bucket><Key>${escapeXml(target)}</Key>` +
        `</CompleteMultipartUploadResult>`,
      { status: 200, headers: { "content-type": "application/xml" } },
    )
  }

  #error(method: string, key: string, status: number, code: string, message: string): Response {
    this.#note(method, key, status)
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code>` +
        `<Message>${escapeXml(message)}</Message></Error>`,
      { status, headers: { "content-type": "application/xml" } },
    )
  }

  #note(method: string, key: string, status: number, bytes = 0): void {
    this.log.push({ method, key, status, bytes })
  }
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}
