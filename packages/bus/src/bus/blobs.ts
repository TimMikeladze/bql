import { open, mkdir, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fault } from "./faults";

/**
 * Overflow storage for message bodies too large to sit in a SQLite row.
 *
 * A seam rather than a feature: the bus keeps rows small, and where the bytes
 * actually live is the host's decision.
 */
export interface BlobStore {
  /** Store `data` under a caller-chosen key; returns an opaque handle. */
  put(key: string, data: string): Promise<string>;
  get(handle: string): Promise<string>;
  /** Whether the bytes are actually there. The reverse of the orphan sweep. */
  has(handle: string): Promise<boolean>;
  delete(handle: string): Promise<void>;
}

/** Thrown when a committed message names a blob whose bytes are gone. */
export class BlobMissingError extends Error {
  constructor(readonly handle: string) {
    super(`blob '${handle}' is missing from the blob store`);
    this.name = "BlobMissingError";
  }
}

/**
 * Filesystem-backed blobs, one file per handle.
 *
 * The write is durable and atomic, in that order and for two different
 * reasons. `Bun.write` alone returns once the bytes are in the page cache, so a
 * crash a moment later leaves a committed message row pointing at a file that
 * is missing or — worse, because nothing detects it — half written. So: write a
 * temporary file, `fsync` it, `rename` it into place (atomic within a
 * filesystem), then `fsync` the *directory*, because the rename itself is
 * metadata and is no more durable than the data was.
 *
 * Ordering is already right at the call site — the blob is written before the
 * row that names it commits — so a crash costs an orphaned file, which the
 * sweep collects, rather than a hole.
 */
export function fileBlobs(directory: string): BlobStore {
  const root = resolve(directory);
  const path = (handle: string) => {
    // A handle is chosen by the store (a UUID), but never trust it into a path.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(handle))
      throw new Error(`invalid blob handle '${handle}'`);
    return `${root}/${handle}.json`;
  };
  /**
   * Flush a directory entry. Not every filesystem supports it and none of them
   * agree on the error, so a failure is not fatal: the data fsync above is the
   * part that cannot be skipped.
   */
  const syncDirectory = async () => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(root, "r");
      await handle.sync();
    } catch {
    } finally {
      await handle?.close().catch(() => {});
    }
  };
  return {
    async put(key, data) {
      const target = path(key);
      const temporary = `${target}.tmp`;
      await mkdir(root, { recursive: true });
      const file = await open(temporary, "w");
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
      await syncDirectory();
      fault("blob-write");
      return key;
    },
    async get(handle) {
      const file = Bun.file(path(handle));
      if (!(await file.exists())) throw new BlobMissingError(handle);
      return file.text();
    },
    async has(handle) {
      return Bun.file(path(handle)).exists();
    },
    async delete(handle) {
      await unlink(path(handle)).catch(() => {});
    },
  };
}
