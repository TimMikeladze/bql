// One typed door to an S3-compatible bucket, over Bun's own `Bun.S3Client` (design §4.4). No
// dependency: Bun signs SigV4 itself, so AWS S3, Cloudflare R2, Tigris and MinIO are all the same
// code with a different `endpoint`.
//
// Invariant: a failure names the bucket, the key and the operation, and never the credentials.
// They are held in one private field, are never interpolated into a message, and nothing in this
// module logs. A caller that wants to know how the store is configured gets `describe()`, which
// reports the bucket, the prefix-free endpoint and the region and nothing else.
//
// Second invariant: every request goes through `#run`, which is what bounds concurrency and what
// retries. A retry is only ever taken for a failure the bucket might not repeat — a 5xx, a
// throttle, a timeout, a dropped socket. A 4xx is a bug in the request and retrying it would be a
// denial of service against your own bucket.

/** What a caller has to supply to reach a bucket. Anything omitted falls back to Bun's own
 * environment resolution (`S3_*`, then `AWS_*`), which is how a node running on AWS with an
 * instance role needs no credentials in its config at all. */
export interface S3StoreOptions {
  bucket: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  virtualHostedStyle?: boolean
  /** Requests in flight at once, across every key. Default 4. */
  concurrency?: number
  /** Attempts past the first for a retryable failure. Default 4. */
  retries?: number
  /** First backoff step in milliseconds; doubles with full jitter. Default 50. */
  retryBaseMs?: number
  /** Ceiling for one backoff step. Default 2000. */
  retryMaxMs?: number
}

export interface S3ObjectInfo {
  key: string
  size: number
  /** Wall clock of the object's last write, or null when the bucket did not say. */
  lastModifiedMs: number | null
  etag: string | null
}

export interface S3ListOptions {
  prefix?: string
  /** Continue after this key, exclusive. */
  after?: string
  /** Stop once this many objects have been collected. */
  limit?: number
  /** Group keys on this character, as `ListObjectsV2` does. */
  delimiter?: string
}

export interface S3ListPage {
  objects: S3ObjectInfo[]
  prefixes: string[]
  /** Pass back as `after` to get the next page, or null when the listing is complete. */
  next: string | null
}

/** A failure talking to the bucket, with everything an operator needs and nothing they must not see. */
export class S3StoreError extends Error {
  readonly code: string
  readonly bucket: string
  readonly key: string | null
  readonly op: string
  readonly attempts: number
  readonly status: number | null

  constructor(
    op: string,
    bucket: string,
    key: string | null,
    cause: unknown,
    attempts: number,
  ) {
    const detail = describeCause(cause)
    super(
      `s3 ${op} ${key === null ? `bucket ${bucket}` : `${bucket}/${key}`} failed` +
        `${attempts > 1 ? ` after ${attempts} attempts` : ""}: ${detail.message}`,
    )
    this.name = "S3StoreError"
    this.op = op
    this.bucket = bucket
    this.key = key
    this.code = detail.code
    this.status = detail.status
    this.attempts = attempts
    if (cause !== undefined) this.cause = cause
  }
}

/** A `get`/`head` of a key that is not there. Separated because callers branch on it constantly. */
export class S3NotFound extends S3StoreError {
  constructor(op: string, bucket: string, key: string, cause?: unknown) {
    super(op, bucket, key, cause ?? new Error("no such key"), 1)
    this.name = "S3NotFound"
  }
}

interface CauseDetail {
  code: string
  message: string
  status: number | null
}

/** Bun's S3 errors carry `code` and sometimes a numeric status; a socket failure carries neither. */
function describeCause(cause: unknown): CauseDetail {
  if (cause instanceof Error) {
    const anyErr = cause as Error & { code?: unknown; name?: string; statusCode?: unknown }
    const raw = typeof anyErr.code === "string" ? anyErr.code : anyErr.name || "S3Error"
    const status =
      typeof anyErr.statusCode === "number"
        ? anyErr.statusCode
        : statusFromCode(raw) ?? statusFromMessage(cause.message)
    return { code: raw, message: cause.message, status }
  }
  return { code: "S3Error", message: String(cause), status: null }
}

/** Bun reports the well-known S3 conditions by name rather than by status. */
const CODE_STATUS: Readonly<Record<string, number>> = {
  NoSuchKey: 404,
  NoSuchBucket: 404,
  ERR_S3_FILE_NOT_FOUND: 404,
  AccessDenied: 403,
  InvalidAccessKeyId: 403,
  SignatureDoesNotMatch: 403,
  RequestTimeout: 408,
  SlowDown: 429,
  InternalError: 500,
  ServiceUnavailable: 503,
}

function statusFromCode(code: string): number | null {
  return CODE_STATUS[code] ?? null
}

/** Bun stringifies the HTTP status into the message for conditions it has no name for. */
function statusFromMessage(message: string): number | null {
  const match = /\b(4\d\d|5\d\d)\b/.exec(message)
  return match ? Number(match[1]) : null
}

/** Network-level failures Bun surfaces as plain `Error`s with these codes. */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EAGAIN",
  "ConnectionRefused",
  "ConnectionClosed",
  "ConnectionTimeout",
  "Timeout",
  "FailedToOpenSocket",
  "SlowDown",
  "RequestTimeout",
  "InternalError",
  "ServiceUnavailable",
  "RequestTimeTooSkewed",
])

/**
 * Failures that are configuration, not weather. Retrying them just multiplies the same mistake —
 * found against a real MinIO, where a store built without credentials was tried five times.
 */
const PERMANENT_CODES = new Set([
  "ERR_S3_MISSING_CREDENTIALS",
  "ERR_S3_INVALID_METHOD",
  "ERR_S3_INVALID_PATH",
  "ERR_S3_INVALID_ENDPOINT",
  "ERR_S3_INVALID_SIGNATURE",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "AccessDenied",
  "NoSuchBucket",
  "InvalidBucketName",
  "EntityTooLarge",
])

function isRetryable(cause: unknown): boolean {
  const { code, status } = describeCause(cause)
  if (PERMANENT_CODES.has(code)) return false
  if (RETRYABLE_CODES.has(code)) return true
  if (status === null) {
    // No status at all is a transport failure: the request never reached the bucket, so it is
    // safe to send again. A refusal the bucket authored always carries one.
    return true
  }
  return status >= 500 || status === 408 || status === 429
}

function isNotFound(cause: unknown): boolean {
  const { code, status } = describeCause(cause)
  // A missing *bucket* is also a 404 and is emphatically not "this key is absent": callers treat
  // `S3NotFound` as nothing to do, and a typo in the bucket name must not be that.
  if (code === "NoSuchBucket") return false
  return status === 404 || code === "NoSuchKey" || code === "ERR_S3_FILE_NOT_FOUND"
}

type S3ClientLike = {
  file(path: string, options?: Record<string, unknown>): S3FileLike
  list(
    input: Record<string, unknown> | null,
    options?: Record<string, unknown>,
  ): Promise<{
    contents?: Array<{ key?: string; size?: number; lastModified?: unknown; eTag?: string }>
    commonPrefixes?: Array<{ prefix: string }>
    isTruncated?: boolean
    nextContinuationToken?: string
  }>
  delete(path: string, options?: Record<string, unknown>): Promise<void>
}

type S3FileLike = {
  bytes(): Promise<Uint8Array>
  stream(): ReadableStream<Uint8Array>
  write(body: unknown, options?: Record<string, unknown>): Promise<number>
  writer(options?: Record<string, unknown>): {
    write(chunk: Uint8Array): number | Promise<number>
    end(): Promise<number> | number
  }
  exists(): Promise<boolean>
  stat(): Promise<{ size: number; lastModified?: unknown; etag?: string; type?: string }>
  delete(): Promise<void>
  presign(options?: Record<string, unknown>): string
}

export class S3Store {
  readonly bucket: string
  readonly region: string | null
  readonly endpoint: string | null
  readonly concurrency: number
  readonly retries: number
  readonly retryBaseMs: number
  readonly retryMaxMs: number

  /** Credentials live here and are read by nothing but `#client`'s construction. */
  readonly #credentials: Record<string, unknown>
  #client: S3ClientLike
  #inFlight = 0
  #queue: Array<() => void> = []

  constructor(options: S3StoreOptions) {
    if (!options.bucket) throw new TypeError("an S3 store needs a bucket")
    this.bucket = options.bucket
    this.region = options.region || null
    this.endpoint = options.endpoint || null
    this.concurrency = Math.max(1, options.concurrency ?? 4)
    this.retries = Math.max(0, options.retries ?? 4)
    this.retryBaseMs = options.retryBaseMs ?? 50
    this.retryMaxMs = options.retryMaxMs ?? 2000

    // Only the fields that were actually set are passed through, so everything else falls back to
    // Bun's own `S3_*` / `AWS_*` resolution rather than being overridden with an empty string.
    const config: Record<string, unknown> = { bucket: options.bucket }
    if (options.region) config.region = options.region
    if (options.endpoint) config.endpoint = options.endpoint
    if (options.accessKeyId) config.accessKeyId = options.accessKeyId
    if (options.secretAccessKey) config.secretAccessKey = options.secretAccessKey
    if (options.sessionToken) config.sessionToken = options.sessionToken
    if (options.virtualHostedStyle) config.virtualHostedStyle = true
    // Bun retries inside `write` as well; ours is the outer loop and the only one that backs off,
    // so its own is turned down to one attempt to keep the two from multiplying.
    config.retry = 0
    this.#credentials = config
    this.#client = new (Bun as unknown as { S3Client: new (o: unknown) => S3ClientLike }).S3Client(
      config,
    )
  }

  /** Everything about this store that is safe to show an operator or put in a response body. */
  describe(): { bucket: string; region: string | null; endpoint: string | null } {
    return { bucket: this.bucket, region: this.region, endpoint: this.endpoint }
  }

  // ── objects ──────────────────────────────────────────────────────────────────────────────────

  /** Writes a whole object. `type` is the content type the bucket will report back. */
  async put(key: string, body: Uint8Array | string, type?: string): Promise<void> {
    await this.#run("put", key, async () => {
      const file = this.#client.file(key, this.#credentials)
      await file.write(body, type ? { type } : undefined)
    })
  }

  /**
   * Streams an object up through Bun's multipart writer. Used for a snapshot, which can be
   * hundreds of megabytes and must not be held in memory twice.
   */
  async putStream(
    key: string,
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    type?: string,
  ): Promise<void> {
    await this.#run("putStream", key, async () => {
      const file = this.#client.file(key, this.#credentials)
      const writer = file.writer(type ? { type } : undefined)
      for await (const chunk of chunks as AsyncIterable<Uint8Array>) {
        await writer.write(chunk)
      }
      await writer.end()
    })
  }

  /** The whole object. Throws `S3NotFound` when the key is not there. */
  async get(key: string): Promise<Uint8Array> {
    return this.#run("get", key, async () => {
      const file = this.#client.file(key, this.#credentials)
      return await file.bytes()
    })
  }

  /** The whole object, or null when the key is not there. */
  async getOrNull(key: string): Promise<Uint8Array | null> {
    try {
      return await this.get(key)
    } catch (err) {
      if (err instanceof S3NotFound) return null
      throw err
    }
  }

  /** A streaming read, for an object too big to want in one buffer. */
  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    return this.#run("getStream", key, async () => {
      const file = this.#client.file(key, this.#credentials)
      // `stream()` is lazy, so the request is only proved to have worked by reading it; `stat`
      // first turns "the key is missing" into `S3NotFound` here rather than mid-download.
      await file.stat()
      return file.stream()
    })
  }

  /** Size and mtime, or null when the key is not there. */
  async head(key: string): Promise<{ size: number; lastModifiedMs: number | null } | null> {
    try {
      return await this.#run("head", key, async () => {
        const stat = await this.#client.file(key, this.#credentials).stat()
        return { size: stat.size, lastModifiedMs: toMs(stat.lastModified) }
      })
    } catch (err) {
      if (err instanceof S3NotFound) return null
      throw err
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null
  }

  /** One page of a listing. `next` is the key to continue after. */
  async listPage(options: S3ListOptions = {}): Promise<S3ListPage> {
    return this.#run("list", options.prefix ?? null, async () => {
      const input: Record<string, unknown> = {}
      if (options.prefix) input.prefix = options.prefix
      if (options.after) input.startAfter = options.after
      if (options.delimiter) input.delimiter = options.delimiter
      if (options.limit) input.maxKeys = Math.min(1000, options.limit)
      const page = await this.#client.list(input, this.#credentials)
      const objects: S3ObjectInfo[] = []
      for (const entry of page.contents ?? []) {
        if (typeof entry.key !== "string") continue
        objects.push({
          key: entry.key,
          size: entry.size ?? 0,
          lastModifiedMs: toMs(entry.lastModified),
          etag: entry.eTag ?? null,
        })
      }
      const prefixes = (page.commonPrefixes ?? []).map((one) => one.prefix)
      const last = objects.at(-1)
      return {
        objects,
        prefixes,
        next: page.isTruncated && last ? last.key : null,
      }
    })
  }

  /** Every object under a prefix, following pagination. */
  async list(options: S3ListOptions = {}): Promise<S3ObjectInfo[]> {
    const out: S3ObjectInfo[] = []
    let after = options.after
    for (;;) {
      const page = await this.listPage({
        ...options,
        ...(after ? { after } : {}),
        ...(options.limit ? { limit: Math.min(1000, options.limit - out.length) } : {}),
      })
      out.push(...page.objects)
      if (options.limit !== undefined && out.length >= options.limit) return out.slice(0, options.limit)
      if (!page.next) return out
      after = page.next
    }
  }

  /** Removes a key. Removing one that is not there is not an error, as S3 itself has it. */
  async delete(key: string): Promise<void> {
    try {
      await this.#run("delete", key, async () => {
        await this.#client.file(key, this.#credentials).delete()
      })
    } catch (err) {
      if (err instanceof S3NotFound) return
      throw err
    }
  }

  /** Removes many keys, `concurrency` at a time. Returns how many were removed. */
  async deleteMany(keys: readonly string[]): Promise<number> {
    let done = 0
    const pending = [...keys]
    const workers = Array.from({ length: Math.min(this.concurrency, pending.length) }, async () => {
      for (;;) {
        const key = pending.shift()
        if (key === undefined) return
        await this.delete(key)
        done += 1
      }
    })
    await Promise.all(workers)
    return done
  }

  /** A pre-signed URL for a key. Passed straight through to Bun; nothing here inspects it. */
  presign(key: string, options: Record<string, unknown> = {}): string {
    try {
      return this.#client.file(key, this.#credentials).presign(options)
    } catch (err) {
      throw new S3StoreError("presign", this.bucket, key, err, 1)
    }
  }

  // -------------------------------------------------------------------------

  /** Bounded concurrency, jittered retry, and the one place a raw failure becomes an S3StoreError. */
  async #run<T>(op: string, key: string | null, fn: () => Promise<T>): Promise<T> {
    await this.#acquire()
    try {
      let attempt = 0
      for (;;) {
        attempt += 1
        try {
          return await fn()
        } catch (err) {
          if (key !== null && isNotFound(err)) throw new S3NotFound(op, this.bucket, key, err)
          if (attempt > this.retries || !isRetryable(err)) {
            throw new S3StoreError(op, this.bucket, key, err, attempt)
          }
          await Bun.sleep(this.#backoffMs(attempt))
        }
      }
    } finally {
      this.#release()
    }
  }

  /** Exponential with full jitter: the classic answer to a thundering herd of retries. */
  #backoffMs(attempt: number): number {
    const ceiling = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (attempt - 1))
    return Math.floor(Math.random() * ceiling)
  }

  #acquire(): Promise<void> {
    if (this.#inFlight < this.concurrency) {
      this.#inFlight += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.#queue.push(() => {
        this.#inFlight += 1
        resolve()
      })
    })
  }

  #release(): void {
    this.#inFlight -= 1
    const next = this.#queue.shift()
    if (next) next()
  }
}

/** S3 dates arrive as a `Date`, an ISO string or a number depending on the operation. */
function toMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
