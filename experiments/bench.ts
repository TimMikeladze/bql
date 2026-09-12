import { Database } from "bun:sqlite";
import fs from "node:fs";
const f = import.meta.dir + "/bench.db"; for (const x of [f, f+"-wal", f+"-shm"]) try { fs.unlinkSync(x) } catch {}
const db = new Database(f); db.exec("pragma journal_mode=wal; pragma synchronous=normal;");
db.exec("create table kv(k integer primary key, v text)");
const ins = db.query("insert into kv(k,v) values (?,?)"); const get = db.query("select v from kv where k=?");
db.transaction(() => { for (let i = 0; i < 100000; i++) ins.run(i, "value-" + i); })();
function bench(name: string, n: number, fn: (i: number) => void) { const t = Bun.nanoseconds(); for (let i = 0; i < n; i++) fn(i); const us = (Bun.nanoseconds() - t) / 1000 / n; console.log(name.padEnd(46), us.toFixed(2), "us/op"); }
bench("point read .get()", 200000, i => get.get(i % 100000));
bench("point read .values()", 200000, i => get.values(i % 100000));
bench("single-row insert (own txn, sync=normal)", 5000, i => ins.run(100000 + i, "x"));
db.exec("pragma synchronous=full");
bench("single-row insert (own txn, sync=full)", 2000, i => ins.run(200000 + i, "x"));
db.exec("pragma synchronous=normal");
const upd = db.query("update kv set v=? where k=?");
bench("update 1 row (own txn)", 5000, i => upd.run("y", i));
bench("open+close Database(file)", 2000, () => new Database(f).close());
bench("open+close Database(file, readonly)", 2000, () => new Database(f, { readonly: true }).close());
bench("prepare (uncached) simple select", 20000, () => db.prepare("select 1").finalize());
bench("query() cached lookup", 200000, () => db.query("select 1"));
// HTTP + WS roundtrip
const srv = Bun.serve({ port: 0, routes: { "/q/:id": (req) => Response.json(get.get(Number(req.params.id))) }, websocket: { message(ws, m) { ws.send(JSON.stringify(get.get(Number(m)))); } }, fetch(req, s) { if (s.upgrade(req)) return; return new Response("nf", { status: 404 }); } });
const url = `http://localhost:${srv.port}`;
let t = Bun.nanoseconds(); const N = 5000; for (let i = 0; i < N; i++) await (await fetch(`${url}/q/${i}`)).json();
console.log("HTTP keepalive roundtrip (serial, same proc)".padEnd(46), ((Bun.nanoseconds() - t) / 1000 / N).toFixed(1), "us/op");
t = Bun.nanoseconds(); await Promise.all(Array.from({ length: 2000 }, (_, i) => fetch(`${url}/q/${i}`).then(r => r.json())));
console.log("HTTP 2000 concurrent fetches total ms".padEnd(46), ((Bun.nanoseconds() - t) / 1e6).toFixed(1));
const ws = new WebSocket(`ws://localhost:${srv.port}`); await new Promise(r => ws.onopen = r);
t = Bun.nanoseconds(); for (let i = 0; i < N; i++) { const p = new Promise(r => ws.onmessage = r); ws.send(String(i)); await p; }
console.log("WS roundtrip (serial, same proc)".padEnd(46), ((Bun.nanoseconds() - t) / 1000 / N).toFixed(1), "us/op");
ws.close(); srv.stop(true); db.close();
