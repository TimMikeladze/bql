// Prototype: physical WAL-frame shipping. Primary (bun:sqlite) -> tail -wal bytes -> replica -wal append + shm invalidate -> replica reader sees data.
import { Database } from "bun:sqlite";
import fs from "node:fs";
const dir = import.meta.dir + "/wp"; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
const P = dir + "/primary.db", R = dir + "/replica.db";

// ---- WAL codec ----
function cksum(buf: Uint8Array, off: number, len: number, s: [number, number], le: boolean): [number, number] {
  const dv = new DataView(buf.buffer, buf.byteOffset + off, len);
  let s1 = s[0], s2 = s[1];
  for (let i = 0; i < len; i += 8) {
    s1 = (s1 + dv.getUint32(i, le) + s2) >>> 0;
    s2 = (s2 + dv.getUint32(i + 4, le) + s1) >>> 0;
  }
  return [s1, s2];
}
type WalHdr = { magic: number; le: boolean; pageSize: number; ckptSeq: number; salt1: number; salt2: number; c1: number; c2: number };
function parseHdr(b: Uint8Array): WalHdr {
  const dv = new DataView(b.buffer, b.byteOffset, 32);
  const magic = dv.getUint32(0);
  const h = { magic, le: (magic & 1) === 0, pageSize: dv.getUint32(8), ckptSeq: dv.getUint32(12), salt1: dv.getUint32(16), salt2: dv.getUint32(20), c1: dv.getUint32(24), c2: dv.getUint32(28) };
  const [a, b2] = cksum(b, 0, 24, [0, 0], h.le);
  if (a !== h.c1 || b2 !== h.c2) throw new Error("bad wal header cksum");
  return h;
}
function writeHdr(h: WalHdr): Uint8Array {
  const b = new Uint8Array(32); const dv = new DataView(b.buffer);
  dv.setUint32(0, h.magic); dv.setUint32(4, 3007000); dv.setUint32(8, h.pageSize); dv.setUint32(12, h.ckptSeq); dv.setUint32(16, h.salt1); dv.setUint32(20, h.salt2);
  const [c1, c2] = cksum(b, 0, 24, [0, 0], h.le); dv.setUint32(24, c1); dv.setUint32(28, c2); h.c1 = c1; h.c2 = c2; return b;
}

// ---- Tailer on primary WAL ----
class WalTailer {
  fd: number; hdr!: WalHdr; off = 32; run: [number, number] = [0, 0]; pending: { pgno: number; data: Uint8Array }[] = [];
  constructor(public path: string) { this.fd = fs.openSync(path, "r"); }
  readHeader() { const b = new Uint8Array(32); if (fs.readSync(this.fd, b, 0, 32, 0) < 32) return false; this.hdr = parseHdr(b); this.run = [this.hdr.c1, this.hdr.c2]; this.off = 32; this.pending = []; return true; }
  // returns committed transactions since last call: array of {frames, dbSize}
  poll() {
    if (!this.hdr) { if (!this.readHeader()) return []; }
    else { // detect WAL restart (salt change) -> re-read header
      const b = new Uint8Array(32); fs.readSync(this.fd, b, 0, 32, 0); const h = parseHdr(b);
      if (h.salt1 !== this.hdr.salt1 || h.salt2 !== this.hdr.salt2) { this.hdr = h; this.run = [h.c1, h.c2]; this.off = 32; this.pending = []; }
    }
    const fsz = this.hdr.pageSize + 24, txns: { frames: { pgno: number; data: Uint8Array }[]; dbSize: number }[] = [];
    const size = fs.fstatSync(this.fd).size;
    while (this.off + fsz <= size) {
      const f = new Uint8Array(fsz); fs.readSync(this.fd, f, 0, fsz, this.off);
      const dv = new DataView(f.buffer); const pgno = dv.getUint32(0), commit = dv.getUint32(4);
      if (dv.getUint32(8) !== this.hdr.salt1 || dv.getUint32(12) !== this.hdr.salt2) break; // stale frame from earlier generation
      let c = cksum(f, 0, 8, this.run, this.hdr.le); c = cksum(f, 24, this.hdr.pageSize, c, this.hdr.le);
      if (c[0] !== dv.getUint32(16) || c[1] !== dv.getUint32(20)) break; // torn / not yet valid
      this.run = c; this.off += fsz;
      this.pending.push({ pgno, data: f.subarray(24) });
      if (commit) { txns.push({ frames: this.pending, dbSize: commit }); this.pending = []; }
    }
    return txns;
  }
}

// ---- Applier on replica WAL ----
class WalApplier {
  fd: number; hdr: WalHdr; run: [number, number]; off: number;
  constructor(public dbPath: string, pageSize: number) {
    const wal = dbPath + "-wal"; this.fd = fs.openSync(wal, "a+"); const st = fs.fstatSync(this.fd);
    if (st.size >= 32) { const b = new Uint8Array(32); fs.readSync(this.fd, b, 0, 32, 0); this.hdr = parseHdr(b); this.run = [this.hdr.c1, this.hdr.c2]; this.off = 32;
      // walk existing frames to recover running checksum
      const fsz = pageSize + 24; const f = new Uint8Array(fsz);
      while (this.off + fsz <= st.size) { fs.readSync(this.fd, f, 0, fsz, this.off); const dv = new DataView(f.buffer);
        if (dv.getUint32(8) !== this.hdr.salt1) break; let c = cksum(f, 0, 8, this.run, this.hdr.le); c = cksum(f, 24, pageSize, c, this.hdr.le);
        if (c[0] !== dv.getUint32(16)) break; this.run = c; this.off += fsz; }
      fs.ftruncateSync(this.fd, this.off);
    } else {
      this.hdr = { magic: 0x377f0682, le: true, pageSize, ckptSeq: 0, salt1: (Math.random() * 2 ** 32) >>> 0, salt2: (Math.random() * 2 ** 32) >>> 0, c1: 0, c2: 0 };
      fs.writeSync(this.fd, writeHdr(this.hdr), 0, 32, 0); this.run = [this.hdr.c1, this.hdr.c2]; this.off = 32;
    }
  }
  apply(txn: { frames: { pgno: number; data: Uint8Array }[]; dbSize: number }) {
    const fsz = this.hdr.pageSize + 24; const out = new Uint8Array(fsz * txn.frames.length);
    txn.frames.forEach((fr, i) => { const f = out.subarray(i * fsz, (i + 1) * fsz); const dv = new DataView(f.buffer, f.byteOffset, fsz);
      dv.setUint32(0, fr.pgno); dv.setUint32(4, i === txn.frames.length - 1 ? txn.dbSize : 0); dv.setUint32(8, this.hdr.salt1); dv.setUint32(12, this.hdr.salt2);
      f.set(fr.data, 24); let c = cksum(f, 0, 8, this.run, this.hdr.le); c = cksum(f, 24, this.hdr.pageSize, c, this.hdr.le); dv.setUint32(16, c[0]); dv.setUint32(20, c[1]); this.run = c; });
    fs.writeSync(this.fd, out, 0, out.length, this.off); this.off += out.length; fs.fdatasyncSync(this.fd);
    // invalidate wal-index so next reader rebuilds it from the WAL
    const shm = this.dbPath + "-shm"; if (fs.existsSync(shm)) { const z = new Uint8Array(136); const sfd = fs.openSync(shm, "r+"); fs.writeSync(sfd, z, 0, 136, 0); fs.closeSync(sfd); }
  }
}

// ---- Scenario ----
const p = new Database(P); p.exec("pragma journal_mode=wal; pragma synchronous=normal; pragma wal_autocheckpoint=0;");
p.exec("create table t(id integer primary key, v text, n real)");
p.exec("pragma wal_checkpoint(truncate)"); // start clean: db file complete, wal empty
fs.copyFileSync(P, R); // physical snapshot (page numbers preserved)
const tail = new WalTailer(P + "-wal");
const app = new WalApplier(R, 4096);
const r = new Database(R, { readonly: true }); // replica reader opened BEFORE any apply -> tests shm invalidation on live connection
console.log("replica initial", r.query("select count(*) c from t").get());
const ins = p.query("insert into t(v,n) values (?,?)");
let lagUs: number[] = [];
for (let round = 0; round < 200; round++) {
  const t0 = Bun.nanoseconds();
  p.transaction(() => { for (let i = 0; i < 5; i++) ins.run("r" + round + "-" + i, Math.random()); })();
  const txns = tail.poll();
  for (const tx of txns) app.apply(tx);
  const got = r.query("select count(*) c, max(id) m from t").get() as any;
  lagUs.push((Bun.nanoseconds() - t0) / 1000);
  if (got.c !== (round + 1) * 5) { console.log("MISMATCH at round", round, got, "txns", txns.length); process.exit(1); }
  if (round === 100) { // primary checkpoint+restart mid-stream: WAL salts change, tailer must follow
    p.exec("pragma wal_checkpoint(restart)");
  }
}
console.log("200 rounds OK; wal frames tailed offset", tail.off, "replica wal bytes", app.off);
lagUs.sort((a, b) => a - b);
console.log("write+ship+apply+read latency us: p50", lagUs[100].toFixed(0), "p90", lagUs[180].toFixed(0), "max", lagUs[199].toFixed(0));
console.log("replica rows sample", r.query("select * from t order by id desc limit 2").all());
console.log("primary integrity", p.query("pragma integrity_check").get(), "replica integrity", r.query("pragma integrity_check").get());
// replica-side checkpoint using an RW connection (no writes), then verify still consistent
const rw = new Database(R); console.log("replica checkpoint", rw.query("pragma wal_checkpoint(truncate)").get()); rw.close();
console.log("after replica ckpt", r.query("select count(*) c from t").get());
// continue streaming after replica checkpoint (applier must re-init on truncated wal)
const app2 = new WalApplier(R, 4096);
p.transaction(() => { for (let i = 0; i < 3; i++) ins.run("post", 1); })();
for (const tx of tail.poll()) app2.apply(tx);
console.log("post-ckpt replica count", r.query("select count(*) c from t").get(), "(expect 1003)");
console.log("external sqlite3 CLI view:", Bun.spawnSync(["sqlite3", R, "select count(*) from t"]).stdout.toString().trim());
