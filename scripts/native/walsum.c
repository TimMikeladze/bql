/*
** SQLite's WAL frame checksum, in C, for BunQL's WAL tailer.
**
** Why this file exists: the same loop in JavaScript costs 4.79 µs for a 4 KiB page and is 71% of
** a `WalTailer.poll()`; here it is a few dozen vector loads. Four ways of writing it in JS were
** measured and none of them moved it — `docs/p3-wal-checksum.md` §2.1. Nothing else is in here,
** and nothing here touches SQLite: it is compiled into the same artefact as the amalgamation only
** so that there is one library, one dlopen and one capability check.
**
** Invariant: this is a faithful replacement for `src/wal/codec.ts`, not a fast path with a
** narrower domain. Both checksum word orders are implemented, the frame header is decoded
** big-endian as SQLite writes it, and `test/wal/native.test.ts` holds the two to each other over
** random frames at every alignment.
**
** The chain, from wal.c's walChecksumBytes:
**     s0 += x[i]   + s1
**     s1 += x[i+1] + s0
** over 32-bit words, read in the order the WAL header's magic names. Unsigned overflow wraps,
** which is what the algorithm wants.
*/

#include <stdint.h>
#include <string.h>

/* `native` is 1 when the WAL's checksum words are in the host's own byte order. `n` is a multiple
** of 8: SQLite only ever checksums the 8-byte frame prefix, the 24-byte header prefix, and whole
** pages. The source is read through memcpy rather than a cast, so an unaligned frame buffer is
** defined behaviour rather than merely one that happens to work on this architecture. */
static void bunql_sum(const uint8_t *a, uint32_t n, int native, uint32_t *s0io, uint32_t *s1io) {
  uint32_t s0 = *s0io;
  uint32_t s1 = *s1io;
  uint32_t w0, w1;
  uint32_t i;
  if (native) {
    for (i = 0; i + 8 <= n; i += 8) {
      memcpy(&w0, a + i, 4);
      memcpy(&w1, a + i + 4, 4);
      s0 += w0 + s1;
      s1 += w1 + s0;
    }
  } else {
    for (i = 0; i + 8 <= n; i += 8) {
      memcpy(&w0, a + i, 4);
      memcpy(&w1, a + i + 4, 4);
      s0 += __builtin_bswap32(w0) + s1;
      s1 += __builtin_bswap32(w1) + s0;
    }
  }
  *s0io = s0;
  *s1io = s1;
}

/* Continues the chain over `n` bytes. io[0] and io[1] are the chain, in and out. */
void bunql_wal_checksum(const uint8_t *a, uint32_t n, int native, uint32_t *io) {
  bunql_sum(a, n, native, &io[0], &io[1]);
}

/* One whole frame: salts, page number, and the chain continued over the 8-byte prefix and then
** the page — exactly `checkFrame` in src/wal/codec.ts.
**
**   out[0] = 1 when the frame verifies, 0 otherwise
**   out[1] = page number          out[2] = commit size (0 when the frame does not commit)
**   out[3] = s0                   out[4] = s1          (the chain after this frame)
**
** On an invalid frame the chain is returned unadvanced, as the JavaScript does, so a caller that
** ignores `out[0]` cannot silently walk past a torn tail. */
void bunql_wal_check_frame(const uint8_t *frame, uint32_t pageSize, uint32_t salt1, uint32_t salt2,
                           uint32_t s0, uint32_t s1, int native, uint32_t *out) {
  /* Every field of a frame header is big-endian, whatever the checksum word order is. */
  uint32_t pgno = ((uint32_t)frame[0] << 24) | ((uint32_t)frame[1] << 16) |
                  ((uint32_t)frame[2] << 8) | (uint32_t)frame[3];
  uint32_t csize = ((uint32_t)frame[4] << 24) | ((uint32_t)frame[5] << 16) |
                   ((uint32_t)frame[6] << 8) | (uint32_t)frame[7];
  uint32_t fsalt1 = ((uint32_t)frame[8] << 24) | ((uint32_t)frame[9] << 16) |
                    ((uint32_t)frame[10] << 8) | (uint32_t)frame[11];
  uint32_t fsalt2 = ((uint32_t)frame[12] << 24) | ((uint32_t)frame[13] << 16) |
                    ((uint32_t)frame[14] << 8) | (uint32_t)frame[15];
  uint32_t c0 = ((uint32_t)frame[16] << 24) | ((uint32_t)frame[17] << 16) |
                ((uint32_t)frame[18] << 8) | (uint32_t)frame[19];
  uint32_t c1 = ((uint32_t)frame[20] << 24) | ((uint32_t)frame[21] << 16) |
                ((uint32_t)frame[22] << 8) | (uint32_t)frame[23];

  out[1] = pgno;
  out[2] = csize;
  if (fsalt1 != salt1 || fsalt2 != salt2 || pgno == 0) {
    out[0] = 0;
    out[3] = s0;
    out[4] = s1;
    return;
  }
  bunql_sum(frame, 8, native, &s0, &s1);
  bunql_sum(frame + 24, pageSize, native, &s0, &s1);
  out[0] = (c0 == s0 && c1 == s1) ? 1u : 0u;
  out[3] = s0;
  out[4] = s1;
}
