// powerboat JS environment, part 10: URLSearchParams and the slice of IndexedDB that
// Construct's storage (KVStorageContainer, the LocalStorage plugin, save slots) uses.
// One JSON file per database in the save folder (<game>/save/indexeddb-<name>.json), written
// atomically (temp file + rename) a task after a write transaction completes, and at exit.
// Values are kept in a tagged JSON encoding, which also serves as the structured clone.
"use strict";
(() => {
  // Construct exports (main.rs sets POWERBOAT_CONSTRUCT=1 from index.html) and RPG Maker MZ (POWERBOAT_MZ=1: its browser
  // check needs window.indexedDB); MV games never see this layer.
  if (Deno.core.ops.op_powerboat_env("POWERBOAT_CONSTRUCT") !== "1" && Deno.core.ops.op_powerboat_env("POWERBOAT_MZ") !== "1") return;
  const ops = Deno.core.ops;
  const g = globalThis;

  class URLSearchParams {
    constructor(init = "") {
      this._list = [];
      if (typeof init === "string") {
        const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (_) { return s; } };
        for (const part of init.replace(/^\?/, "").split("&")) {
          if (!part) continue;
          const i = part.indexOf("=");
          this._list.push(i < 0 ? [dec(part), ""] : [dec(part.slice(0, i)), dec(part.slice(i + 1))]);
        }
      } else if (init && typeof init === "object") {
        for (const [k, v] of (Symbol.iterator in init ? init : Object.entries(init))) this._list.push([String(k), String(v)]);
      }
    }
    get(k) { const e = this._list.find((x) => x[0] === k); return e ? e[1] : null; }
    getAll(k) { return this._list.filter((x) => x[0] === k).map((x) => x[1]); }
    has(k) { return this._list.some((x) => x[0] === k); }
    set(k, v) { this.delete(k); this._list.push([String(k), String(v)]); }
    append(k, v) { this._list.push([String(k), String(v)]); }
    delete(k) { this._list = this._list.filter((x) => x[0] !== k); }
    forEach(f) { for (const [k, v] of this._list) f(v, k, this); }
    keys() { return this._list.map((x) => x[0])[Symbol.iterator](); }
    values() { return this._list.map((x) => x[1])[Symbol.iterator](); }
    entries() { return this._list.map((x) => [x[0], x[1]])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toString() { return this._list.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&"); }
  }
  g.URLSearchParams = URLSearchParams;

  // ---- value encoding ------------------------------------------------------------------------------
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const toB64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 3) {
      const n = (u8[i] << 16) | ((u8[i + 1] || 0) << 8) | (u8[i + 2] || 0);
      s += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (i + 1 < u8.length ? B64[n >> 6 & 63] : "=") + (i + 2 < u8.length ? B64[n & 63] : "=");
    }
    return s;
  };
  const fromB64 = (s) => {
    const clean = s.replace(/=+$/, "");
    const out = new Uint8Array((clean.length * 3) >> 2);
    let o = 0, acc = 0, bits = 0;
    for (const ch of clean) { acc = (acc << 6) | B64.indexOf(ch); bits += 6; if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; } }
    return out;
  };
  const enc = (v) => {
    if (v === undefined) return { $t: "u" };
    if (v === null || typeof v !== "object") return typeof v === "number" && !isFinite(v) ? { $t: "n", v: String(v) } : v;
    if (v instanceof ArrayBuffer) return { $t: "ab", b: toB64(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) return { $t: "ta", c: v.constructor.name, b: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (v instanceof g.Blob) return { $t: "blob", type: v.type, b: toB64(v._bytes) };
    if (v instanceof Date) return { $t: "date", v: v.getTime() };
    if (v instanceof Map) return { $t: "map", v: [...v].map(([a, b]) => [enc(a), enc(b)]) };
    if (v instanceof Set) return { $t: "set", v: [...v].map(enc) };
    if (Array.isArray(v)) return v.map(enc);
    const o = {};
    for (const k of Object.keys(v)) o[k] = enc(v[k]);
    return o.$t !== undefined ? { $t: "obj", v: o } : o;
  };
  const dec = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(dec);
    switch (v.$t) {
      case undefined: break;
      case "u": return undefined;
      case "n": return Number(v.v);
      case "ab": return fromB64(v.b).buffer;
      case "ta": { const u = fromB64(v.b); const C = g[v.c] || Uint8Array; return new C(u.buffer, 0, u.byteLength / (C.BYTES_PER_ELEMENT || 1)); }
      case "blob": return new g.Blob([fromB64(v.b)], { type: v.type });
      case "date": return new Date(v.v);
      case "map": return new Map(v.v.map(([a, b]) => [dec(a), dec(b)]));
      case "set": return new Set(v.v.map(dec));
      case "obj": { const o = {}; for (const k of Object.keys(v.v)) o[k] = dec(v.v[k]); return o; }
    }
    const o = {};
    for (const k of Object.keys(v)) o[k] = dec(v[k]);
    return o;
  };

  // ---- databases on disk -------------------------------------------------------------------------
  const cmpKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const dbFiles = new Map(); // name -> { version, stores: Map<store, Map<key, encoded value>>, timer }
  const dbPath = (name) => __powerboat.dataDir + "/indexeddb-" + encodeURIComponent(name) + ".json";
  const loadDb = (name) => {
    let d = dbFiles.get(name);
    if (d) return d;
    d = { version: 0, stores: new Map(), timer: 0 };
    const p = dbPath(name);
    if (ops.op_powerboat_exists(p)) {
      try {
        const j = JSON.parse(__powerboat.readText(p));
        d.version = j.version | 0;
        for (const [s, entries] of Object.entries(j.stores || {})) d.stores.set(s, new Map(entries));
      } catch (e) { console.warn("powerboat: IndexedDB file " + p + " unreadable: " + e); }
    }
    dbFiles.set(name, d);
    return d;
  };
  const flushDb = (name) => {
    const d = dbFiles.get(name);
    if (!d) return;
    if (d.timer) { clearTimeout(d.timer); d.timer = 0; }
    const j = { version: d.version, stores: {} };
    for (const [s, m] of d.stores) j.stores[s] = [...m];
    const p = dbPath(name);
    let err = ops.op_powerboat_mkdirs(__powerboat.dataDir);
    if (!err) err = ops.op_powerboat_write_text(p + ".tmp", JSON.stringify(j));
    if (!err) err = ops.op_powerboat_rename(p + ".tmp", p);
    if (err) console.error("powerboat: IndexedDB write failed: " + err);
  };
  const dirtyDb = (name) => { const d = dbFiles.get(name); if (d && !d.timer) d.timer = setTimeout(() => flushDb(name), 0); };
  const baseFlush = __powerboat.flushStorage;
  __powerboat.flushStorage = () => { if (baseFlush) baseFlush(); for (const [name, d] of dbFiles) if (d.timer) flushDb(name); };

  // ---- the API -----------------------------------------------------------------------------------
  const fire = (target, type, extra) => {
    const e = new Event(type);
    Object.defineProperty(e, "target", { value: target, configurable: true });
    if (extra) Object.assign(e, extra);
    target.dispatchEvent(e);
  };
  class IDBRequest extends EventTarget {
    constructor(source, tx) { super(); this.source = source; this.transaction = tx; this.readyState = "pending"; this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
  }
  class IDBOpenDBRequest extends IDBRequest { constructor() { super(null, null); this.onupgradeneeded = null; this.onblocked = null; } }
  class IDBTransaction extends EventTarget {
    constructor(db, names, mode) {
      super(); this.db = db; this.mode = mode; this._names = names; this._pending = 0; this._done = false; this._wrote = false; this.error = null;
      this.oncomplete = null; this.onerror = null; this.onabort = null;
      // Completes once no request is pending at the end of a task (requests made in callbacks count).
      setTimeout(() => this._maybeComplete(), 0);
    }
    get objectStoreNames() { return this._names.slice(); }
    objectStore(name) {
      if (!this._names.includes(name) || !this.db._d.stores.has(name)) throw new DOMException("No objectStore named " + name, "NotFoundError");
      return new IDBObjectStore(this, name);
    }
    _request(source, run) {
      if (this._done) throw new DOMException("transaction finished", "TransactionInactiveError");
      const r = new IDBRequest(source, this);
      this._pending++;
      setTimeout(() => {
        try { r.result = run(); r.readyState = "done"; fire(r, "success"); }
        catch (e) { r.error = e; r.readyState = "done"; fire(r, "error"); }
        this._pending--;
        setTimeout(() => this._maybeComplete(), 0);
      }, 0);
      return r;
    }
    _maybeComplete() {
      if (this._done || this._pending) return;
      this._done = true;
      if (this._wrote) dirtyDb(this.db.name);
      fire(this, "complete");
    }
    abort() { this._done = true; fire(this, "abort"); }
    commit() {}
  }
  class IDBObjectStore {
    constructor(tx, name) { this.transaction = tx; this.name = name; this.keyPath = null; this.autoIncrement = false; }
    get _m() { return this.transaction.db._d.stores.get(this.name); }
    _write() {
      if (this.transaction.mode === "readonly") throw new DOMException("read-only transaction", "ReadOnlyError");
      this.transaction._wrote = true;
    }
    get(key) { return this.transaction._request(this, () => { const v = this._m.get(key); return v === undefined ? undefined : dec(v); }); }
    getAll() { return this.transaction._request(this, () => [...this._m.keys()].sort(cmpKey).map((k) => dec(this._m.get(k)))); }
    getAllKeys() { return this.transaction._request(this, () => [...this._m.keys()].sort(cmpKey)); }
    count() { return this.transaction._request(this, () => this._m.size); }
    put(value, key) { this._write(); const v = enc(value); return this.transaction._request(this, () => { this._m.set(key, v); return key; }); }
    add(value, key) {
      this._write();
      const v = enc(value);
      return this.transaction._request(this, () => { if (this._m.has(key)) throw new DOMException("key exists", "ConstraintError"); this._m.set(key, v); return key; });
    }
    delete(key) { this._write(); return this.transaction._request(this, () => { this._m.delete(key); return undefined; }); }
    clear() { this._write(); return this.transaction._request(this, () => { this._m.clear(); return undefined; }); }
    openCursor() {
      const tx = this.transaction, m = this._m, keys = [...m.keys()].sort(cmpKey);
      const r = new IDBRequest(this, tx);
      let i = 0;
      tx._pending++;
      const step = () => setTimeout(() => {
        if (i < keys.length) {
          const k = keys[i++];
          r.result = { key: k, primaryKey: k, value: dec(m.get(k)), continue: () => step() };
          fire(r, "success");
        } else {
          r.result = null;
          fire(r, "success");
          tx._pending--;
          setTimeout(() => tx._maybeComplete(), 0);
        }
      }, 0);
      step();
      return r;
    }
  }
  class IDBDatabase extends EventTarget {
    constructor(name, d) { super(); this.name = name; this._d = d; this.onversionchange = null; this.onclose = null; }
    get version() { return this._d.version; }
    get objectStoreNames() { const a = [...this._d.stores.keys()]; a.contains = (n) => a.includes(n); return a; }
    createObjectStore(name) { if (!this._d.stores.has(name)) this._d.stores.set(name, new Map()); return { name }; }
    deleteObjectStore(name) { this._d.stores.delete(name); }
    transaction(names, mode = "readonly") { return new IDBTransaction(this, Array.isArray(names) ? names.slice() : [String(names)], mode); }
    close() {}
  }
  g.indexedDB = {
    open(name, version) {
      const req = new IDBOpenDBRequest();
      setTimeout(() => {
        const n = String(name);
        const d = loadDb(n);
        const db = new IDBDatabase(n, d);
        req.result = db;
        const v = version === undefined ? Math.max(d.version, 1) : Number(version);
        if (v < d.version) { req.error = new DOMException("version too low", "VersionError"); fire(req, "error"); return; }
        if (v > d.version) {
          const old = d.version;
          d.version = v;
          req.transaction = { db, mode: "versionchange" };
          fire(req, "upgradeneeded", { oldVersion: old, newVersion: v });
          req.transaction = null;
          flushDb(n);
        }
        req.readyState = "done";
        fire(req, "success");
      }, 0);
      return req;
    },
    deleteDatabase(name) {
      const req = new IDBOpenDBRequest();
      setTimeout(() => { dbFiles.delete(String(name)); ops.op_powerboat_remove(dbPath(String(name)), false); fire(req, "success"); }, 0);
      return req;
    },
    databases() { return Promise.resolve([...dbFiles.entries()].map(([name, d]) => ({ name, version: d.version }))); },
    cmp: cmpKey,
  };
  g.IDBRequest = IDBRequest; g.IDBOpenDBRequest = IDBOpenDBRequest; g.IDBTransaction = IDBTransaction;
  g.IDBObjectStore = IDBObjectStore; g.IDBDatabase = IDBDatabase;
})();
