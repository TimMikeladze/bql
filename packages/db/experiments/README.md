# experiments — the evidence behind docs/design.md

All scripts are standalone. Run with `bun <file>`. macOS needs Homebrew SQLite for the FFI ones
(`brew install sqlite`; override the path with `BQL_SQLITE_LIB=...`).

| file | proves | how |
|---|---|---|
| `walproto.ts` | physical WAL-frame shipping in userland: tail primary `-wal`, re-salt + re-checksum into replica `-wal`, invalidate `-shm`, replica reader sees every txn; survives primary WAL restart and replica checkpoint | `bun walproto.ts` |
| `hook.ts` | raw `sqlite3*` of a bun:sqlite connection captured via `sqlite3_auto_extension` over bun:ffi; `wal_hook`, `update_hook`, `commit_hook`, authorizer, progress-handler cancellation, `sqlite3_limit` all work | `bun hook.ts /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib custom` (system lib fails: Apple builds with `OMIT_LOAD_EXTENSION`) |
| `session.ts` | session extension changeset generated on a bun:sqlite writer and applied to another db via FFI | `bun session.ts` |
| `bql_native.c` + `exttest.ts` | Linux route: a 30-line loadable extension leaks the connection handle and `sqlite3_api_routines` pointers from Bun's *bundled* SQLite; hooks + cancellation work without any external libsqlite3 | `cc -O2 -shared -fPIC -I/opt/homebrew/opt/sqlite/include -o bql_native.dylib bql_native.c && bun exttest.ts ./bql_native.dylib` (Linux: `gcc ... -o bql_native.so`, needs `libsqlite3-dev` headers only) |
| `ffibench.ts` | pure bun:ffi driver: 0.8 µs point reads vs 1.75 µs bun:sqlite; 50 ns/row hook overhead | `bun ffibench.ts` |
| `bench.ts` | bun:sqlite + Bun.serve + WebSocket latency floor on this machine | `bun bench.ts` |
| `misc.ts` | reflink snapshot speed (`Bun.write`, `COPYFILE_FICLONE`), zstd/xxh3 on pages, shm invalidation with an external reader holding a read txn | `bun misc.ts` (after `walproto.ts`) |

Linux verification was done in `oven/bun:1.4` (Bun 1.4.2, SQLite 3.53.2):
`docker run --rm -v "$PWD":/t oven/bun:1.4 bun /t/walproto.ts`.
