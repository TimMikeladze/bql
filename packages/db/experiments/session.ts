// Session extension via FFI on the bun:sqlite writer connection: row-level changesets (logical tier)
import { dlopen, FFIType, JSCallback, ptr, toArrayBuffer, read } from "bun:ffi";
import { Database } from "bun:sqlite";
const LIB = process.env.BUNQL_SQLITE_LIB ?? "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
Database.setCustomSQLite(LIB);
const lib = dlopen(LIB, {
  sqlite3_auto_extension: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3session_create: { args: [FFIType.ptr, FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
  sqlite3session_attach: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sqlite3session_changeset: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sqlite3session_patchset: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sqlite3session_delete: { args: [FFIType.ptr], returns: FFIType.void },
  sqlite3changeset_apply: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sqlite3_free: { args: [FFIType.ptr], returns: FFIType.void },
  sqlite3_preupdate_hook: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  sqlite3_preupdate_count: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_preupdate_new: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  sqlite3_value_text: { args: [FFIType.ptr], returns: FFIType.cstring },
  sqlite3_value_type: { args: [FFIType.ptr], returns: FFIType.i32 },
});
const handles: number[] = [];
const entry = new JSCallback((db: number) => { handles.push(db); return 0; }, { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
lib.symbols.sqlite3_auto_extension(entry.ptr);
const a = new Database(":memory:"), b = new Database(":memory:");
const [pa, pb] = handles;
for (const d of [a, b]) d.exec("create table users(id integer primary key, name text, age int)");
// preupdate hook: see NEW values before write (rich CDC without triggers)
const pre: any[] = [];
const preCb = new JSCallback((_c: number, db: number, op: number, dbn: number, tbl: number, k1: bigint, k2: bigint) => {
  const n = lib.symbols.sqlite3_preupdate_count(db); const vals: any[] = [];
  const out = new BigUint64Array(1);
  for (let i = 0; i < n; i++) { if (op !== 9) { lib.symbols.sqlite3_preupdate_new(db, i, ptr(out)); const v = Number(out[0]); vals.push(v ? lib.symbols.sqlite3_value_text(v)?.toString() : null); } }
  pre.push({ op, rowid: k1, newRowid: k2, vals });
}, { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.i64], returns: FFIType.void });
lib.symbols.sqlite3_preupdate_hook(pa, preCb.ptr, null);
// session on A
const sess = new BigUint64Array(1);
console.log("session_create", lib.symbols.sqlite3session_create(pa, Buffer.from("main\0"), ptr(sess)));
console.log("session_attach(all)", lib.symbols.sqlite3session_attach(Number(sess[0]), null));
a.transaction(() => { a.run("insert into users(name,age) values ('ann',30),('bob',41)"); a.run("update users set age=31 where name='ann'"); })();
const n = new Int32Array(1), pp = new BigUint64Array(1);
console.log("changeset rc", lib.symbols.sqlite3session_changeset(Number(sess[0]), ptr(n), ptr(pp)), "bytes", n[0]);
const cs = new Uint8Array(toArrayBuffer(Number(pp[0]), 0, n[0])).slice();
lib.symbols.sqlite3_free(Number(pp[0]));
console.log("preupdate events", pre);
// apply to B
console.log("apply rc", lib.symbols.sqlite3changeset_apply(pb, cs.length, ptr(cs), null, null, null));
console.log("B rows", b.query("select * from users").all());
