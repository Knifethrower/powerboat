// powerboat JS environment, part 1: the "browser" globals MV expects, on top of deno_core.
// Runs once at startup in the main realm, before the game's scripts. Everything here is plain
// JS over the Rust ops in src/ops.rs. Unknown or unimplemented web APIs should throw with their
// name (SCOPE.md: gaps surface as clear errors, not silent misbehaviour).
"use strict";
(() => {
  const core = Deno.core;
  const ops = core.ops;
  const g = globalThis;

  // ---- logging -------------------------------------------------------------------------------
  const fmt = (args) => args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack || String(a);
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }).join(" ");
  const log = (...a) => ops.op_powerboat_log(fmt(a), false);
  const err = (...a) => ops.op_powerboat_log(fmt(a), true);
  g.console = {
    log, info: log, debug: log, trace: log,
    warn: err, error: err,
    group: log, groupEnd() {}, groupCollapsed: log, table: log, dir: log, assert(c, ...a) { if (!c) err("assert", ...a); },
    time() {}, timeEnd() {}, count() {},
  };
  const reportError = (e) => err("[powerboat] uncaught:", e && e.stack ? e.stack : e);
  g.reportError = reportError;
  // Browsers log an unhandled rejection and carry on; deno_core would end the event loop.
  core.setUnhandledPromiseRejectionHandler((promise, reason) => {
    err("[powerboat] unhandled rejection:", reason && reason.stack ? reason.stack : reason);
    try { const ev = new Event("unhandledrejection"); ev.promise = promise; ev.reason = reason; if (g.dispatchEvent) g.dispatchEvent(ev); } catch (_) {}
    return true;
  });

  // ---- window = globalThis -------------------------------------------------------------------
  g.window = g;
  g.self = g;
  // performance.memory as in Chrome (the V8 heap in bytes, src/mem.rs), read fresh: Chrome rounds and caches it
  // unless started with --enable-precise-memory-info.
  const heapF = new Float64Array(6), heapU = new Uint8Array(heapF.buffer);
  g.performance = {
    now: () => ops.op_powerboat_now(),
    timeOrigin: Date.now(),
    mark() {}, measure() {}, getEntriesByName() { return []; }, clearMarks() {}, clearMeasures() {},
    get memory() { ops.op_powerboat_heap_stats(heapU); return { usedJSHeapSize: heapF[0], totalJSHeapSize: heapF[1], jsHeapSizeLimit: heapF[2] }; },
  };
  g.__powerboat = { reportError };

  // ---- EventTarget / Event ---------------------------------------------------------------------
  class Event {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      this.defaultPrevented = false;
      this.timeStamp = performance.now();
      this.target = null;
      this.currentTarget = null;
      this.isTrusted = true;
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() {}
    stopImmediatePropagation() { this._stop = true; }
  }
  class KeyboardEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.key = init.key || "";
      this.code = init.code || "";
      this.keyCode = init.keyCode | 0;
      this.which = this.keyCode;
      this.charCode = 0;
      this.repeat = !!init.repeat;
      this.altKey = !!init.altKey;
      this.ctrlKey = !!init.ctrlKey;
      this.shiftKey = !!init.shiftKey;
      this.metaKey = !!init.metaKey;
      this.location = 0;
      this.isComposing = false;
    }
  }
  class MouseEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.clientX = this.pageX = this.x = this.offsetX = this.screenX = +init.clientX || 0;
      this.clientY = this.pageY = this.y = this.offsetY = this.screenY = +init.clientY || 0;
      this.movementX = +init.movementX || 0;
      this.movementY = +init.movementY || 0;
      this.button = init.button | 0;
      this.buttons = init.buttons | 0;
      this.which = this.button + 1;
      this.detail = init.detail | 0;
      this.altKey = this.ctrlKey = this.shiftKey = this.metaKey = false;
      this.relatedTarget = null;
    }
    getModifierState() { return false; }
  }
  class PointerEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType || "mouse";
      this.isPrimary = init.isPrimary ?? true;
      this.width = this.height = 1;
      this.pressure = +init.pressure || 0;
      this.tangentialPressure = this.tiltX = this.tiltY = this.twist = 0;
    }
    getCoalescedEvents() { return [this]; }
  }
  class WheelEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.deltaX = +init.deltaX || 0;
      this.deltaY = +init.deltaY || 0;
      this.deltaZ = 0;
      this.deltaMode = init.deltaMode | 0;
    }
  }
  WheelEvent.DOM_DELTA_PIXEL = 0; WheelEvent.DOM_DELTA_LINE = 1; WheelEvent.DOM_DELTA_PAGE = 2;
  KeyboardEvent.prototype.getModifierState = function (k) { return k === "Shift" ? this.shiftKey : k === "Control" ? this.ctrlKey : k === "Alt" ? this.altKey : k === "Meta" ? this.metaKey : false; };
  class EventTarget {
    constructor() { this._listeners = new Map(); }
    addEventListener(type, fn, _opts) {
      if (!fn) return;
      let l = this._listeners.get(type);
      if (!l) this._listeners.set(type, l = []);
      if (!l.includes(fn)) l.push(fn);
    }
    removeEventListener(type, fn) {
      const l = this._listeners.get(type);
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    }
    dispatchEvent(ev) {
      if (!ev.target) ev.target = this;
      ev.currentTarget = this;
      const l = this._listeners.get(ev.type);
      if (l) {
        for (const fn of l.slice()) {
          try { typeof fn === "function" ? fn.call(this, ev) : fn.handleEvent(ev); } catch (e) { reportError(e); }
          if (ev._stop) break;
        }
      }
      const h = this["on" + ev.type];
      if (typeof h === "function") { try { h.call(this, ev); } catch (e) { reportError(e); } }
      return !ev.defaultPrevented;
    }
  }
  g.Event = Event;
  g.KeyboardEvent = KeyboardEvent;
  g.MouseEvent = MouseEvent;
  g.PointerEvent = PointerEvent;
  g.WheelEvent = WheelEvent;
  g.EventTarget = EventTarget;
  // window itself: listeners live on a hidden target, handlers "onxxx" on the global.
  const windowTarget = new EventTarget();
  g.addEventListener = (t, f, o) => windowTarget.addEventListener(t, f, o);
  g.removeEventListener = (t, f) => windowTarget.removeEventListener(t, f);
  g.dispatchEvent = (ev) => {
    if (!ev.target) ev.target = g;
    ev.currentTarget = g;
    const l = windowTarget._listeners.get(ev.type);
    if (l) for (const fn of l.slice()) { try { fn.call(g, ev); } catch (e) { reportError(e); } if (ev._stop) break; }
    const h = g["on" + ev.type];
    if (typeof h === "function") { try { h.call(g, ev); } catch (e) { reportError(e); } }
    return !ev.defaultPrevented;
  };

  // ---- timers ---------------------------------------------------------------------------------
  // Run from __powerboat_tick (everything due at the frame) and from __powerboat_timers, which the frame loop
  // calls between the tick and the present while a timer falls due before the frame is shown. Until
  // 2026-11-17 they ran once per frame only: 20 chained setTimeout(0) took 354 ms (a frame a hop, so
  // every XHR / fs / decode callback chain paid a frame per step) and setInterval(10) beat at 60 Hz.
  let timerSeq = 1;
  const timers = new Map();
  // Every due timer, then again while callbacks add timers that are already due (0 ms hops), until
  // budgetEnd. Intervals keep their phase (Blink's drift-free rule): a missed beat is skipped, never
  // repeated, so setInterval(1000 / 60) beats every frame instead of slipping to every other one.
  const runTimers = (budgetEnd) => {
    for (;;) {
      const now = performance.now();
      let due = null;
      for (const t of timers.values()) if (t.at <= now) (due || (due = [])).push(t);
      if (!due) return;
      due.sort((a, b) => a.at - b.at || a.seq - b.seq);
      for (const t of due) {
        if (!timers.has(t.seq)) continue; // cleared by an earlier callback
        if (t.interval) {
          const n = performance.now();
          t.at += t.interval;
          if (t.at <= n) t.at += (Math.floor((n - t.at) / t.interval) + 1) * t.interval;
        } else timers.delete(t.seq);
        try { t.fn(...t.args); } catch (x) { reportError(x); }
        checkpoint();
      }
      if (performance.now() >= budgetEnd) return;
    }
  };
  // The frame loop's call: runs what is due, returns ms until the next timer (-1: none).
  g.__powerboat_timers = () => {
    if (!timers.size) return -1;
    runTimers(performance.now() + 4);
    let next = Infinity;
    for (const t of timers.values()) if (t.at < next) next = t.at;
    return next === Infinity ? -1 : Math.max(0, next - performance.now());
  };
  const setTimer = (fn, ms, args, interval) => {
    const id = timerSeq++;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { at: performance.now() + delay, fn, args, interval: interval ? Math.max(1, delay) : 0, seq: id });
    return id;
  };
  g.setTimeout = (fn, ms, ...args) => setTimer(fn, ms, args, false);
  g.setInterval = (fn, ms, ...args) => setTimer(fn, ms, args, true);
  g.clearTimeout = g.clearInterval = (id) => { timers.delete(id); };
  g.queueMicrotask = g.queueMicrotask || ((fn) => { Promise.resolve().then(fn); });

  // ---- requestAnimationFrame -----------------------------------------------------------------
  let rafSeq = 1;
  let rafQueue = new Map();
  g.requestAnimationFrame = (fn) => { const id = rafSeq++; rafQueue.set(id, fn); return id; };
  g.cancelAnimationFrame = (id) => { rafQueue.delete(id); };

  // ---- screen / window geometry ---------------------------------------------------------------
  const size = () => [ops.op_powerboat_width(), ops.op_powerboat_height()];
  Object.defineProperty(g, "innerWidth", { get: () => size()[0], configurable: true });
  Object.defineProperty(g, "innerHeight", { get: () => size()[1], configurable: true });
  Object.defineProperty(g, "outerWidth", { get: () => size()[0], configurable: true });
  Object.defineProperty(g, "outerHeight", { get: () => size()[1], configurable: true });
  g.devicePixelRatio = 1;
  g.screen = {
    get width() { return size()[0]; }, get height() { return size()[1]; },
    get availWidth() { return size()[0]; }, get availHeight() { return size()[1]; },
    colorDepth: 24, pixelDepth: 24,
  };
  g.screenX = 0; g.screenY = 0;
  // The page never scrolls. jQuery 3's offset() adds these to getBoundingClientRect(); undefined made
  // Construct 2's mouse position NaN (Hypnospace Outlaw: the cursor stayed in the corner).
  g.pageXOffset = g.pageYOffset = g.scrollX = g.scrollY = 0;
  g.moveTo = () => {}; g.moveBy = () => {}; g.resizeTo = () => {}; g.resizeBy = () => {};
  g.focus = () => {}; g.blur = () => {}; g.scrollTo = () => {}; g.scroll = () => {};
  g.open = () => null;
  g.close = () => ops.op_powerboat_quit();
  g.alert = (m) => err("[alert]", m);
  g.confirm = () => true;
  g.prompt = () => null;
  g.getComputedStyle = () => ({ getPropertyValue: () => "" });
  g.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

  // ---- keyboard: SDL scancode (USB HID usage) -> browser keyCode / key / code ----------------
  const SC = {};
  const KEYS = {};
  const CODES = {};
  const def = (sc, keyCode, key, code) => { SC[sc] = keyCode; KEYS[sc] = key; CODES[sc] = code; };
  for (let i = 0; i < 26; i++) def(4 + i, 65 + i, String.fromCharCode(97 + i), "Key" + String.fromCharCode(65 + i));
  for (let i = 0; i < 9; i++) def(30 + i, 49 + i, String(i + 1), "Digit" + (i + 1));
  def(39, 48, "0", "Digit0");
  def(40, 13, "Enter", "Enter"); def(41, 27, "Escape", "Escape"); def(42, 8, "Backspace", "Backspace");
  def(43, 9, "Tab", "Tab"); def(44, 32, " ", "Space"); def(45, 189, "-", "Minus"); def(46, 187, "=", "Equal");
  def(47, 219, "[", "BracketLeft"); def(48, 221, "]", "BracketRight"); def(49, 220, "\\", "Backslash");
  def(51, 186, ";", "Semicolon"); def(52, 222, "'", "Quote"); def(53, 192, "`", "Backquote");
  def(54, 188, ",", "Comma"); def(55, 190, ".", "Period"); def(56, 191, "/", "Slash"); def(57, 20, "CapsLock", "CapsLock");
  for (let i = 0; i < 12; i++) def(58 + i, 112 + i, "F" + (i + 1), "F" + (i + 1));
  def(70, 44, "PrintScreen", "PrintScreen"); def(71, 145, "ScrollLock", "ScrollLock"); def(72, 19, "Pause", "Pause");
  def(73, 45, "Insert", "Insert"); def(74, 36, "Home", "Home"); def(75, 33, "PageUp", "PageUp"); def(76, 46, "Delete", "Delete");
  def(77, 35, "End", "End"); def(78, 34, "PageDown", "PageDown");
  def(79, 39, "ArrowRight", "ArrowRight"); def(80, 37, "ArrowLeft", "ArrowLeft"); def(81, 40, "ArrowDown", "ArrowDown"); def(82, 38, "ArrowUp", "ArrowUp");
  def(83, 144, "NumLock", "NumLock"); def(84, 111, "/", "NumpadDivide"); def(85, 106, "*", "NumpadMultiply");
  def(86, 109, "-", "NumpadSubtract"); def(87, 107, "+", "NumpadAdd"); def(88, 13, "Enter", "NumpadEnter");
  for (let i = 0; i < 9; i++) def(89 + i, 97 + i, String(i + 1), "Numpad" + (i + 1));
  def(98, 96, "0", "Numpad0"); def(99, 110, ".", "NumpadDecimal");
  def(224, 17, "Control", "ControlLeft"); def(225, 16, "Shift", "ShiftLeft"); def(226, 18, "Alt", "AltLeft"); def(227, 91, "Meta", "MetaLeft");
  def(228, 17, "Control", "ControlRight"); def(229, 16, "Shift", "ShiftRight"); def(230, 18, "Alt", "AltRight"); def(231, 92, "Meta", "MetaRight");
  // SDL keymod bits: shift 0x0003, ctrl 0x00C0, alt 0x0300, gui 0x0C00
  const keyEvent = (type, e) => {
    const shift = !!(e.mods & 0x0003), ctrl = !!(e.mods & 0x00c0), alt = !!(e.mods & 0x0300), meta = !!(e.mods & 0x0c00);
    let key = KEYS[e.scancode] ?? e.key;
    if (shift && key.length === 1 && key >= "a" && key <= "z") key = key.toUpperCase();
    return new KeyboardEvent(type, {
      key, code: CODES[e.scancode] || "", keyCode: SC[e.scancode] | 0,
      repeat: !!e.repeat, shiftKey: shift, ctrlKey: ctrl, altKey: alt, metaKey: meta, cancelable: true,
    });
  };

  // ---- the per-frame entry point, called from Rust --------------------------------------------
  __powerboat.pads = new Map(); // which -> {name, buttons: Map, axes: Map}
  let padEvent;
  // Start quits the bare examples; a booted game (bootHtml) switches to hotkey+Start held together.
  // The hotkey is PortMaster's (control.txt exports HOTKEY: l3 or guide on some devices, else Select).
  __powerboat.quitOnStart = true;
  const hotkey = { l3: "leftstick", r3: "rightstick", guide: "guide", select: "back", back: "back" }[
    String(ops.op_powerboat_env("HOTKEY") || "").toLowerCase()] || "back";
  __powerboat.quitCombo = [hotkey, "start"];
  // ---- mouse: SDL (or gptokeyb's stick-as-mouse) -> pointer + mouse events ---------------------
  // Dispatched at the main canvas, then document and window, as a bubbling browser event would be
  // (Construct 3 listens on window, RPG Maker on document). Positions come as window fractions and
  // become CSS pixels of the page. POWERBOAT_MOUSE=0 drops them.
  const mouseOn = ops.op_powerboat_env("POWERBOAT_MOUSE") !== "0";
  // A class, not an object literal: V8 gives all 3-property literals and JSON objects whose keys start x, y one shared
  // shape, so fractional pointer positions stored in a literal here made x and y boxed doubles in every such game
  // object ({x, y, z} with integers: 24 -> 48 bytes with pointer compression, h5bench bytes.object_3_ints).
  class PointerState { constructor() { this.x = 0; this.y = 0; this.buttons = 0; } }
  const mouse = new PointerState();
  const BUTTON_BIT = [1, 4, 2, 8, 16]; // DOM button index -> buttons bit
  const bubble = (ev) => {
    // A form element under the pointer (82_forms.js) gets the event first and up its parents.
    const hit = __powerboat.hitTarget && __powerboat.hitTarget(mouse.x, mouse.y, ev.type);
    if (hit) {
      ev.target = hit;
      for (let n = hit; n && n !== g.document && !ev._stop; n = n.parentNode) n.dispatchEvent(ev);
      if (g.document && !ev._stop) g.document.dispatchEvent(ev);
      if (!ev._stop) g.dispatchEvent(ev);
      return !ev.defaultPrevented;
    }
    const c = __powerboat.mainCanvas;
    ev.target = c || g.document || g;
    if (c && typeof c.dispatchEvent === "function") c.dispatchEvent(ev);
    if (g.document && !ev._stop) g.document.dispatchEvent(ev);
    if (!ev._stop) g.dispatchEvent(ev);
    return !ev.defaultPrevented;
  };
  const mouseInit = (button, extra) => ({
    clientX: mouse.x, clientY: mouse.y, button, buttons: mouse.buttons,
    bubbles: true, cancelable: true, ...extra,
  });
  // A layer that knows where the window shows the game canvas maps through it (82_forms.js).
  // Phaser reads the pointer against the CSS box its scale manager gave the canvas, while the window
  // shows the canvas fitted and centered: window points map from that picture into that box.
  const phaserPage = (fx, fy) => {
    const m = __powerboat.mainCanvas, c = typeof m === "function" ? m() : m, W = g.innerWidth, H = g.innerHeight;
    if (!c || !c.width || !c.height) return [fx * W, fy * H];
    const fit = Math.min(W / c.width, H / c.height), r = c.getBoundingClientRect();
    return [r.left + ((fx * W - (W - c.width * fit) / 2) / (c.width * fit)) * r.width,
      r.top + ((fy * H - (H - c.height * fit) / 2) / (c.height * fit)) * r.height];
  };
  const toPage = (e) => (__powerboat.pagePoint ? __powerboat.pagePoint(e.fx, e.fy) : g.Phaser ? phaserPage(e.fx, e.fy) : [e.fx * g.innerWidth, e.fy * g.innerHeight]);
  const mouseMove = (e) => {
    const [x, y] = toPage(e);
    const init = mouseInit(-1, { movementX: x - mouse.x, movementY: y - mouse.y });
    mouse.x = init.clientX = x; mouse.y = init.clientY = y;
    bubble(new PointerEvent("pointermove", { ...init, pressure: mouse.buttons ? 0.5 : 0 }));
    bubble(new MouseEvent("mousemove", init));
  };
  // Click count, as browsers keep it: a left click within 500 ms and 4 px of the previous one counts on,
  // and the second one also fires dblclick (Construct 2's Mouse plugin: "DOUBLE CLICK TO BEGIN" in
  // Hypnospace Outlaw).
  const clicks = { n: 0, at: 0, x: 0, y: 0 };
  const mouseButton = (e) => {
    const [px, py] = toPage(e);
    if (px !== mouse.x || py !== mouse.y) mouseMove(e);
    const bit = BUTTON_BIT[e.button] || 0;
    if (e.down) mouse.buttons |= bit; else mouse.buttons &= ~bit;
    if (e.down && e.button === 0) {
      const t = g.performance.now();
      const near = Math.abs(mouse.x - clicks.x) <= 4 && Math.abs(mouse.y - clicks.y) <= 4;
      clicks.n = near && t - clicks.at <= 500 ? clicks.n + 1 : 1;
      Object.assign(clicks, { at: t, x: mouse.x, y: mouse.y });
    }
    const init = mouseInit(e.button, { detail: e.button === 0 ? clicks.n : 1 });
    bubble(new PointerEvent(e.down ? "pointerdown" : "pointerup", { ...init, pressure: e.down ? 0.5 : 0 }));
    bubble(new MouseEvent(e.down ? "mousedown" : "mouseup", init));
    if (!e.down) {
      bubble(new MouseEvent(e.button === 2 ? "contextmenu" : "click", init));
      if (e.button === 0 && clicks.n === 2) bubble(new MouseEvent("dblclick", init));
    }
  };
  __powerboat.handleEvent = (e) => {
    switch (e.type) {
      case "quit": ops.op_powerboat_quit(); break;
      case "keydown": {
        const ev = keyEvent("keydown", e);
        if (g.document) g.document.dispatchEvent(ev);
        g.dispatchEvent(ev);
        break;
      }
      case "keyup": {
        const ev = keyEvent("keyup", e);
        if (g.document) g.document.dispatchEvent(ev);
        g.dispatchEvent(ev);
        break;
      }
      case "padadded": __powerboat.pads.set(e.which, { name: e.name, buttons: new Map(), axes: new Map(), announced: false }); break;
      case "padremoved": {
        const p = __powerboat.pads.get(e.which);
        if (p && p.announced) padEvent("gamepaddisconnected", p);
        __powerboat.pads.delete(e.which);
        break;
      }
      case "padbutton": {
        const p = __powerboat.pads.get(e.which);
        if (p) p.buttons.set(e.button, e.down);
        // As in browsers, a page hears of a pad at its first button press.
        if (p && e.down && !p.announced) { p.announced = true; padEvent("gamepadconnected", p); }
        if (e.down && e.button === "start" && __powerboat.quitOnStart) ops.op_powerboat_quit();
        else if (e.down && p && __powerboat.quitCombo.every((b) => p.buttons.get(b))) { console.log("powerboat: quit (" + __powerboat.quitCombo.join("+") + ")"); ops.op_powerboat_quit(); }
        break;
      }
      case "padaxis": { const p = __powerboat.pads.get(e.which); if (p) p.axes.set(e.axis, e.value / 32767); break; }
      case "mousemove": if (mouseOn) mouseMove(e); break;
      case "mousebutton": if (mouseOn) mouseButton(e); break;
      case "wheel":
        // SDL: +y = away from the user; DOM: +deltaY = scroll down. One notch ~ 100 px.
        if (mouseOn && bubble(new WheelEvent("wheel", mouseInit(0, { deltaX: e.dx * 100, deltaY: -e.dy * 100 })))) {
          // Chromium also fires the old "mousewheel" (wheelDelta 120 per notch, + = up) unless "wheel" was
          // cancelled: Construct 2's Mouse plugin listens only for it (and Firefox's DOMMouseScroll).
          const ev = new WheelEvent("mousewheel", mouseInit(0, { deltaX: e.dx * 100, deltaY: -e.dy * 100 }));
          ev.wheelDelta = ev.wheelDeltaY = Math.round(e.dy * 120);
          ev.wheelDeltaX = Math.round(-e.dx * 120);
          bubble(ev);
        }
        break;
      case "resize": g.dispatchEvent(new Event("resize")); break;
      case "focus": g.dispatchEvent(new Event(e.focused ? "focus" : "blur")); break;
    }
  };
  const sceneLog = !!ops.op_powerboat_env("POWERBOAT_FRAME_DEBUG");
  let lastScene = null;
  // A microtask checkpoint after every task, as browsers do: promise continuations of one timer or
  // event callback run before the next callback (C3's AJAX reads LastData in a continuation).
  const checkpoint = () => { try { Deno.core.runMicrotasks(); } catch (x) { reportError(x); } };
  g.__powerboat_tick = (now) => {
    for (const e of ops.op_powerboat_poll_events()) {
      try { __powerboat.handleEvent(e); } catch (x) { reportError(x); }
      checkpoint();
    }
    if (__powerboat.pollAudio) { try { __powerboat.pollAudio(); } catch (x) { reportError(x); } }
    if (__powerboat.tickVideo) { try { __powerboat.tickVideo(); } catch (x) { reportError(x); } }
    if (__powerboat.tickUi) { try { __powerboat.tickUi(); } catch (x) { reportError(x); } }
    if (sceneLog && g.SceneManager) {
      const s = SceneManager._scene, name = s && s.constructor ? s.constructor.name : "-";
      const map = g.$gameMap && $gameMap.mapId ? $gameMap.mapId() : 0;
      const key = name + "/" + map;
      if (key !== lastScene) { lastScene = key; err("[powerboat] scene " + name + (map ? " map " + map : "") + " at " + Math.round(now) + " ms"); }
    }
    if (timers.size) runTimers(performance.now() + 6);
    if (rafQueue.size) {
      const q = rafQueue;
      rafQueue = new Map();
      for (const fn of q.values()) {
        try { fn(now); } catch (x) { reportError(x); }
        checkpoint();
      }
    }
  };

  // ---- document (M0: enough for a canvas; M2 grows it into MV's DOM needs) --------------------
  class CSSStyle {
    constructor() { this.cssText = ""; }
    setProperty(k, v) { this[k] = v; }
    getPropertyValue(k) { return this[k] ?? ""; }
    removeProperty(k) { delete this[k]; }
  }
  // element.classList over className, as browsers keep them in step (RPG Maker MZ plugins use it a lot:
  // EliMZ_Book builds its error printer with it while Graphics initializes).
  class DOMTokenList {
    constructor(el) { this._el = el; }
    _get() { return String(this._el.className || "").split(/\s+/).filter(Boolean); }
    _set(list) { this._el.className = list.join(" "); }
    get length() { return this._get().length; }
    get value() { return String(this._el.className || ""); }
    set value(v) { this._el.className = String(v); }
    item(i) { return this._get()[i] ?? null; }
    contains(c) { return this._get().includes(String(c)); }
    add(...cs) { const l = this._get(); for (const c of cs.map(String)) if (!l.includes(c)) l.push(c); this._set(l); }
    remove(...cs) { const r = cs.map(String); this._set(this._get().filter((c) => !r.includes(c))); }
    toggle(c, force) {
      c = String(c);
      const has = this.contains(c), on = force === undefined ? !has : !!force;
      if (on && !has) this.add(c); else if (!on && has) this.remove(c);
      return on;
    }
    replace(a, b) { const l = this._get(), i = l.indexOf(String(a)); if (i < 0) return false; l[i] = String(b); this._set([...new Set(l)]); return true; }
    forEach(fn, self) { this._get().forEach(fn, self); }
    [Symbol.iterator]() { return this._get()[Symbol.iterator](); }
    toString() { return this.value; }
  }
  g.DOMTokenList = DOMTokenList;
  class HTMLElement extends EventTarget {
    get classList() { return new DOMTokenList(this); }
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.nodeName = this.tagName;
      this.style = new CSSStyle();
      this.children = [];
      this.childNodes = this.children;
      this.parentNode = null;
      this.id = ""; this.className = ""; this.innerHTML = ""; this.textContent = "";
      this.hidden = false;
      this.dataset = {};
    }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
    insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) return this.appendChild(c); c.parentNode = this; this.children.splice(i, 0, c); return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    contains(c) { for (let n = c; n; n = n.parentNode) if (n === this) return true; return false; }
    setAttribute(k, v) { this["_attr_" + k] = String(v); if (k === "id") this.id = String(v); }
    getAttribute(k) { return this["_attr_" + k] ?? null; }
    removeAttribute(k) { delete this["_attr_" + k]; }
    hasAttribute(k) { return ("_attr_" + k) in this; }
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    // Elements without a size of their own (a game's parent <div>) fill the page, as blocks do:
    // Phaser's scale manager fits the game into this box and gave 0x0 otherwise.
    getBoundingClientRect() {
      const w = this.width === undefined ? g.innerWidth : this.width | 0, h = this.height === undefined ? g.innerHeight : this.height | 0;
      return { left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0 };
    }
    get clientLeft() { return 0; } get clientTop() { return 0; }
    focus() {} blur() {} click() {}
    get clientWidth() { return this.width | 0; } get clientHeight() { return this.height | 0; }
    get offsetWidth() { return this.width | 0; } get offsetHeight() { return this.height | 0; }
    querySelector() { return null; } querySelectorAll() { return []; }
    getElementsByTagName(t) { const u = t.toUpperCase(); return this.children.filter((c) => u === "*" || c.tagName === u); }
  }
  class HTMLCanvasElement extends HTMLElement {
    constructor() { super("canvas"); this.width = 300; this.height = 150; this._gl = null; }
    // Under Phaser, the box its scale manager set in CSS (see phaserPage); others keep 0,0 + backing size.
    getBoundingClientRect() {
      const r = super.getBoundingClientRect();
      if (!g.Phaser) return r;
      const s = this.style, px = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
      const left = px(s.marginLeft, 0), top = px(s.marginTop, 0), width = px(s.width, r.width), height = px(s.height, r.height);
      return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top };
    }
    getContext(type, attrs) {
      if (type === "webgl" || type === "experimental-webgl") {
        if (!this._gl) this._gl = g.__powerboat.createWebGLContext(this, attrs || {});
        return this._gl;
      }
      return null; // "2d" is handled by 30_canvas2d.js
    }
    toDataURL() { throw new Error("powerboat: canvas.toDataURL not implemented"); }
  }
  g.HTMLElement = HTMLElement;
  g.HTMLCanvasElement = HTMLCanvasElement;
  g.Node = HTMLElement;
  g.Element = HTMLElement;

  class Document extends EventTarget {
    constructor() {
      super();
      this.documentElement = new HTMLElement("html");
      this.head = new HTMLElement("head");
      this.body = new HTMLElement("body");
      this.documentElement.appendChild(this.head);
      this.documentElement.appendChild(this.body);
      this.readyState = "complete";
      this.visibilityState = "visible";
      this.hidden = false;
      this.title = "";
      this.currentScript = null;
      this.defaultView = g;
    }
    createElement(tag) {
      switch (String(tag).toLowerCase()) {
        case "canvas": return new HTMLCanvasElement();
        default: return new HTMLElement(tag);
      }
    }
    createElementNS(_ns, tag) { return this.createElement(tag); }
    createTextNode(text) { const n = new HTMLElement("#text"); n.textContent = String(text); n.nodeType = 3; return n; }
    getElementById(id) {
      const walk = (n) => { if (n.id === id) return n; for (const c of n.children) { const r = walk(c); if (r) return r; } return null; };
      return walk(this.documentElement);
    }
    getElementsByTagName(t) {
      const u = String(t).toUpperCase(); const out = [];
      const walk = (n) => { for (const c of n.children) { if (u === "*" || c.tagName === u) out.push(c); walk(c); } };
      walk(this.documentElement);
      return out;
    }
    querySelector() { return null; } querySelectorAll() { return []; }
    hasFocus() { return true; }
    exitFullscreen() { return Promise.resolve(); }
    get fullscreenElement() { return null; }
  }
  g.Document = Document;
  g.document = new Document();

  g.navigator = {
    userAgent: "Mozilla/5.0 (X11; Linux aarch64) powerboat/0.1",
    platform: "Linux aarch64", language: "en-US", languages: ["en-US"],
    onLine: false, hardwareConcurrency: 4, maxTouchPoints: 0,
    getGamepads() { return __powerboat.gamepads(); },
    vibrate() { return false; },
    plugins: Object.assign([], { namedItem: () => null, item: () => null, refresh() {} }),
    mimeTypes: Object.assign([], { namedItem: () => null, item: () => null }),
    cookieEnabled: false, doNotTrack: null, vendor: "", product: "Gecko", appName: "Netscape", appVersion: "5.0 (X11)",
  };
  // Gamepad API, standard mapping, from SDL's game-controller view of the pad (so Knulli's
  // positional ABXY and dArkOS's labelled ABXY both come out as the standard layout).
  const PAD_BUTTONS = ["a", "b", "x", "y", "leftshoulder", "rightshoulder", "lefttrigger", "righttrigger",
    "back", "start", "leftstick", "rightstick", "dpup", "dpdown", "dpleft", "dpright", "guide"];
  const PAD_AXES = ["leftx", "lefty", "rightx", "righty"];
  // gamepadconnected / gamepaddisconnected with the pad's current state.
  padEvent = (type, pad) => {
    const ev = new Event(type);
    ev.gamepad = __powerboat.gamepads()[[...__powerboat.pads.values()].indexOf(pad)];
    g.dispatchEvent(ev);
  };
  __powerboat.gamepads = () => {
    const out = [];
    for (const p of __powerboat.pads.values()) {
      const buttons = PAD_BUTTONS.map((name, i) => {
        const value = i === 6 || i === 7 ? Math.max(0, p.axes.get(name) || 0) : (p.buttons.get(name) ? 1 : 0);
        return { pressed: value > 0.5, touched: value > 0, value };
      });
      out.push({
        id: p.name, index: out.length, connected: true, mapping: "standard",
        buttons, axes: PAD_AXES.map((a) => p.axes.get(a) || 0), timestamp: performance.now(),
      });
    }
    return out;
  };
  g.Gamepad = function Gamepad() {};
  g.GamepadEvent = class GamepadEvent extends Event { constructor(type, init = {}) { super(type, init); this.gamepad = init.gamepad || null; } };

  // POWERBOAT_QUERY=a=1&b=2: the page's location.search (h5bench's ?only=, pages that read options from the URL).
  const search = String(ops.op_powerboat_env("POWERBOAT_QUERY") || "").replace(/^\?/, "");
  g.location = { href: "file:///index.html" + (search ? "?" + search : ""), protocol: "file:", search: search ? "?" + search : "", hash: "", pathname: "/index.html", host: "", hostname: "", origin: "null", reload() {} };
})();
