// X6: the outbox relay — every row change a matching database commits, published to a bus
// subject once (`docs/x6-outbox.md`).
//
// Invariant: the relay reads the **log**, never the change feed. The feed is in memory and
// post-commit, so a crash between a commit and its publish would lose the event; the log is on
// disk, and since P9 a version-2 record carries the rows (`docs/p9-logical-cdc.md`). A cursor file
// says how far each rule has published, and it moves only after the bus acknowledged the batch.
// A crash between the publish and the cursor write re-publishes that batch, and every message
// carries a dedupe key derived from where the change sits in the log — so the bus holds each change
// exactly once however many times the relay tried.
//
// Second invariant: the relay never publishes a record a crash could take back. Every drain
// fsyncs the log up to the txid it is about to read first. Publishing an appended-but-unsynced
// record, then losing it, would publish a change that never happened — and the txid would be
// reused by the next commit, whose own message the bus would then drop as a duplicate.
//
// Third invariant: never a silent skip. A cursor that retention overtook logs `OUTBOX_GAP` with
// the range lost and counts it; a record written before `logicalChanges` was on is counted as
// skipped; a transaction whose rows were truncated by `maxRowsPerTxn` says so in every message.
//
// Lifecycle follows the S3 shipper (`src/storage/pool.ts`): a tailer binds to the open tenant,
// a commit arms a drain, and a tenant the LRU closed while it was behind is reopened by the sweep.
// Nothing here is on a request path.

import type { OutboxRule } from "../server/config.ts"
import { globMatch } from "../server/auth.ts"
import { decodeLogical, narrowRowChange } from "../realtime/logical.ts"
import { type Tenant, type TenantRegistry, tenantDir } from "../tenant/index.ts"
import { decode, decodeHeader, RECORD_VERSION_LOGICAL } from "../wal/index.ts"
import { readCursors, writeCursor } from "./cursor.ts"
import { type BusMessage, httpPublisher, type Publisher } from "./publisher.ts"

/** What the relay needs from the server runtime, and nothing more. */
export interface OutboxHost {
  registry: TenantRegistry
  /** False for a database another worker thread owns. */
  owns(db: string): boolean
  /** True while this node authors the database's transactions. */
  authors(tenant: Tenant): boolean
  /** The database's identity, so a database re-created under the same name has new dedupe keys. */
  generationOf(db: string): string | null
  /** Where a database's own history begins: its fork point, or 0 for one that was created. */
  startOf(db: string): bigint
  onError(err: unknown): void
  /** Operational news: `OUTBOX_GAP`, a bus that started or stopped failing. */
  warn(message: string): void
}

export interface OutboxRelayOptions {
  rules: OutboxRule[]
  batchSize?: number
  intervalMs?: number
  maxBackoffMs?: number
  /** Stop adding records to a batch once its JSON passes this many bytes. Default 4 MiB. */
  maxBatchBytes?: number
  /** Databases reopened per sweep to catch up; bounds the LRU churn one sweep can cause. */
  reopenPerSweep?: number
  /** Replaces the HTTP publisher: what a test injects. */
  publisherFor?: (rule: OutboxRule) => Publisher
}

/** One rule's view of one database, for `GET /v1/db/:db/replication`. */
export interface OutboxState {
  rule: string
  busUrl: string
  subject: string
  /** The last txid every change of which the bus has acknowledged. */
  cursor: number
  /** Committed transactions the relay has not published yet. */
  lag: number
  published: number
  skipped: number
  gaps: number
  lastError: string | null
  lastPublishedAt: number | null
  backoffMs: number
}

export interface OutboxTotals {
  published: number
  skipped: number
  gaps: number
  truncated: number
  errors: number
  /** Tailers whose database has committed past their cursor. */
  behind: number
  /** Largest lag in transactions across every tailer. */
  lagMax: number
}

/** A subject token: letters, digits, `_` and `-`, which is what the bus accepts. */
export function subjectToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_-]/g, "_")
  return token.length > 0 ? token : "_"
}

export function subjectFor(template: string, db: string, table: string): string {
  return template.replaceAll("{db}", subjectToken(db)).replaceAll("{table}", subjectToken(table))
}

/**
 * `<db>:<generation>:<txid>:<postChecksum>` — every message of one transaction starts with it.
 *
 * A txid alone does not name a change. A branch `reset` keeps its name and its generation and
 * starts its txids again at the parent's head; a database rewound in place reuses txids; a promoted
 * replica commits txids the old primary may also have committed and published before it died. In
 * each case the same `<db>:<txid>` carries different content, and a key without more in it would
 * make the bus drop the new change as a duplicate of the old, silently.
 *
 * The record's `postChecksum` — the rolling checksum of the whole database after the transaction —
 * is what separates them, and it is better than a random incarnation for one reason: it is the
 * *same* on every copy of the same history. A crash-restart re-reads the same record, and a
 * promoted replica's log holds byte-identical records for everything it received from the old
 * primary, so both re-publish under the keys already on the bus and dedupe as they should. A
 * random id minted on promotion would duplicate every change the two nodes share.
 *
 * Two histories that reach the same txid with the same rows *and* the same database state are
 * given the same key, and that is deliberate: nothing any consumer could observe tells them apart.
 */
export function dedupeKeyPrefix(
  db: string,
  generation: string,
  txid: bigint,
  postChecksum: bigint,
): string {
  return `${db}:${generation}:${txid}:${postChecksum.toString(16).padStart(16, "0")}`
}

/** The change without its values, for one that will not fit a request: the key still identifies it. */
function oversized(message: BusMessage): BusMessage {
  const { row: _row, old: _old, ...rest } = message.body as Record<string, unknown>
  return { ...message, body: { ...rest, oversized: true } }
}

/** Every message one version-2 record turns into, under one rule. */
export function recordMessages(
  rule: OutboxRule,
  db: string,
  generation: string,
  txid: bigint,
  postChecksum: bigint,
  timestampUs: bigint,
  logical: Uint8Array,
): { messages: BusMessage[]; truncated: boolean } | null {
  const decoded = decodeLogical(logical)
  if (!decoded) return null
  const messages: BusMessage[] = []
  const committedAt = Number(timestampUs / 1000n)
  // The database's state after this transaction, which is what makes the key name *this* change
  // rather than "whatever was txid N": see `dedupeKeyPrefix`.
  const prefix = dedupeKeyPrefix(db, generation, txid, postChecksum)
  decoded.statements.forEach((changes, seq) => {
    changes.forEach((change, i) => {
      const narrowed = narrowRowChange(change, rule.include)
      messages.push({
        subject: subjectFor(rule.subject, db, change.table),
        key: `${db}.${change.table}`,
        dedupeKey: `${prefix}:${seq}:${i}`,
        body: {
          db,
          table: change.table,
          op: change.op,
          txid: Number(txid),
          seq,
          i,
          rowid: change.rowid,
          ...(narrowed.pk ? { pk: narrowed.pk } : {}),
          ...(narrowed.row ? { row: narrowed.row } : {}),
          ...(narrowed.old ? { old: narrowed.old } : {}),
          committedAt,
          ...(decoded.truncated ? { truncated: true } : {}),
        },
      })
    })
  })
  return { messages, truncated: decoded.truncated }
}

class Tailer {
  readonly db: string
  readonly rule: OutboxRule
  #relay: OutboxRelay
  #publisher: Publisher
  #tenant: Tenant | null = null
  #unsubscribe: (() => void) | null = null
  #generation = "0"
  /** Loaded from the cursor file on first bind; the file is what survives a restart. */
  cursor: bigint | null = null
  /** The newest txid this tailer has seen committed, so a closed tenant knows if it was behind. */
  #known = 0n
  #draining: Promise<void> | null = null
  #again = false
  #armed: ReturnType<typeof setTimeout> | null = null
  #backoffMs = 0
  #closed = false
  /** No cursor file yet (or it was discarded): a log that starts later is not a gap. */
  #fresh = false
  published = 0
  skipped = 0
  gaps = 0
  truncated = 0
  oversized = 0
  errors = 0
  lastError: string | null = null
  lastPublishedAt: number | null = null

  constructor(relay: OutboxRelay, db: string, rule: OutboxRule, publisher: Publisher) {
    this.#relay = relay
    this.db = db
    this.rule = rule
    this.#publisher = publisher
  }

  get bound(): boolean {
    return this.#tenant !== null && !this.#tenant.closed
  }

  get behind(): boolean {
    return this.cursor === null || this.#known > this.cursor
  }

  get lag(): number {
    const cursor = this.cursor ?? 0n
    return this.#known > cursor ? Number(this.#known - cursor) : 0
  }

  bind(tenant: Tenant): void {
    if (this.#tenant === tenant) return
    this.unbind()
    this.#tenant = tenant
    this.#generation = this.#relay.host.generationOf(this.db) ?? "0"
    // Read on every bind: the file is the truth, and a reopened tenant may not be the one this
    // tailer last saw.
    const saved = readCursors(tenant.dir).get(this.rule.name)
    if (!saved) {
      // No cursor yet: a fork or a reset branch starts after its fork point, because the parent's
      // history is not this database's changes and its absence from this log is not a gap.
      this.cursor = this.#relay.host.startOf(this.db)
      this.#fresh = true
    } else if (this.#diverged(tenant, saved.txid, saved.checksum)) {
      // The log reached the cursor's txid by another history. Where the two part is not knowable
      // cheaply, and it does not need to be: republishing everything retained costs nothing on the
      // bus for the shared prefix, whose keys are identical, and publishes the rest.
      this.#relay.host.warn(
        `bql: outbox ${this.db} (${this.rule.name}): the log at txid ${saved.txid} is not the one ` +
          "the cursor was written against; republishing what the log holds",
      )
      this.cursor = this.#relay.host.startOf(this.db)
      this.#fresh = true
    } else {
      this.cursor = saved.txid
      this.#fresh = false
    }
    this.#known = tenant.log.lastTxid
    this.#unsubscribe = tenant.onCommit((event) => {
      if (event.txid > this.#known) this.#known = event.txid
      this.arm()
    })
    this.arm()
  }

  /** True when the log holds `txid` and its checksum there is not the one the cursor recorded. */
  #diverged(tenant: Tenant, txid: bigint, checksum: bigint | null): boolean {
    if (checksum === null || txid === 0n) return false
    try {
      const record = tenant.log.read(txid)
      return record !== null && record.postChecksum !== checksum
    } catch {
      return false
    }
  }

  unbind(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#tenant = null
  }

  /** Schedules a drain on the next tick, coalescing every commit that lands before it. */
  arm(): void {
    if (this.#closed || this.#armed !== null) return
    if (this.#draining) {
      this.#again = true
      return
    }
    this.#armed = setTimeout(() => {
      this.#armed = null
      void this.drain()
    }, this.#backoffMs)
    this.#armed.unref?.()
  }

  drain(): Promise<void> {
    if (this.#draining) {
      this.#again = true
      return this.#draining
    }
    this.#draining = (async () => {
      try {
        do {
          this.#again = false
          await this.#drainOnce()
        } while (this.#again && !this.#closed && this.#backoffMs === 0)
      } finally {
        this.#draining = null
        // A commit that landed mid-drain, or a failure waiting out its backoff.
        if (this.#again) this.arm()
      }
    })()
    return this.#draining
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#armed !== null) clearTimeout(this.#armed)
    this.#armed = null
    await this.#draining
    this.unbind()
  }

  state(): OutboxState {
    return {
      rule: this.rule.name,
      busUrl: this.rule.busUrl,
      subject: this.rule.subject,
      cursor: Number(this.cursor ?? 0n),
      lag: this.lag,
      published: this.published,
      skipped: this.skipped,
      gaps: this.gaps,
      lastError: this.lastError,
      lastPublishedAt: this.lastPublishedAt,
      backoffMs: this.#backoffMs,
    }
  }

  async #drainOnce(): Promise<void> {
    const tenant = this.#tenant
    if (!tenant || tenant.closed || this.#closed) return
    if (!this.#relay.host.authors(tenant)) return
    const log = tenant.log
    const upTo = log.lastTxid
    if (upTo > this.#known) this.#known = upTo
    let cursor = this.cursor ?? 0n
    if (cursor > upTo) {
      // The log is behind the cursor: the database was restored to an earlier point. What the bus
      // already holds stays there; the relay follows the log from where it now ends.
      this.#relay.host.warn(
        `bql: outbox ${this.db} (${this.rule.name}) cursor ${cursor} is ahead of the log's ` +
          `last txid ${upTo}; the database was rewound, resuming from ${upTo}`,
      )
      this.#advance(tenant, upTo, upTo === 0n ? null : (log.read(upTo)?.postChecksum ?? null))
      return
    }
    if (cursor === upTo) return

    // Durable before published (second invariant). The barrier covers every append issued before
    // it, and `upTo` was read before it was issued.
    await log.sweepFlush()
    if (tenant.closed || this.#closed) return

    const first = log.firstTxid
    if (first !== null && cursor + 1n < first && this.#fresh) {
      // The relay never had a position in what is missing — the outbox was turned on after it was
      // retained, or this node was promoted and its log begins at its bootstrap. Not a gap.
      this.#relay.host.warn(
        `bql: outbox ${this.db} (${this.rule.name}) starts at txid ${first}: the log before it was ` +
          "retained away before this relay held a cursor",
      )
      cursor = first - 1n
      this.#advance(tenant, cursor, null)
    } else if (first !== null && cursor + 1n < first) {
      this.gaps++
      this.#relay.totals.gaps++
      this.#relay.host.warn(
        `bql: OUTBOX_GAP ${this.db} (${this.rule.name}): transactions ${cursor + 1n}..${first - 1n} ` +
          `were retained away before they were published; resuming at ${first}. Those changes are ` +
          "not on the bus.",
      )
      cursor = first - 1n
      this.#advance(tenant, cursor, null)
    }

    const batchSize = this.#relay.batchSize
    const maxBytes = this.#relay.maxBatchBytes
    let batch: BusMessage[] = []
    let bytes = 0
    let end = cursor
    let endChecksum: bigint | null = null
    try {
      for (const { txid, bytes: encoded } of log.iterateEncoded(cursor + 1n)) {
        if (txid > upTo) break
        const head = decodeHeader(encoded)
        if (!head || head.header.version < RECORD_VERSION_LOGICAL) {
          // Written before `logicalChanges` was on, or a transaction with no rows to carry.
          this.skipped++
          this.#relay.totals.skipped++
          end = txid
          endChecksum = head ? head.header.postChecksum : null
          continue
        }
        const record = decode(encoded).record
        const out = record.logical
          ? recordMessages(
              this.rule,
              this.db,
              this.#generation,
              txid,
              record.postChecksum,
              record.timestampUs,
              record.logical,
            )
          : null
        if (!out) {
          this.skipped++
          this.#relay.totals.skipped++
          end = txid
          endChecksum = record.postChecksum
          continue
        }
        if (out.truncated) {
          this.truncated++
          this.#relay.totals.truncated++
          this.#relay.host.warn(
            `bql: outbox ${this.db} txid ${txid} exceeded maxRowsPerTxn; ${out.messages.length} ` +
              "changes published, each marked truncated",
          )
        }
        // Whole records where they fit: a batch the record would overflow is sent first, so the
        // cursor never has to say "half of txid N". A record larger than a batch on its own is sent
        // in chunks that do not move the cursor; only the chunk that finishes it does, so a crash
        // mid-record re-sends the record and its dedupe keys absorb the part already sent.
        const sizes = out.messages.map((message) => JSON.stringify(message.body).length)
        const recordBytes = sizes.reduce((a, b) => a + b, 0)
        if (
          batch.length > 0 &&
          (batch.length + out.messages.length > batchSize || bytes + recordBytes > maxBytes)
        ) {
          await this.#publish(tenant, batch, end, endChecksum)
          batch = []
          bytes = 0
          if (tenant.closed || this.#closed) return
        }
        for (let at = 0; at < out.messages.length; at++) {
          let message = out.messages[at] as BusMessage
          let size = sizes[at] as number
          if (size > maxBytes) {
            message = oversized(message)
            size = JSON.stringify(message.body).length
            this.oversized++
            this.#relay.host.warn(
              `bql: outbox ${this.db} txid ${txid}: a ${message.subject} change is larger than ` +
                `${maxBytes} bytes; published with its key only, marked oversized`,
            )
          }
          if (batch.length > 0 && (batch.length >= batchSize || bytes + size > maxBytes)) {
            // Only reachable inside a record bigger than a batch: the batch holds nothing else.
            await this.#publish(tenant, batch, null, null)
            batch = []
            bytes = 0
            if (tenant.closed || this.#closed) return
          }
          batch.push(message)
          bytes += size
        }
        end = txid
        endChecksum = record.postChecksum
        if (batch.length >= batchSize || bytes >= maxBytes) {
          await this.#publish(tenant, batch, end, endChecksum)
          batch = []
          bytes = 0
          if (tenant.closed || this.#closed) return
        }
      }
      if (batch.length > 0) await this.#publish(tenant, batch, end, endChecksum)
      else if (end > (this.cursor ?? 0n)) this.#advance(tenant, end, endChecksum)
      this.#recovered()
    } catch (err) {
      this.#failed(err)
    }
  }

  /** Publishes a batch and, when `end` is given, moves the cursor to it. */
  async #publish(
    tenant: Tenant,
    batch: BusMessage[],
    end: bigint | null,
    checksum: bigint | null,
  ): Promise<void> {
    await this.#publisher.publish(batch)
    this.published += batch.length
    this.#relay.totals.published += batch.length
    this.lastPublishedAt = Date.now()
    if (end !== null) this.#advance(tenant, end, checksum)
  }

  /**
   * Only for the tenant this tailer is bound to, and only while it is open. A reset closes the
   * branch before it moves the directory and renames a fresh one into the same path, so a drain
   * that was awaiting the bus across that swap must not write the old timeline's cursor into the
   * new directory — where it would skip the new timeline's first transactions.
   */
  #advance(tenant: Tenant, txid: bigint, checksum: bigint | null): void {
    if (tenant.closed || tenant !== this.#tenant) {
      throw new Error(`${this.db} was closed under the relay; the cursor was not moved`)
    }
    writeCursor(tenant.dir, this.rule.name, txid, checksum)
    this.cursor = txid
    this.#fresh = false
  }

  #recovered(): void {
    if (this.#backoffMs === 0) return
    this.#backoffMs = 0
    this.lastError = null
    this.#relay.host.warn(`bql: outbox ${this.db} (${this.rule.name}) is publishing again`)
  }

  /** Backs off with full jitter and re-arms; the cursor stays where the last ack left it. */
  #failed(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this.errors++
    this.#relay.totals.errors++
    if (this.lastError !== message) {
      this.#relay.host.warn(
        `bql: outbox ${this.db} (${this.rule.name}) cannot publish to ${this.rule.busUrl}: ${message}; retrying`,
      )
    }
    this.lastError = message
    const ceiling = this.#relay.maxBackoffMs
    const next = Math.min(ceiling, this.#backoffMs === 0 ? 250 : this.#backoffMs * 2)
    this.#backoffMs = Math.max(50, Math.floor(next / 2 + (Math.random() * next) / 2))
    // Re-armed by `drain` once it unwinds, at the backoff.
    this.#again = true
  }
}

export class OutboxRelay {
  readonly host: OutboxHost
  readonly rules: OutboxRule[]
  readonly batchSize: number
  readonly intervalMs: number
  readonly maxBackoffMs: number
  readonly maxBatchBytes: number
  readonly reopenPerSweep: number
  readonly totals = { published: 0, skipped: 0, gaps: 0, truncated: 0, errors: 0 }

  #publishers: Publisher[]
  /** Database name → one tailer per matching rule. */
  #tailers = new Map<string, Tailer[]>()
  /** Databases whose tenant closed, or was never opened, while it may have been behind. */
  #owed = new Set<string>()
  #timer: ReturnType<typeof setInterval> | null = null
  #closed = false

  constructor(host: OutboxHost, options: OutboxRelayOptions) {
    this.host = host
    this.rules = options.rules
    // 1000 is `POST /api/publish/batch`'s ceiling.
    this.batchSize = Math.min(1000, Math.max(1, options.batchSize ?? 256))
    this.intervalMs = options.intervalMs ?? 1000
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000
    this.maxBatchBytes = options.maxBatchBytes ?? 4 * 1024 * 1024
    this.reopenPerSweep = options.reopenPerSweep ?? 16
    // One publisher per rule, shared by every database the rule matches: it is a URL and a token.
    this.#publishers = this.rules.map(
      (rule) =>
        options.publisherFor?.(rule) ??
        httpPublisher({
          url: rule.busUrl,
          token: rule.token,
          ...(rule.workspace ? { workspace: rule.workspace } : {}),
        }),
    )
  }

  /** Whether any rule matches this database. */
  matches(db: string): boolean {
    return this.rules.some((rule) => globMatch(rule.db, db))
  }

  /**
   * Starts the sweep, and marks every matching database in the catalog as owed a pass — so a node
   * that stopped with unpublished records publishes them without waiting for the next write. The
   * catalog's own txid and clean flag rule out the databases that cannot be behind, so a node with
   * ten thousand quiet tenants does not open them all to find that out.
   */
  start(): void {
    if (this.#timer || this.#closed) return
    for (const row of this.host.registry.list()) {
      if (row.role === "replica" || !this.host.owns(row.name) || !this.matches(row.name)) continue
      // A clean close recorded the database's last txid; a cursor at or past it has nothing to do.
      if (row.clean) {
        const cursors = readCursors(tenantDir(this.host.registry.dir, row.name))
        const caughtUp = this.rules.every(
          (rule) => !globMatch(rule.db, row.name) || (cursors.get(rule.name)?.txid ?? -1n) >= row.txid,
        )
        if (caughtUp) continue
      }
      this.#owed.add(row.name)
    }
    this.sweep()
    this.#timer = setInterval(() => this.sweep(), this.intervalMs)
    this.#timer.unref?.()
  }

  /** Called for every tenant the registry opens. */
  attach(tenant: Tenant): void {
    if (this.#closed || tenant.isReplica || !this.host.owns(tenant.name)) return
    if (!this.matches(tenant.name)) return
    let tailers = this.#tailers.get(tenant.name)
    if (!tailers) {
      tailers = []
      this.rules.forEach((rule, index) => {
        if (!globMatch(rule.db, tenant.name)) return
        tailers?.push(new Tailer(this, tenant.name, rule, this.#publishers[index] as Publisher))
      })
      this.#tailers.set(tenant.name, tailers)
    }
    for (const tailer of tailers) tailer.bind(tenant)
    this.#owed.delete(tenant.name)
  }

  /** A deleted database: its tailers stop, and its cursor went to the trash with its directory. */
  async forget(db: string): Promise<void> {
    const tailers = this.#tailers.get(db)
    this.#tailers.delete(db)
    this.#owed.delete(db)
    await Promise.all((tailers ?? []).map((tailer) => tailer.close()))
  }

  /**
   * Unbinds tailers whose tenant closed, remembering the ones still behind, and reopens a bounded
   * number of owed databases. Reopening goes through the registry, whose `onOpen` is `attach`.
   */
  sweep(): void {
    if (this.#closed) return
    for (const [db, tailers] of this.#tailers) {
      for (const tailer of tailers) {
        if (tailer.bound) {
          tailer.arm()
          continue
        }
        tailer.unbind()
        if (tailer.behind) this.#owed.add(db)
      }
    }
    // A tenant opened before the relay existed, or through a registry this relay was not wired to.
    for (const db of this.host.registry.openNames) {
      if (this.#owed.has(db) || !this.matches(db)) continue
      if (this.#tailers.get(db)?.every((tailer) => tailer.bound)) continue
      this.#owed.add(db)
    }
    let budget = this.reopenPerSweep
    for (const db of [...this.#owed]) {
      if (budget-- <= 0) break
      this.#owed.delete(db)
      try {
        // `open` fires the registry's `onOpen`, which is `attach`, which binds and arms a drain.
        this.attach(this.host.registry.open(db))
      } catch {
        // Deleted, or the registry is closing. Either way nothing is owed.
        void this.forget(db)
      }
    }
  }

  /** Drains every bound tailer now and waits. What a test and a shutdown use. */
  async flush(): Promise<void> {
    const all = [...this.#tailers.values()].flat()
    await Promise.all(all.map((tailer) => tailer.drain().catch(() => {})))
  }

  state(db: string): OutboxState[] {
    return (this.#tailers.get(db) ?? []).map((tailer) => tailer.state())
  }

  metrics(): OutboxTotals {
    let behind = 0
    let lagMax = 0
    for (const tailers of this.#tailers.values()) {
      for (const tailer of tailers) {
        const lag = tailer.lag
        if (lag > 0) behind++
        if (lag > lagMax) lagMax = lag
      }
    }
    return { ...this.totals, behind, lagMax }
  }

  /** Stops the sweep and waits for drains in flight. Cursors are on disk; a restart resumes. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await Promise.all([...this.#tailers.values()].flat().map((tailer) => tailer.close()))
  }
}
