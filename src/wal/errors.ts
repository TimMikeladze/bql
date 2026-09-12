// Invariant: every way a replication stream can diverge has its own named error. A caller that
// catches `WalError` has caught all of them; a caller that catches `ChecksumMismatch` knows the
// replica needs a fresh snapshot rather than a retry.

export class WalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** The WAL, a segment, or a record does not parse as the format it claims to be. */
export class WalFormatError extends WalError {}

/**
 * A record was applied out of order: `record.prevTxid` is not the replica's current txid. Retry
 * from `expected` rather than re-snapshotting.
 */
export class PositionMismatch extends WalError {
  readonly expected: bigint
  readonly received: bigint

  constructor(expected: bigint, received: bigint) {
    super(`transaction record expects prevTxid ${received}, replica is at ${expected}`)
    this.expected = expected
    this.received = received
  }
}

/**
 * The rolling database checksum does not match what the record says it should be. This is
 * divergence — split brain or bit rot — and the replica must re-bootstrap from a snapshot. It is
 * raised before anything is written, so the replica is left exactly as it was.
 */
export class ChecksumMismatch extends WalError {
  readonly txid: bigint
  readonly expected: bigint
  readonly actual: bigint
  /** Which checksum disagreed: the state before the transaction, or after it. */
  readonly phase: "pre" | "post"

  constructor(txid: bigint, phase: "pre" | "post", expected: bigint, actual: bigint) {
    super(
      `${phase}-transaction checksum mismatch at txid ${txid}: expected ${expected.toString(16)}, computed ${actual.toString(16)}`,
    )
    this.txid = txid
    this.phase = phase
    this.expected = expected
    this.actual = actual
  }
}

/**
 * A record carries an older leadership term than the replica has already seen. Applying it would
 * accept writes from a deposed primary.
 */
export class EpochRegression extends WalError {
  readonly localEpoch: number
  readonly recordEpoch: number

  constructor(localEpoch: number, recordEpoch: number) {
    super(`record epoch ${recordEpoch} is behind the replica's epoch ${localEpoch}`)
    this.localEpoch = localEpoch
    this.recordEpoch = recordEpoch
  }
}

/** The requested txid is no longer in the log, and the caller needs a snapshot. */
export class LogGap extends WalError {
  readonly requested: bigint
  readonly earliest: bigint | null

  constructor(requested: bigint, earliest: bigint | null) {
    super(
      earliest === null
        ? `txid ${requested} is not in the log, which is empty`
        : `txid ${requested} has been retained away; the log starts at ${earliest}`,
    )
    this.requested = requested
    this.earliest = earliest
  }
}
