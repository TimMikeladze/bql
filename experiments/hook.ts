// Crux test: bun:sqlite for queries + bun:ffi for hooks, glued by sqlite3_auto_extension.
import { dlopen, FFIType, JSCallback, CString, ptr } from "bun:ffi";
const LIB = process.argv[2] ?? "/usr/lib/libsqlite3.dylib";
const custom = process.argv[3] === "custom";
const { Database } = await import("bun:sqlite");
if (custom) Database.setCustomSQLite(LIB);

const lib = dlopen(LIB, {
  sqlite3_auto_extension: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_libversion: { args: [], returns: FFIType.cstring },
  sqlite3_db_filename: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.cstring },
  sqlite3_wal_hook: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  sqlite3_update_hook: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  sqlite3_commit_hook: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  sqlite3_set_authorizer: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sqlite3_progress_handler: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  sqlite3_limit: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
console.log("ffi libversion", lib.symbols.sqlite3_libversion());

let captured: bigint | number | null = null;
const entry = new JSCallback((db: number, _err: number, _api: number) => { captured = db; return 0; },
  { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
console.log("auto_extension rc", lib.symbols.sqlite3_auto_extension(entry.ptr));

const path = `${import.meta.dir}/hook-${custom ? "custom" : "sys"}.db`;
for (const f of [path, path + "-wal", path + "-shm"]) try { require("fs").unlinkSync(f) } catch {}
const db = new Database(path);
console.log("captured sqlite3* =", captured, "bun:sqlite version", db.query("select sqlite_version() v").get());
if (!captured) { console.log("FAIL: no pointer"); process.exit(1); }
const dbp = captured as number;
console.log("db_filename via ffi:", lib.symbols.sqlite3_db_filename(dbp, Buffer.from("main\0")).toString());

const walEvents: any[] = [];
const walCb = new JSCallback((_arg: number, _db: number, name: number, nFrames: number) => {
  walEvents.push({ name: new CString(name).toString(), nFrames }); return 0;
}, { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 });
const updEvents: any[] = [];
const updCb = new JSCallback((_arg: number, op: number, dbn: number, tbl: number, rowid: bigint) => {
  updEvents.push({ op, db: new CString(dbn).toString(), table: new CString(tbl).toString(), rowid });
}, { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.void });
const commits: number[] = [];
const commitCb = new JSCallback(() => { commits.push(Date.now()); return 0; }, { args: [FFIType.ptr], returns: FFIType.i32 });
const authEvents: any[] = [];
const authCb = new JSCallback((_a: number, code: number, s1: number, s2: number, s3: number, s4: number) => {
  authEvents.push([code, s1 ? new CString(s1).toString() : null, s2 ? new CString(s2).toString() : null]); return 0;
}, { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });

db.exec("pragma journal_mode=wal");
lib.symbols.sqlite3_wal_hook(dbp, walCb.ptr, null);
lib.symbols.sqlite3_update_hook(dbp, updCb.ptr, null);
lib.symbols.sqlite3_commit_hook(dbp, commitCb.ptr, null);
lib.symbols.sqlite3_set_authorizer(dbp, authCb.ptr, null);
db.exec("create table t(id integer primary key, v text)");
const ins = db.query("insert into t(v) values (?)");
db.transaction(() => { ins.run("a"); ins.run("b"); })();
ins.run("c");
db.query("update t set v='z' where id=1").run();
console.log("rows", db.query("select * from t").all());
console.log("wal hook events", walEvents);
console.log("update hook events", updEvents);
console.log("commit hook count", commits.length);
console.log("authorizer sample", authEvents.slice(0, 6), "total", authEvents.length);
// progress handler: cancel a long query
let ticks = 0;
const prog = new JSCallback(() => { ticks++; return ticks > 50 ? 1 : 0; }, { args: [FFIType.ptr], returns: FFIType.i32 });
lib.symbols.sqlite3_progress_handler(dbp, 1000, prog.ptr, null);
try { db.query("with recursive c(x) as (select 1 union all select x+1 from c limit 50000000) select count(*) from c").get(); console.log("NOT interrupted"); }
catch (e: any) { console.log("progress interrupt ->", e.message, "ticks", ticks); }
lib.symbols.sqlite3_progress_handler(dbp, 0, null, null);
console.log("limit SQLITE_LIMIT_LENGTH(0) was", lib.symbols.sqlite3_limit(dbp, 0, 1024));
db.close();
console.log("OK");
