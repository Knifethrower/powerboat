// powerboat JS environment, part 7: the slice of NW.js / Node RPG Maker games call (port of
// retsurf-rmmv's pm_node.js onto native file ops), plus the MV compat fixes from its pm_compat.js.
// The game folder is ROOT (its real path); process.mainModule.filename is ROOT/index.html, so MV's
// StorageManager saves to ROOT/save. Absolute paths outside ROOT land in HOME (POWERBOAT_DATA_DIR/pm_home, else
// ROOT/pm_home) by their own path; HOME's own paths (home folder,
// LOCALAPPDATA) are used as they are. Off with POWERBOAT_NO_NODE=1 (then MV uses localStorage).
"use strict";
(() => {
  const ops = Deno.core.ops;
  const core = Deno.core;
  const g = globalThis;
  if (ops.op_powerboat_env("POWERBOAT_NO_NODE")) return;

  const ROOT = __powerboat.root;
  const HOME = (__powerboat.dataHome || ROOT) + "/pm_home";
  // os.tmpdir(): the system's, as in Node ($TMPDIR, else /tmp: tmpfs on the handhelds), and paths below it
  // are used as they are. It was HOME/tmp on the card, where each write is a temp file + rename that ext4
  // flushes when it replaces a file: h5bench's 1 MB write + read took 46.7 ms on the RG-34XXSP (quixjs, /tmp: 9.9).
  const TMP = String(ops.op_powerboat_env("TMPDIR") || "/tmp").replace(/\/+$/, "") || "/tmp";

  // ---- path ----------------------------------------------------------------------------------
  function normalize(p) {
    const abs = p.charAt(0) === "/";
    const trailing = p.length > 1 && p.charAt(p.length - 1) === "/";
    const out = [];
    for (const part of p.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") { if (out.length) out.pop(); continue; }
      out.push(part);
    }
    const joined = (abs ? "/" : "") + out.join("/");
    return trailing && out.length ? joined + "/" : joined;
  }
  const path = {
    sep: "/", delimiter: ":",
    normalize: (p) => normalize(String(p).replace(/\\/g, "/")) || ".",
    join: (...a) => path.normalize(a.filter((x) => x !== "").join("/")),
    resolve: (...a) => {
      let r = "";
      for (let i = a.length - 1; i >= 0 && r.charAt(0) !== "/"; i--) r = String(a[i]).replace(/\\/g, "/") + (r ? "/" + r : "");
      if (r.charAt(0) !== "/") r = ROOT + "/" + r;
      return normalize(r);
    },
    dirname: (p) => { p = String(p).replace(/\\/g, "/").replace(/\/+$/, ""); const i = p.lastIndexOf("/"); return i < 0 ? "." : i === 0 ? "/" : p.slice(0, i); },
    basename: (p, ext) => { p = String(p).replace(/\\/g, "/").replace(/\/+$/, ""); const b = p.slice(p.lastIndexOf("/") + 1); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
    extname: (p) => { const b = path.basename(p); const i = b.lastIndexOf("."); return i <= 0 ? "" : b.slice(i); },
    isAbsolute: (p) => String(p).charAt(0) === "/" || /^[A-Za-z]:[\\/]/.test(String(p)),
    relative: (from, to) => { const a = path.resolve(from).split("/"), b = path.resolve(to).split("/"); while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); } return a.map(() => "..").concat(b).join("/"); },
    parse: (p) => { const base = path.basename(p), ext = path.extname(p); return { root: path.isAbsolute(p) ? "/" : "", dir: path.dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base }; },
    format: (o) => (o.dir ? o.dir + "/" : "") + (o.base || (o.name || "") + (o.ext || "")),
  };
  path.posix = path;
  path.win32 = path;

  // A game path -> the real file. Windows drive paths ("C:\Users\..") count as outside ROOT.
  const real = (p) => {
    let s = String(p).replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(s)) s = "/" + s[0].toLowerCase() + s.slice(2);
    const abs = path.resolve(s);
    if (abs === ROOT || abs.startsWith(ROOT + "/")) return abs;
    if (abs === TMP || abs.startsWith(TMP + "/")) return abs;
    if (abs === HOME || abs.startsWith(HOME + "/")) return abs;
    return HOME + abs;
  };
  // HOME's own paths (os.homedir(), USERPROFILE, APPDATA, LOCALAPPDATA) were mapped like any other path outside
  // ROOT until 2026-11-18, to HOME + HOME/..., whenever POWERBOAT_DATA_DIR puts HOME outside the game folder (the
  // launchers do): OMORI read HOME/pm_home/<HOME>/AppData/Local/OMORI/CUTSCENE.json. What games wrote under that
  // doubled folder moves to where it belongs, once. A file or folder both places have stays where it is (logged),
  // nothing is overwritten; the doubled folders left empty are removed.
  (() => {
    const old = HOME + HOME;
    if (!ops.op_powerboat_stat(old)[0]) return;
    let moved = 0;
    const kept = [];
    const walk = (from, to) => {
      const r = ops.op_powerboat_readdir(from);
      if (r[1]) return;
      for (const name of r[0]) {
        const a = from + "/" + name, b = to + "/" + name;
        const sa = ops.op_powerboat_stat(a), sb = ops.op_powerboat_stat(b);
        if (!sb[0]) {
          ops.op_powerboat_mkdirs(to);
          if (ops.op_powerboat_rename(a, b) === "") moved++;
          else kept.push(a);
        } else if (sa[1] && sb[1]) walk(a, b);
        else kept.push(a);
      }
    };
    const prune = (dir) => {
      const r = ops.op_powerboat_readdir(dir);
      if (r[1]) return;
      for (const name of r[0]) if (ops.op_powerboat_stat(dir + "/" + name)[1]) prune(dir + "/" + name);
      ops.op_powerboat_remove(dir, false); // only if empty
    };
    try {
      walk(old, HOME);
      prune(old);
      // The chain above it (HOME/<first parts of HOME's own path>), while empty.
      for (let d = old.slice(0, old.lastIndexOf("/")); d.length > HOME.length; d = d.slice(0, d.lastIndexOf("/"))) {
        if (ops.op_powerboat_remove(d, false) !== "") break;
      }
    } catch (e) {
      ops.op_powerboat_log("powerboat: moving " + old + ": " + (e && e.message), true);
    }
    ops.op_powerboat_log("[powerboat] home folder: moved " + moved + " item(s) from " + old + (kept.length ? "; kept " + kept.length + " that " + HOME + " already has: " + kept.slice(0, 5).join(", ") : ""), true);
  })();

  // ---- Buffer --------------------------------------------------------------------------------
  function wrap(u8) { Object.setPrototypeOf(u8, Buffer.prototype); return u8; }
  function Buffer(arg, enc) { return Buffer.from(arg, enc); }
  Buffer.prototype = Object.create(Uint8Array.prototype);
  Buffer.prototype.constructor = Buffer;
  const latin1 = (view) => { let s = ""; for (let i = 0; i < view.length; i += 0x8000) s += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000)); return s; };
  Buffer.prototype.toString = function (enc, start, end) {
    const view = Uint8Array.prototype.subarray.call(this, start || 0, end === undefined ? this.length : end);
    enc = String(enc || "utf8").toLowerCase();
    if (enc === "base64") return btoa(latin1(view));
    if (enc === "latin1" || enc === "binary" || enc === "ascii") return latin1(view);
    if (enc === "hex") return Array.prototype.map.call(view, (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
    if (enc === "utf16le" || enc === "ucs2") { let s = ""; for (let i = 0; i + 1 < view.length; i += 2) s += String.fromCharCode(view[i] | (view[i + 1] << 8)); return s; }
    return core.decode(view);
  };
  Buffer.prototype.toJSON = function () { return { type: "Buffer", data: Array.prototype.slice.call(this) }; };
  Buffer.prototype.slice = Buffer.prototype.subarray = function (s, e) { return wrap(Uint8Array.prototype.subarray.call(this, s, e)); };
  Buffer.prototype.equals = function (o) { if (this.length !== o.length) return false; for (let i = 0; i < this.length; i++) if (this[i] !== o[i]) return false; return true; };
  Buffer.prototype.copy = function (target, ts = 0, ss = 0, se = this.length) { const part = Uint8Array.prototype.subarray.call(this, ss, se); target.set(part, ts); return part.length; };
  Buffer.prototype.write = function (str, offset = 0) { const b = core.encode(String(str)); this.set(b.subarray(0, this.length - offset), offset); return Math.min(b.length, this.length - offset); };
  Buffer.prototype.readUInt8 = function (o) { return this[o]; };
  Buffer.prototype.readUInt16LE = function (o) { return this[o] | (this[o + 1] << 8); };
  Buffer.prototype.readUInt32LE = function (o) { return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16)) + this[o + 3] * 0x1000000; };
  Buffer.prototype.readInt32LE = function (o) { return this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24); };
  Buffer.from = (arg, enc) => {
    if (typeof arg === "string") {
      enc = String(enc || "utf8").toLowerCase();
      if (enc === "base64") { const bin = atob(arg.replace(/[^A-Za-z0-9+/=]/g, "")); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return wrap(out); }
      if (enc === "latin1" || enc === "binary" || enc === "ascii") { const out = new Uint8Array(arg.length); for (let i = 0; i < arg.length; i++) out[i] = arg.charCodeAt(i) & 0xff; return wrap(out); }
      if (enc === "hex") { const out = new Uint8Array(arg.length >> 1); for (let i = 0; i < out.length; i++) out[i] = parseInt(arg.substr(i * 2, 2), 16); return wrap(out); }
      return wrap(core.encode(arg));
    }
    if (arg instanceof ArrayBuffer) return wrap(new Uint8Array(arg));
    if (ArrayBuffer.isView(arg)) return wrap(new Uint8Array(arg.buffer.slice(arg.byteOffset, arg.byteOffset + arg.byteLength)));
    if (arg && arg.type === "Buffer" && Array.isArray(arg.data)) return wrap(new Uint8Array(arg.data));
    return wrap(new Uint8Array(arg || 0));
  };
  Buffer.alloc = (n, fill) => { const b = wrap(new Uint8Array(n)); if (fill) b.fill(typeof fill === "number" ? fill : 0); return b; };
  Buffer.allocUnsafe = Buffer.alloc;
  Buffer.isBuffer = (b) => b instanceof Buffer;
  Buffer.byteLength = (s) => (typeof s === "string" ? core.encode(s).length : s.byteLength);
  Buffer.concat = (list, total) => {
    if (total === undefined) total = list.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(total); let at = 0;
    for (const b of list) { out.set(b.subarray(0, total - at), at); at += b.length; }
    return wrap(out);
  };

  // ---- fs ------------------------------------------------------------------------------------
  const fsError = (code, syscall, p, msg) => {
    const e = new Error(code + ": " + (msg || "no such file or directory") + ", " + syscall + " '" + p + "'");
    e.code = code; e.errno = code === "ENOENT" ? -2 : code === "EEXIST" ? -17 : -5; e.syscall = syscall; e.path = String(p);
    return e;
  };
  // op error strings: "ENOENT ..." / "EEXIST ..." / other.
  const check = (err, syscall, p) => {
    if (!err) return;
    const code = /^(ENOENT|EEXIST|ENOTDIR|EISDIR|EACCES|ENOTEMPTY)/.exec(err);
    throw fsError(code ? code[1] : "EIO", syscall, p, err);
  };
  const encodingOf = (o) => (typeof o === "string" ? o : o && o.encoding);
  const toBytes = (data, o) => {
    if (typeof data === "string") { const enc = encodingOf(o); return enc && enc !== "utf8" && enc !== "utf-8" ? Buffer.from(data, enc) : core.encode(data); }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return core.encode(String(data));
  };
  class Stats {
    constructor(s) { this.size = s[2]; this.mtimeMs = s[3]; this.mtime = new Date(s[3]); this.atime = this.ctime = this.birthtime = this.mtime; this.atimeMs = this.ctimeMs = this.birthtimeMs = s[3]; this._dir = s[1]; this.mode = s[1] ? 0o40755 : 0o100644; }
    isDirectory() { return this._dir; } isFile() { return !this._dir; } isSymbolicLink() { return false; }
  }
  const statOf = (p) => { const s = ops.op_powerboat_stat(real(p)); return s[0] ? new Stats(s) : null; };
  const fs = {
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    readFileSync(p, o) {
      if (typeof p === "number") throw fsError("EBADF", "read", p, "file descriptors not supported");
      const b = ops.op_powerboat_read_bytes(real(p));
      check(ops.op_powerboat_take_io_error(), "open", p);
      const enc = encodingOf(o);
      return enc ? Buffer.prototype.toString.call(b, enc) : wrap(b);
    },
    existsSync: (p) => ops.op_powerboat_stat(real(p))[0],
    statSync(p, o) { const s = statOf(p); if (!s) { if (o && o.throwIfNoEntry === false) return undefined; throw fsError("ENOENT", "stat", p); } return s; },
    readdirSync(p, o) {
      const r = ops.op_powerboat_readdir(real(p));
      check(r[1], "scandir", p);
      const names = r[0];
      if (o && o.withFileTypes) return names.map((n) => { const s = statOf(path.join(String(p), n)); return { name: n, isDirectory: () => !!(s && s._dir), isFile: () => !!(s && !s._dir), isSymbolicLink: () => false }; });
      return names;
    },
    writeFileSync(p, data, o) { const f = real(p); check(ops.op_powerboat_write_bytes(f, toBytes(data, o), false), "open", p); },
    appendFileSync(p, data, o) { const f = real(p); check(ops.op_powerboat_write_bytes(f, toBytes(data, o), true), "open", p); },
    mkdirSync(p, o) {
      const f = real(p);
      const recursive = o && typeof o === "object" && o.recursive;
      if (!recursive && ops.op_powerboat_stat(f)[0]) throw fsError("EEXIST", "mkdir", p, "file already exists");
      check(ops.op_powerboat_mkdirs(f), "mkdir", p);
      return recursive ? f : undefined;
    },
    unlinkSync(p) { check(ops.op_powerboat_remove(real(p), false), "unlink", p); },
    rmdirSync(p, o) { check(ops.op_powerboat_remove(real(p), !!(o && o.recursive)), "rmdir", p); },
    rmSync(p, o) { if (!ops.op_powerboat_stat(real(p))[0]) { if (o && o.force) return; throw fsError("ENOENT", "rm", p); } check(ops.op_powerboat_remove(real(p), true), "rm", p); },
    renameSync(a, b) { check(ops.op_powerboat_rename(real(a), real(b)), "rename", a); },
    copyFileSync(a, b) { fs.writeFileSync(b, fs.readFileSync(a)); },
    accessSync(p) { if (!ops.op_powerboat_stat(real(p))[0]) throw fsError("ENOENT", "access", p); },
    realpathSync: (p) => path.resolve(String(p)),
    openSync() { throw new Error("powerboat: fs.openSync not supported"); },
    watch() { return { close() {}, on() { return this; } }; },
    createWriteStream() { throw new Error("powerboat: fs.createWriteStream not supported"); },
  };
  fs.realpathSync.native = fs.realpathSync;
  // A callback's throw is an uncaught Node exception in NW.js: logged, the page carries on.
  const call = (cb, args) => { try { cb.apply(null, args); } catch (e) { console.error("Uncaught exception in a Node callback:", e && e.stack ? e.stack : e); } };
  const asyncOf = (syncFn) => function (...args) {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : () => {};
    setTimeout(() => { let r, err = null; try { r = syncFn.apply(fs, args); } catch (e) { err = e; } call(cb, [err, r]); }, 0);
  };
  for (const n of ["readFile", "writeFile", "appendFile", "mkdir", "unlink", "rmdir", "rm", "stat", "readdir", "copyFile", "rename", "access", "realpath"]) fs[n] = asyncOf(fs[n + "Sync"]);
  fs.lstat = fs.stat; fs.lstatSync = fs.statSync;
  fs.exists = (p, cb) => setTimeout(() => call(cb, [fs.existsSync(p)]), 0);
  fs.promises = {};
  for (const n of ["readFile", "writeFile", "appendFile", "mkdir", "unlink", "rmdir", "rm", "stat", "readdir", "copyFile", "rename", "access"]) {
    fs.promises[n] = (...args) => new Promise((res, rej) => fs[n](...args, (e, r) => (e ? rej(e) : res(r))));
  }

  // ---- os, crypto, nw.gui, child_process, greenworks, events, util ----------------------------
  const os = {
    platform: () => "linux", type: () => "Linux", arch: () => "arm64", release: () => "5.10.0",
    homedir: () => HOME, tmpdir: () => TMP, hostname: () => "handheld", userInfo: () => ({ username: "player", homedir: HOME }),
    cpus: () => [{}, {}, {}, {}], totalmem: () => 1 << 30, freemem: () => 1 << 29, endianness: () => "LE", EOL: "\n",
  };
  // Data decrypted in place at install (IV kept, ciphertext replaced): the decipher passes through.
  const crypto = {
    createDecipheriv: () => ({ update: (b) => Buffer.from(b), final: () => Buffer.alloc(0), setAutoPadding() { return this; } }),
    createCipheriv: () => ({ update: (b) => Buffer.from(b), final: () => Buffer.alloc(0), setAutoPadding() { return this; } }),
    randomBytes: (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0; return b; },
    createHash: () => { throw new Error("powerboat: crypto.createHash is not available"); },
  };
  const noopObject = (values) => new Proxy(values, { get: (t, k) => (k in t ? t[k] : typeof k === "symbol" ? undefined : () => undefined) });
  const nwWindow = noopObject({
    x: 0, y: 0, get width() { return g.innerWidth; }, get height() { return g.innerHeight; }, isFullscreen: true,
    isDevToolsOpen: () => false, close: () => g.close(), on: () => nwWindow, once: () => nwWindow, removeAllListeners: () => nwWindow,
    window: g,
  });
  const nw = {
    App: { argv: [], fullArgv: [], dataPath: HOME, manifest: {}, quit: () => g.close(), closeAllWindows: () => g.close(), clearCache() {}, on() {} },
    Window: { get: () => nwWindow, open: () => nwWindow },
    Screen: noopObject({ Init() {}, on() {}, screens: [{ bounds: { x: 0, y: 0, width: screen.width, height: screen.height }, work_area: { x: 0, y: 0, width: screen.width, height: screen.height }, scaleFactor: 1 }] }),
    Shell: noopObject({}), Menu: function () { return noopObject({}); }, MenuItem: function () { return noopObject({}); },
    Clipboard: { get: () => ({ get: () => "", set() {}, clear() {} }) },
  };
  // Electron renderer with nodeIntegration: the main process isn't run, so messages to it go nowhere. Those that
  // end the app are understood; a game wraps the rest in try/catch or doesn't look at the answer.
  const electronQuits = /^(close-app|quit|quit-app|app-quit|exit|exit-app|close|close-window)$/i;
  const electron = noopObject({
    ipcRenderer: noopObject({
      send: (channel) => { if (electronQuits.test(String(channel))) g.close(); },
      sendSync: (channel) => { if (electronQuits.test(String(channel))) g.close(); },
      invoke: (channel) => { if (electronQuits.test(String(channel))) g.close(); return Promise.resolve(undefined); },
      on() { return this; }, once() { return this; }, removeListener() { return this; }, removeAllListeners() { return this; },
    }),
    webFrame: noopObject({ getZoomFactor: () => 1 }),
    shell: noopObject({}), clipboard: noopObject({ readText: () => "" }),
  });
  const childProcess = {
    exec(cmd, o, cb) { cb = typeof o === "function" ? o : cb; if (cb) setTimeout(() => cb(new Error("no processes in this runtime"), "", ""), 0); return noopObject({}); },
    execSync() { throw new Error("no processes in this runtime"); },
    spawn: () => noopObject({ on() { return this; }, stdout: noopObject({}), stderr: noopObject({}) }),
  };
  class EventEmitter {
    constructor() { this._events = {}; }
    on(e, f) { (this._events[e] = this._events[e] || []).push(f); return this; }
    addListener(e, f) { return this.on(e, f); }
    emit(e, ...a) { const l = (this._events[e] || []).slice(); for (const f of l) f.apply(this, a); return l.length > 0; }
    removeListener(e, f) { this._events[e] = (this._events[e] || []).filter((x) => x !== f); return this; }
    off(e, f) { return this.removeListener(e, f); }
    removeAllListeners(e) { if (e) delete this._events[e]; else this._events = {}; return this; }
    once(e, f) { const o = (...a) => { this.removeListener(e, o); f.apply(this, a); }; return this.on(e, o); }
    listenerCount(e) { return (this._events[e] || []).length; }
    setMaxListeners() { return this; }
  }
  EventEmitter.EventEmitter = EventEmitter;
  // Steam (greenworks): always there, does nothing; achievements in pm_home/steam/achievements.json.
  const ACH = HOME + "/steam/achievements.json";
  let achievements = null;
  const unlocked = () => { if (achievements === null) { try { achievements = JSON.parse(fs.readFileSync(ACH, "utf8")); } catch (_) { achievements = {}; } } return achievements; };
  const saveAch = () => { try { fs.mkdirSync(HOME + "/steam", { recursive: true }); fs.writeFileSync(ACH, JSON.stringify(achievements)); } catch (e) { console.warn("powerboat: achievements:", e.message); } };
  const later = (cb, args) => { if (typeof cb === "function") setTimeout(() => call(cb, args || []), 0); };
  const steamUser = { screenName: "Player", level: 1, accountId: 1, staticAccountId: "1", steamId: "1", isAnonymous: false, isGameServer: false, isIndividualAccount: true };
  const greenworks = noopObject({
    init: () => true, initAPI: () => true, isSteamRunning: () => true, restartAppIfNecessary: () => false,
    getSteamId: () => steamUser, getCurrentGameLanguage: () => "english", getCurrentUILanguage: () => "english", getAppId: () => 0,
    getNumberOfPlayers: (ok) => later(ok, [1]), isGameOverlayEnabled: () => false, activateGameOverlay() {}, activateGameOverlayToWebPage() {},
    isCloudEnabled: () => false, isCloudEnabledForUser: () => false, enableCloud() {}, getCloudQuota: (ok) => later(ok, [0, 0]),
    saveTextToFile: (n, t, ok, err) => later(err, [new Error("Steam Cloud is off")]),
    readTextFromFile: (n, ok, err) => later(err, [new Error("Steam Cloud is off")]),
    getAchievementNames: () => Object.keys(unlocked()), getNumberOfAchievements: () => Object.keys(unlocked()).length,
    getAchievement: (n, ok) => later(ok, [!!unlocked()[n]]),
    activateAchievement: (n, ok) => { unlocked()[n] = true; saveAch(); later(ok); },
    clearAchievement: (n, ok) => { delete unlocked()[n]; saveAch(); later(ok); },
    getStatInt: () => 0, getStatFloat: () => 0, setStat: () => true, storeStats: (ok) => later(ok),
    on() {}, Utils: noopObject({}), ugcGetUserItems: (a, b, ok) => later(ok, [[]]),
  });
  const util = {
    inherits: (c, p) => { c.super_ = p; Object.setPrototypeOf(c.prototype, p.prototype); },
    format: (...a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "),
    inspect: (x) => { try { return JSON.stringify(x); } catch (_) { return String(x); } },
    promisify: (f) => function (...a) { return new Promise((res, rej) => f.apply(this, a.concat((e, r) => (e ? rej(e) : res(r))))); },
    isArray: Array.isArray, deprecate: (f) => f, TextDecoder: g.TextDecoder, TextEncoder: g.TextEncoder,
  };

  const builtins = {
    fs, path, os, crypto, util, "nw.gui": nw, electron, child_process: childProcess, events: EventEmitter,
    buffer: { Buffer }, url: { URL: g.URL, parse: (u) => new g.URL(u), fileURLToPath: (u) => String(u).replace(/^file:\/\//, "") },
    assert: (c, m) => { if (!c) throw new Error(m || "assertion failed"); },
    zlib: noopObject({}), http: noopObject({}), https: noopObject({}), net: noopObject({}),
  };

  // ---- require: builtins, then CommonJS files from the folder ----------------------------------
  const modules = {};
  const resolveFile = (p) => {
    for (const f of [p, p + ".js", p + ".json"]) { const s = statOf(f); if (s && s.isFile()) return f; }
    const d = statOf(p);
    if (!d || !d.isDirectory()) return null;
    let main = "index.js";
    try { const pkg = JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8")); if (pkg.main) main = pkg.main; } catch (_) {}
    return resolveFile(path.join(p, main)) || resolveFile(path.join(p, "index"));
  };
  const makeRequire = (dir) => {
    const require = (name) => {
      name = String(name);
      if (name.startsWith("node:")) name = name.slice(5);
      if (Object.prototype.hasOwnProperty.call(builtins, name)) return builtins[name];
      if (/greenworks/.test(name)) return greenworks;
      if (/\.node$/.test(name)) throw new Error("powerboat: native module '" + name + "' is not available");
      const file = resolveFile(path.resolve(dir, name));
      if (!file) { const e = new Error("Cannot find module '" + name + "'"); e.code = "MODULE_NOT_FOUND"; throw e; }
      if (modules[file]) return modules[file].exports;
      const module = { exports: {}, filename: file, id: file, loaded: false, children: [], paths: [] };
      modules[file] = module;
      const src = fs.readFileSync(file, "utf8");
      if (file.endsWith(".json")) module.exports = JSON.parse(src);
      else {
        const wrapped = "(function (exports, require, module, __filename, __dirname) {" + src + "\n})";
        const [fn, err] = core.evalContext(wrapped, "file://" + real(file));
        if (err) throw err.thrown;
        fn.call(module.exports, module.exports, makeRequire(path.dirname(file)), module, file, path.dirname(file));
      }
      module.loaded = true;
      return module.exports;
    };
    require.resolve = (name) => resolveFile(path.resolve(dir, String(name))) || name;
    require.cache = modules;
    return require;
  };

  // Memory as Node reports it, in bytes (src/mem.rs). external = what lives outside the V8 heap for JS objects:
  // ArrayBuffers (also given alone as arrayBuffers, as in Node) plus the runtime's decoded images, Canvas 2D pixmaps
  // and audio PCM. The ops write into this one buffer, so games may call these every frame.
  const memF = new Float64Array(16), memU = new Uint8Array(memF.buffer);
  const memoryUsage = () => {
    ops.op_powerboat_heap_stats(memU);
    const heapUsed = memF[0], heapTotal = memF[1], arrayBuffers = memF[3];
    return { rss: ops.op_powerboat_rss(), heapTotal, heapUsed, external: arrayBuffers + ops.op_powerboat_bytes(), arrayBuffers };
  };
  memoryUsage.rss = () => ops.op_powerboat_rss();
  const rusage = () => { ops.op_powerboat_rusage(memU); return memF; };
  const resourceUsage = () => {
    const f = rusage();
    return {
      userCPUTime: f[0], systemCPUTime: f[1], maxRSS: f[2], sharedMemorySize: f[3], unsharedDataSize: f[4], unsharedStackSize: f[5],
      minorPageFault: f[6], majorPageFault: f[7], swappedOut: f[8], fsRead: f[9], fsWrite: f[10], ipcSent: f[11], ipcReceived: f[12],
      signalsCount: f[13], voluntaryContextSwitches: f[14], involuntaryContextSwitches: f[15],
    };
  };
  const cpuUsage = (prev) => { const f = rusage(), u = f[0], s = f[1]; return prev ? { user: u - prev.user, system: s - prev.system } : { user: u, system: s }; };

  const process = {
    platform: "linux", arch: "arm64", pid: 1,
    versions: { node: "16.0.0", nw: "0.50.0", "node-webkit": "0.50.0", chrome: "90.0.0.0", v8: "15.0" }, version: "v16.0.0",
    env: { HOME, LOCALAPPDATA: HOME + "/AppData/Local", APPDATA: HOME + "/AppData/Roaming", USERPROFILE: HOME, USERNAME: "player", USER: "player" },
    argv: ["nw", ROOT], execPath: ROOT + "/nw", mainModule: { filename: ROOT + "/index.html" },
    cwd: () => ROOT, chdir() {}, exit: () => g.close(), on() { return process; }, once() { return process; }, emit() { return false; }, removeListener() { return process; },
    nextTick: (f, ...a) => { Promise.resolve().then(() => f(...a)); },
    hrtime: Object.assign((prev) => { const t = performance.now(); const s = Math.floor(t / 1000), ns = Math.floor((t % 1000) * 1e6); return prev ? [s - prev[0], ns - prev[1]] : [s, ns]; }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
    memoryUsage, resourceUsage, cpuUsage,
    uptime: () => performance.now() / 1000,
    stdout: { write: (s) => { ops.op_powerboat_log(String(s).replace(/\n$/, ""), false); return true; } },
    stderr: { write: (s) => { ops.op_powerboat_log(String(s).replace(/\n$/, ""), true); return true; } },
  };

  g.require = makeRequire(ROOT);
  g.process = process;
  // NW.js gives page scripts __dirname and __filename as well. Emscripten modules see process.versions.node, take
  // their Node path and start from __dirname (RPG Maker MZ's effekseer.min.js: "__dirname is not defined").
  g.__dirname = ROOT;
  g.__filename = ROOT + "/index.html";
  g.Buffer = Buffer;
  g.global = g;
  // NW.js run with --expose-gc gives scripts gc(); Hypnospace Outlaw calls global.gc() between scenes. V8
  // collects on its own here.
  if (typeof g.gc !== "function") g.gc = () => {};
  g.nw = nw;
  g.__pmSetArgv = (argv) => { nw.App.argv = argv.slice(); nw.App.fullArgv = argv.slice(); };
  if (!g.btoa) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    g.btoa = (s) => { let o = ""; for (let i = 0; i < s.length; i += 3) { const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2); o += A[a >> 2] + A[((a & 3) << 4) | (b >> 4 || 0)] + (i + 1 < s.length ? A[((b & 15) << 2) | (c >> 6 || 0)] : "=") + (i + 2 < s.length ? A[c & 63] : "="); } return o; };
    g.atob = (s) => { s = String(s).replace(/[^A-Za-z0-9+/]/g, ""); let o = ""; for (let i = 0; i < s.length; i += 4) { const n = (A.indexOf(s[i]) << 18) | (A.indexOf(s[i + 1]) << 12) | ((A.indexOf(s[i + 2]) & 63) << 6) | (A.indexOf(s[i + 3]) & 63); o += String.fromCharCode((n >> 16) & 255); if (i + 2 < s.length) o += String.fromCharCode((n >> 8) & 255); if (i + 3 < s.length) o += String.fromCharCode(n & 255); } return o; };
  }
})();

// ---- MV compat (from pm_compat.js) -----------------------------------------------------------------
(() => {
  const g = globalThis;
  const ops = Deno.core.ops;
  // Pipelined frame (POWERBOAT_PIPELINE, default on): draw the state the last ticks left, flush so a
  // tile-based GPU (Mali) starts on it, then run this frame's logic ticks on the CPU while the GPU
  // renders; the swap after the tick then waits for little. One frame of extra latency. Installed
  // right after rpg_managers.js, before plugins wrap updateMain (OMORI's do).
  const pipelined = function () {
    const newTime = this._getTimeInMsWithoutMobileSafari();
    let fTime = (newTime - this._currentTime) / 1000;
    if (fTime > 0.25) fTime = 0.25;
    this._currentTime = newTime;
    this._accumulator += fTime;
    const t0 = performance.now();
    this.renderScene();
    const t1 = performance.now();
    const r = g.Graphics && Graphics._renderer;
    if (r && r.gl) { if (finishDiag) r.gl.finish(); else r.gl.flush(); }
    const t2 = performance.now();
    let ticks = 0;
    while (this._accumulator >= this._deltaTime) {
      this.updateInputData();
      this.changeScene();
      this.updateScene();
      this._accumulator -= this._deltaTime;
      ticks++;
    }
    if (frameDiag) frameDiag.add(t1 - t0, t2 - t1, performance.now() - t2, ticks);
    this.requestUpdate();
  };
  const finishDiag = ops.op_powerboat_env("POWERBOAT_FINISH_RENDER") === "1";
  const frameDiag = !ops.op_powerboat_env("POWERBOAT_FRAME_DEBUG") ? null : {
    render: 0, gpu: 0, logic: 0, ticks: 0, n: 0,
    add(render, gpu, logic, ticks) {
      this.render += render; this.gpu += gpu; this.logic += logic; this.ticks += ticks; this.n++;
      if (this.n >= 150) {
        const n = this.n;
        console.log("[powerboat] js ms per frame: render " + (this.render / n).toFixed(1) + ", flush/finish " + (this.gpu / n).toFixed(1) + ", logic " + (this.logic / n).toFixed(1) + " (" + (this.ticks / n).toFixed(2) + " steps, " + (this.logic / Math.max(1, this.ticks)).toFixed(1) + " ms each)");
        this.render = this.gpu = this.logic = this.ticks = this.n = 0;
      }
    },
  };
  // Cropped images (crop.rs, 20_dom.js): the texture holds a smaller "page" with each cell's visible
  // part. A PIXI frame, given in the image's pixels, is mapped to the cell holding it and trimmed
  // to that cell's visible part (PIXI's trim/orig keep the sprite's size and placement). A frame
  // no single cell holds is held back (drawn empty) until the next render; if it is still set
  // then, the image is stored whole again, as for uses that ignore trim (TilingSprite, meshes,
  // sprite masks). POWERBOAT_CROP=0 turns cropping off.
  const installCropFrames = () => {
    const P = g.PIXI;
    if (!P || !P.Texture || P.Texture._powerboatCrop) return;
    const T = P.Texture.prototype;
    const desc = Object.getOwnPropertyDescriptor(T, "frame");
    if (!desc || !desc.set || typeof T._updateUvs !== "function") return;
    P.Texture._powerboatCrop = true;
    const layoutOf = (bt) => (bt && bt.source && bt.source._powerboatLayout) || null;
    const mapped = new WeakMap(); // baseTexture -> Set of WeakRefs to textures with mapped frames
    const spans = new Set(); // textures holding a frame that spans cells, until the next render
    const restore = (t) => { const f = t._powerboatFrame; t._powerboatFrame = null; t._powerboatSpan = false; t.trim = null; desc.set.call(t, f); };
    const uncrop = (bt) => {
      if (!layoutOf(bt)) return;
      bt.source._powerboatUncrop();
      const refs = mapped.get(bt);
      mapped.delete(bt);
      bt.update(); // uploads the whole image again
      if (refs) for (const r of refs) { const t = r.deref(); if (t && t.baseTexture === bt && t._powerboatFrame) restore(t); }
    };
    const track = (bt, t) => {
      let refs = mapped.get(bt);
      if (!refs) mapped.set(bt, (refs = new Set()));
      refs.add(t._powerboatRef || (t._powerboatRef = new WeakRef(t)));
    };
    Object.defineProperty(T, "frame", {
      configurable: true,
      get: desc.get,
      set(frame) {
        const bt = this.baseTexture, L = layoutOf(bt);
        if (this._powerboatFrame && frame === this._frame) frame = this._powerboatFrame; // the mapped frame set again
        this._powerboatSpan = false;
        if (!L || !frame || !(frame.width > 0 && frame.height > 0)) {
          if (this._powerboatFrame) { this._powerboatFrame = null; this.trim = null; }
          return desc.set.call(this, frame);
        }
        const fx = frame.x, fy = frame.y, fw = frame.width, fh = frame.height;
        const cols = L[2], rows = L[3], cw = L[4], ch = L[5];
        const c = Math.floor(fx / cw), r = Math.floor(fy / ch);
        this._powerboatFrame = new P.Rectangle(fx, fy, fw, fh); // MV reuses its frame object
        this.orig = new P.Rectangle(0, 0, fw, fh);
        track(bt, this);
        if (c < 0 || r < 0 || c >= cols || r >= rows || fx + fw > (c + 1) * cw || fy + fh > (r + 1) * ch) {
          this._powerboatSpan = true;
          spans.add(this);
          this.trim = new P.Rectangle(0, 0, 0, 0);
          return desc.set.call(this, new P.Rectangle(0, 0, 1, 1));
        }
        const i = 6 + (r * cols + c) * 6;
        const x = L[i], y = L[i + 1], w = L[i + 2], h = L[i + 3];
        const x0 = Math.max(fx, x), y0 = Math.max(fy, y), x1 = Math.min(fx + fw, x + w), y1 = Math.min(fy + fh, y + h);
        if (x1 <= x0 || y1 <= y0) {
          this.trim = new P.Rectangle(0, 0, 0, 0); // nothing visible in this frame
          return desc.set.call(this, new P.Rectangle(0, 0, 1, 1));
        }
        this.trim = new P.Rectangle(x0 - fx, y0 - fy, x1 - x0, y1 - y0);
        return desc.set.call(this, new P.Rectangle(L[i + 4] + x0 - x, L[i + 5] + y0 - y, x1 - x0, y1 - y0));
      },
    });
    // UVs: frames are in page pixels, so divide by the page size, not the image's.
    const updateUvs = T._updateUvs;
    T._updateUvs = function () {
      const L = layoutOf(this.baseTexture);
      if (!L) return updateUvs.call(this);
      if (!this._uvs) updateUvs.call(this);
      this._uvs.set(this._frame, L._page || (L._page = { width: L[0], height: L[1] }), this.rotate);
      this._updateID++;
    };
    const clone = T.clone;
    T.clone = function () {
      if (!this._powerboatFrame) return clone.call(this);
      const t = new P.Texture(this.baseTexture);
      t.frame = this._powerboatFrame;
      return t;
    };
    // Uses that ignore trim get the whole image.
    const wholeFor = (proto, method, texOf) => {
      if (!proto || typeof proto[method] !== "function") return;
      const f = proto[method];
      proto[method] = function (...a) {
        const t = texOf(this);
        if (t && layoutOf(t.baseTexture)) uncrop(t.baseTexture);
        return f.apply(this, a);
      };
    };
    const extras = P.extras || P;
    wholeFor(extras.TilingSprite && extras.TilingSprite.prototype, "_renderWebGL", (o) => o._texture);
    wholeFor(P.mesh && P.mesh.Mesh && P.mesh.Mesh.prototype, "_renderWebGL", (o) => o._texture);
    wholeFor(P.SpriteMaskFilter && P.SpriteMaskFilter.prototype, "apply", (o) => o.maskSprite && o.maskSprite._texture);
    // Frames still spanning cells when a frame is drawn: store those images whole.
    const R = P.WebGLRenderer && P.WebGLRenderer.prototype;
    if (R && typeof R.render === "function") {
      const render = R.render;
      R.render = function (...a) {
        if (spans.size) {
          for (const t of spans) if (t._powerboatSpan && layoutOf(t.baseTexture)) uncrop(t.baseTexture);
          spans.clear();
        }
        return render.apply(this, a);
      };
    }
    // MV's decrypting image loader: remember the URL so the image gets its crop hint.
    if (g.Decrypter && typeof Decrypter.decryptImg === "function") {
      const decryptImg = Decrypter.decryptImg;
      Decrypter.decryptImg = function (url, bitmap) {
        if (bitmap && bitmap._image) bitmap._image._powerboatHintUrl = url;
        return decryptImg.apply(this, arguments);
      };
    }
    console.log("powerboat: cropped images on (POWERBOAT_CROP=0 turns it off)");
  };

  __powerboat.onManagersLoaded = () => {
    if (ops.op_powerboat_env("POWERBOAT_CROP") !== "0") installCropFrames();
    const sm = g.SceneManager;
    if (!sm || ops.op_powerboat_env("POWERBOAT_PIPELINE") === "0") return;
    if (typeof sm.updateMainFluidTimestep === "function") { sm.updateMainFluidTimestep = pipelined; console.log("powerboat: pipelined frame (updateMainFluidTimestep)"); }
    else if (/_accumulator/.test(String(sm.updateMain)) && /renderScene/.test(String(sm.updateMain))) { sm.updateMain = pipelined; console.log("powerboat: pipelined frame (updateMain)"); }
  };
  g.addEventListener("load", () => {
    // Game speed: MV's fixed 60 Hz logic step at any frame rate (YEP_FpsSynchOption replaces it
    // with one step per frame unless its option is on). POWERBOAT_FLUID=0 keeps the game's choice.
    const sm = g.SceneManager;
    if (sm && typeof sm.updateMainFluidTimestep === "function" && ops.op_powerboat_env("POWERBOAT_FLUID") !== "0") sm.updateMain = sm.updateMainFluidTimestep;
    // OMORI (GTP_OmoriFixes) drives SceneManager from a PIXI ticker: update(deltaTime) runs
    // determineRepeatNumber() logic steps, then renders. Same pipelining as above: render the last
    // state, flush, then the logic steps while the GPU draws. Before SceneManager.run starts the ticker.
    if (sm && ops.op_powerboat_env("POWERBOAT_PIPELINE") !== "0" && /determineRepeatNumber/.test(String(sm.update)) && /renderScene/.test(String(sm.update))) {
      sm.update = function (deltaTime) {
        Graphics.tickStart();
        const t0 = performance.now();
        this.renderScene();
        const t1 = performance.now();
        const r = Graphics._renderer;
        if (r && r.gl) { if (finishDiag) r.gl.finish(); else r.gl.flush(); }
        const t2 = performance.now();
        let n = 0;
        try {
          n = this.determineRepeatNumber(deltaTime);
          for (let i = 0; i < n; i++) { this.updateManagers(); this.updateMain(); }
        } catch (e) {
          this.catchException(e);
        }
        if (frameDiag) frameDiag.add(t1 - t0, t2 - t1, performance.now() - t2, n);
        Graphics.tickEnd();
      };
      console.log("powerboat: pipelined frame (SceneManager.update, ticker-driven)");
    }
    // POWERBOAT_PATCHES=a.js:b.js: per-game scripts run here, after every plugin, before the game starts.
    // NW.js pages (POWERBOAT_WEBPAGE) ran theirs before the load event (79_webpage.js).
    const patches = ops.op_powerboat_env("POWERBOAT_WEBPAGE") === "1" ? "" : ops.op_powerboat_env("POWERBOAT_PATCHES") || "";
    for (const p of patches.split(":").filter(Boolean)) {
      try { __powerboat.loadScript(p); console.log("powerboat: patch " + p); }
      catch (e) { console.error("powerboat: patch " + p + " failed:", e && e.stack ? e.stack : e); }
    }
    // MV's RequestQueue loads images one at a time, at most one per frame; with decoding on other
    // cores that serialises nothing but latency (OMORI waits ~4 s for its boot queue). Start up to
    // POWERBOAT_PARALLEL_IMAGES (default 8) requests at once; finished ones still leave in order.
    const par = Number(ops.op_powerboat_env("POWERBOAT_PARALLEL_IMAGES") || 8);
    if (g.RequestQueue && par > 1) {
      RequestQueue.prototype.update = function () {
        const q = this._queue;
        while (q.length && q[0].value.isRequestReady()) q.shift();
        for (let i = 0; i < q.length && i < par; i++) q[i].value.startRequest();
      };
    }
    // POWERBOAT_BOOT_DEBUG=1: steps of the boot that take over 50 ms.
    if (ops.op_powerboat_env("POWERBOAT_BOOT_DEBUG")) {
      const timeIt = (owner, name, label) => {
        const f = owner && owner[name];
        if (typeof f !== "function") return;
        owner[name] = function (...a) {
          const t = performance.now();
          const r = f.apply(this, a);
          const d = performance.now() - t;
          if (d > 50) console.log("[powerboat] boot: " + label + " " + d.toFixed(0) + " ms (at " + t.toFixed(0) + ")");
          return r;
        };
      };
      for (const n of ["initialize", "initGraphics", "initAudio", "initInput", "initNwjs", "checkFileAccess", "checkPluginErrors", "setupErrorHandlers", "preferableRendererType", "changeScene", "updateScene", "renderScene"]) timeIt(sm, n, "SceneManager." + n);
      for (const n of ["initialize", "_createAllElements", "_createRenderer", "_createGameFontLoader", "_setupCssFontLoading"]) timeIt(g.Graphics, n, "Graphics." + n);
      for (const n of ["initialize", "_createContext"]) timeIt(g.WebAudio, n, "WebAudio." + n);
      for (const n of ["loadDatabase", "loadDataFile", "onLoad", "isDatabaseLoaded", "setupNewGame"]) timeIt(g.DataManager, n, "DataManager." + n);
      if (g.Scene_Boot) for (const n of ["create", "start", "isReady", "loadSystemImages", "loadSystemWindowImage"]) timeIt(Scene_Boot.prototype, n, "Scene_Boot." + n);
    }
    // Renderer: MV games (or plugins like YAN_SetRenderer) may ask for PIXI's Canvas renderer; on a
    // handheld that draws on the CPU at 5-12 fps (RG353V). Use WebGL unless POWERBOAT_RENDERER=game.
    if (sm && typeof sm.preferableRendererType === "function" && ops.op_powerboat_env("POWERBOAT_RENDERER") !== "game") {
      const pref = sm.preferableRendererType;
      sm.preferableRendererType = function () {
        const want = pref.call(this);
        if (want === "canvas") console.log("powerboat: game asked for the canvas renderer; using WebGL (POWERBOAT_RENDERER=game keeps canvas)");
        return "webgl";
      };
    }
    // A PIXI BlurFilter at strength 0 is the identity but still costs 2 x quality full-screen
    // passes (OMORI keeps one on its map spriteset: ~8 passes a frame). PIXI 4 skips filters with
    // enabled = false, so `enabled` also reads false while the strength is 0; a game's own
    // enabled = false still holds. POWERBOAT_KEEP_ZERO_BLUR=1 turns this off.
    const Blur = g.PIXI && PIXI.filters && PIXI.filters.BlurFilter;
    if (Blur && ops.op_powerboat_env("POWERBOAT_KEEP_ZERO_BLUR") !== "1" && !Object.getOwnPropertyDescriptor(Blur.prototype, "enabled")) {
      Object.defineProperty(Blur.prototype, "enabled", {
        get() { return this._powerboatEnabled !== false && !(this.blurXFilter && this.blurXFilter.blur === 0 && this.blurYFilter.blur === 0); },
        set(v) { this._powerboatEnabled = !!v; },
        configurable: true,
      });
    }
    // MV skips the next render(s) when one took over 15 ms (Graphics._maxSkip, default 3). On a
    // handheld that halves what is shown while logic keeps its pace. POWERBOAT_FRAMESKIP=n sets the
    // most renders it may skip in a row (0 = draw every frame).
    const fs = ops.op_powerboat_env("POWERBOAT_FRAMESKIP");
    if (fs !== "" && g.Graphics && typeof Graphics.initialize === "function") {
      // Graphics.initialize (at SceneManager.run, after this) sets _maxSkip = 3: apply it after.
      const init = Graphics.initialize;
      Graphics.initialize = function (...a) {
        const r = init.apply(this, a);
        this._maxSkip = Math.max(0, Number(fs) | 0);
        console.log("powerboat: MV frame skip limit " + this._maxSkip);
        return r;
      };
    }
    // MV keeps decoded bitmaps up to ImageCache.limit pixels; OMORI raises it to 80 M (320 MB).
    const cap = Number(ops.op_powerboat_env("POWERBOAT_IMAGE_CACHE_MP") || 24) * 1000 * 1000;
    if (g.ImageCache && ImageCache.limit > cap) ImageCache.limit = cap;
  });
})();
