import type { StoreDb } from "./storage";

/** Thrown when a committed message names a body whose bytes are gone. */
export class BlobMissingError extends Error {
  constructor(readonly handle: string) {
    super(`blob '${handle}' is missing from blobs_data`);
    this.name = "BlobMissingError";
  }
}

/**
 * Bodies over `inlineMaxBytes`, in `blobs_data` in the bus's own database.
 *
 * WAL shipping carries the database and nothing beside it, so the bytes are a
 * row like any other. The store writes one with `write`, inside the
 * transaction that inserts the message, so the body and the row that names it
 * commit together and a crash leaves no orphan.
 */
export class SqliteBlobStore {
  constructor(private readonly db: StoreDb) {}

  /** Synchronous, for use inside the caller's transaction. */
  write(handle: string, data: string): void {
    this.db.run("INSERT INTO blobs_data (handle, bytes) VALUES (?,?)", [
      handle,
      encoder.encode(data),
    ]);
  }

  async get(handle: string): Promise<string> {
    const row = this.db
      .query("SELECT bytes FROM blobs_data WHERE handle = ?")
      .get(handle) as { bytes: Uint8Array } | null;
    if (!row) throw new BlobMissingError(handle);
    return decoder.decode(row.bytes);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
