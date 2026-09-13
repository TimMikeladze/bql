import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

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
  delete(handle: string): Promise<void>;
}

/** Filesystem-backed blobs, one file per handle. */
export function fileBlobs(directory: string): BlobStore {
  const root = resolve(directory);
  const path = (handle: string) => {
    // A handle is chosen by the store (a UUID), but never trust it into a path.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(handle))
      throw new Error(`invalid blob handle '${handle}'`);
    return `${root}/${handle}.json`;
  };
  return {
    async put(key, data) {
      await mkdir(root, { recursive: true });
      await Bun.write(path(key), data);
      return key;
    },
    async get(handle) {
      return Bun.file(path(handle)).text();
    },
    async delete(handle) {
      await Bun.file(path(handle))
        .delete()
        .catch(() => {});
    },
  };
}
