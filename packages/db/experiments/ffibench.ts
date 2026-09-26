// Is a pure bun:ffi SQLite driver competitive with bun:sqlite? Point reads + inserts.
import { dlopen, FFIType, ptr, CString, toArrayBuffer, JSCallback, read } from "bun:ffi";
import { Database } from "bun:sqlite";
import fs from "node:fs";
const LIB = process.env.BQL_SQLITE_LIB ?? "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
const L = dlopen(LIB, {
  sqlite3_open_v2: { args: [FFIType.cstring, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  sqlite3_prepare_v3: { args: [FFIType.ptr, FFIType.cstring, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sqlite3_step: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_reset: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_bind_int64: { args: [FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i32 },
  sqlite3_bind_text: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  sqlite3_column_count: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_column_type: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  sqlite3_column_int64: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
  sqlite3_column_text: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
  sqlite3_column_bytes: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  sqlite3_exec: { args: [FFIType.ptr, FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sqlite3_update_hook: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
});
const f = import.meta.dir + "/ffib.db"; for (const x of [f, f + "-wal", f + "-shm"]) try { fs.unlinkSync(x) } catch {}
const out = new BigUint64Array(1);
L.symbols.sqlite3_open_v2(Buffer.from(f + "\0"), ptr(out), 6, null); const db = Number(out[0]);
const exec = (s: string) => L.symbols.sqlite3_exec(db, Buffer.from(s + "\0"), null, null, null);
exec("pragma journal_mode=wal; pragma synchronous=normal; create table kv(k integer primary key, v text)");
const prep = (s: string) => { L.symbols.sqlite3_prepare_v3(db, Buffer.from(s + "\0"), -1, 1, ptr(out), null); return Number(out[0]); };
const ins = prep("insert into kv(k,v) values (?,?)"), get = prep("select v from kv where k=?");
const dec = new TextDecoder();
const val = Buffer.from("value-xxxxxxx");
exec("begin"); for (let i = 0; i < 100000; i++) { L.symbols.sqlite3_bind_int64(ins, 1, BigInt(i)); L.symbols.sqlite3_bind_text(ins, 2, val, val.length, null); L.symbols.sqlite3_step(ins); L.symbols.sqlite3_reset(ins); } exec("commit");
function bench(name: string, n: number, fn: (i: number) => void) { const t = Bun.nanoseconds(); for (let i = 0; i < n; i++) fn(i); console.log(name.padEnd(40), ((Bun.nanoseconds() - t) / 1000 / n).toFixed(2), "us/op"); }
bench("FFI point read -> {v:string}", 200000, i => {
  L.symbols.sqlite3_bind_int64(get, 1, BigInt(i % 100000)); L.symbols.sqlite3_step(get);
  const p = L.symbols.sqlite3_column_text(get, 0), n = L.symbols.sqlite3_column_bytes(get, 0);
  const s = dec.decode(new Uint8Array(toArrayBuffer(p, 0, n))); L.symbols.sqlite3_reset(get); return { v: s };
});
bench("FFI point read (CString)", 200000, i => {
  L.symbols.sqlite3_bind_int64(get, 1, BigInt(i % 100000)); L.symbols.sqlite3_step(get);
  const s = new CString(L.symbols.sqlite3_column_text(get, 0)).toString(); L.symbols.sqlite3_reset(get); return { v: s };
});
bench("FFI single-row insert (autocommit)", 5000, i => { L.symbols.sqlite3_bind_int64(ins, 1, BigInt(100000 + i)); L.symbols.sqlite3_bind_text(ins, 2, val, val.length, null); L.symbols.sqlite3_step(ins); L.symbols.sqlite3_reset(ins); });
// JSCallback overhead: update_hook per row during bulk insert
let cnt = 0; const cb = new JSCallback(() => { cnt++; }, { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.void });
exec("begin"); bench("FFI insert in txn WITHOUT update_hook", 100000, i => { L.symbols.sqlite3_bind_int64(ins, 1, BigInt(300000 + i)); L.symbols.sqlite3_bind_text(ins, 2, val, val.length, null); L.symbols.sqlite3_step(ins); L.symbols.sqlite3_reset(ins); }); exec("commit");
L.symbols.sqlite3_update_hook(db, cb.ptr, null);
exec("begin"); bench("FFI insert in txn WITH update_hook(JS)", 100000, i => { L.symbols.sqlite3_bind_int64(ins, 1, BigInt(500000 + i)); L.symbols.sqlite3_bind_text(ins, 2, val, val.length, null); L.symbols.sqlite3_step(ins); L.symbols.sqlite3_reset(ins); }); exec("commit");
console.log("hook calls", cnt);
// compare: bun:sqlite same file
const b = new Database(f); const g = b.query("select v from kv where k=?");
bench("bun:sqlite point read .get()", 200000, i => g.get(i % 100000));
