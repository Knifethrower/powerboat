// powerboat JS environment, part 11: HTML form elements. Construct's Button, TextBox, List
// and SliderBar plugins are real DOM elements over the canvas (BOD EFSANESI's main menu is three
// Buttons). There is no page renderer, so visible ones are painted here, in browser-default style,
// into one 2D canvas the size of the page; gl.rs blits each element's rect over the game picture
// (op_ui_overlay). Mouse presses go to the element under the pointer (00_env.js asks hitTarget),
// clicks toggle checkboxes, pick list rows and move sliders; keys type into a focused text box.
"use strict";
(() => {
  if (Deno.core.ops.op_powerboat_env("POWERBOAT_CONSTRUCT") !== "1") return;
  const ops = Deno.core.ops;
  const g = globalThis;
  const DP = g.Document.prototype;
  const FORM_TAGS = new Set(["input", "button", "select", "textarea"]);
  const forms = new Set(); // every form element created; drawn while visible
  const baseCreate = DP.createElement;
  DP.createElement = function (tag) {
    const el = baseCreate.call(this, tag);
    if (FORM_TAGS.has(String(tag).toLowerCase())) forms.add(el);
    return el;
  };

  const px = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  const shown = (el) => {
    let n = el;
    for (; n && n !== document.body; n = n.parentNode) {
      const s = n.style || {};
      if (s.display === "none" || s.visibility === "hidden" || String(s.opacity) === "0" || n.hidden) return false;
    }
    return n === document.body;
  };
  // The element C3 positions: a checkbox sits in a <label> that carries the rect.
  const box = (el) => (el.parentNode && el.parentNode.tagName === "LABEL" ? el.parentNode : el);
  const rectOf = (el) => {
    const b = box(el), s = b.style;
    const type = el.tagName === "INPUT" ? String(el.type || "text").toLowerCase() : el.tagName.toLowerCase();
    const dw = type === "checkbox" ? 13 : type === "range" ? 129 : type === "select" ? 120 : 80;
    return [px(s.left, 0), px(s.top, 0), px(s.width, dw), px(s.height, type === "select" && el.size > 1 ? 70 : 22)];
  };
  const fontOf = (el) => {
    const s = box(el).style;
    let size = String(s.fontSize || "");
    let sz = px(size, 13.333);
    // Construct sets "<layer scale>em": relative to the parent (the page default 16px).
    if (/pt$/.test(size)) sz *= 4 / 3; else if (/r?em$/.test(size)) sz *= 16;
    const fam = s.fontFamily || "Arial";
    const weight = s.fontWeight && s.fontWeight !== "normal" ? s.fontWeight + " " : "";
    const style = s.fontStyle === "italic" ? "italic " : "";
    return { css: style + weight + Math.round(sz) + "px " + fam, size: sz };
  };
  const kind = (el) => (el.tagName === "INPUT" ? String(el.type || "text").toLowerCase() : el.tagName.toLowerCase());
  const visible = () => {
    const out = [];
    for (const el of forms) if (kind(el) !== "hidden" && shown(box(el))) out.push(el);
    return out;
  };

  const debug = !!ops.op_powerboat_env("POWERBOAT_FORMS_DEBUG");
  let focused = null, pressed = null;
  let canvas = null, ctx = null, lastSig = "", on = false;
  const sigOf = (els) => JSON.stringify([g.innerWidth, g.innerHeight, focused && els.indexOf(focused), pressed && els.indexOf(pressed), els.map((el) => [
    kind(el), rectOf(el), fontOf(el).css, el.value, el.checked, el.disabled, el.placeholder, el.min, el.max,
    el.tagName === "SELECT" ? [el.selectedIndex, el.size, el.options.map((o) => o.text)] : 0,
    box(el).textContent, box(el).style.backgroundColor, box(el).style.color, box(el).style.border,
  ])]);

  // ---- painting (Chrome's default form look, flat) -----------------------------------------------
  const BORDER = "#767676";
  // Labels too wide for their box shrink to fit (down to 6px): Construct keeps elements at 1x page
  // size, which a handheld-sized window makes small for the browser's 13px default.
  const textIn = (c, text, x, y, w, h, align, color) => {
    c.save();
    c.beginPath(); c.rect(x, y, w, h); c.clip();
    const tw = c.measureText(text).width, room = w - 6;
    const m = /([\d.]+)px/.exec(c.font);
    if (m && tw > room && room > 0) c.font = c.font.replace(m[0], Math.max(6, +m[1] * room / tw).toFixed(1) + "px");
    c.fillStyle = color; c.textBaseline = "middle"; c.textAlign = align;
    c.fillText(text, align === "center" ? x + w / 2 : x + 3, y + h / 2);
    c.restore();
  };
  const frame = (c, x, y, w, h, bg, border) => {
    c.fillStyle = bg; c.fillRect(x, y, w, h);
    c.strokeStyle = border; c.lineWidth = 1; c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  };
  const paint = (c, el) => {
    const [x, y, w, h] = rectOf(el), b = box(el), t = kind(el), f = fontOf(el);
    const fg = b.style.color || (el.disabled ? "#6d6d6d" : "#000");
    c.font = f.css;
    if (t === "button" || t === "submit" || t === "reset") {
      const bg = b.style.backgroundColor || (el.disabled ? "#f6f6f6" : pressed === el ? "#d4d4d4" : "#efefef");
      frame(c, x, y, w, h, bg, el.disabled ? "#c4c4c4" : BORDER);
      textIn(c, String(el.tagName === "BUTTON" ? el.textContent : el.value ?? ""), x, y, w, h, "center", fg);
    } else if (t === "checkbox" || t === "radio") {
      // The label's own text follows the box.
      if (b !== el) { c.fillStyle = b.style.backgroundColor || "rgba(0,0,0,0)"; if (b.style.backgroundColor) c.fillRect(x, y, w, h); }
      const s = Math.min(13, h), bx = x + 2, by = y + (h - s) / 2;
      frame(c, bx, by, s, s, el.checked ? "#0075ff" : "#fff", el.checked ? "#0075ff" : BORDER);
      if (el.checked) {
        c.strokeStyle = "#fff"; c.lineWidth = 2; c.beginPath();
        c.moveTo(bx + s * 0.22, by + s * 0.52); c.lineTo(bx + s * 0.42, by + s * 0.72); c.lineTo(bx + s * 0.8, by + s * 0.3); c.stroke();
      }
      if (b !== el) textIn(c, String(b.textContent || ""), bx + s + 2, y, w - s - 4, h, "left", b.style.color || "#000");
    } else if (t === "range") {
      const min = px(el.min, 0), max = px(el.max, 100), v = Math.min(max, Math.max(min, px(el.value, (min + max) / 2)));
      const k = max > min ? (v - min) / (max - min) : 0, r = Math.min(8, h / 2), cy = y + h / 2;
      c.fillStyle = b.style.backgroundColor || "rgba(0,0,0,0)"; if (b.style.backgroundColor) c.fillRect(x, y, w, h);
      c.fillStyle = "#efefef"; c.fillRect(x + r, cy - 2, w - 2 * r, 4);
      c.fillStyle = "#0075ff"; c.fillRect(x + r, cy - 2, (w - 2 * r) * k, 4);
      c.beginPath(); c.arc(x + r + (w - 2 * r) * k, cy, r, 0, Math.PI * 2); c.fill();
    } else if (t === "select") {
      frame(c, x, y, w, h, b.style.backgroundColor || "#fff", BORDER);
      const opts = el.options;
      if (el.size > 1 || el.multiple) {
        const rh = Math.max(12, Math.round(f.size * 1.25));
        opts.forEach((o, i) => {
          const ry = y + 1 + i * rh;
          if (ry + rh > y + h) return;
          if (o.selected) { c.fillStyle = "#cecece"; c.fillRect(x + 1, ry, w - 2, rh); }
          textIn(c, o.text, x + 1, ry, w - 2, rh, "left", fg);
        });
      } else {
        const o = opts[el.selectedIndex];
        textIn(c, o ? o.text : "", x, y, w - 16, h, "left", fg);
        c.fillStyle = fg; c.beginPath(); c.moveTo(x + w - 13, y + h / 2 - 2); c.lineTo(x + w - 5, y + h / 2 - 2); c.lineTo(x + w - 9, y + h / 2 + 3); c.fill();
      }
    } else {
      // Text box (text, password, number, email, search, url, tel; textarea).
      frame(c, x, y, w, h, b.style.backgroundColor || (el.disabled ? "#fafafa" : "#fff"), focused === el ? "#101010" : BORDER);
      let v = String(el.value ?? "");
      if (t === "password") v = "•".repeat(v.length);
      const ph = !v && el.placeholder;
      const caret = focused === el ? "|" : "";
      if (t === "textarea") {
        c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
        c.fillStyle = ph ? "#757575" : fg; c.textBaseline = "top"; c.textAlign = "left";
        String(ph || v + caret).split("\n").forEach((line, i) => c.fillText(line, x + 3, y + 3 + i * f.size * 1.2));
        c.restore();
      } else textIn(c, ph ? String(el.placeholder) : v + caret, x, y, w, h, "left", ph ? "#757575" : fg);
    }
  };

  __powerboat.tickUi = () => {
    if (!forms.size) return;
    const els = visible();
    if (!els.length) {
      if (on) { ops.op_ui_overlay(0, 0, 0, new Float32Array(0)); on = false; lastSig = ""; }
      return;
    }
    const b = canvasBox(), v = view();
    const sig = sigOf(els) + JSON.stringify([b, v]);
    if (sig === lastSig) return;
    lastSig = sig;
    // Painted at the window resolution of the game rect, in the canvas box's CSS coordinates.
    const W = Math.max(1, Math.round(v.w)), H = Math.max(1, Math.round(v.h));
    const kx = W / b.w, ky = H / b.h;
    if (!canvas) { canvas = baseCreate.call(document, "canvas"); ctx = canvas.getContext("2d"); }
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(kx, 0, 0, ky, -b.x * kx, -b.y * ky);
    const rects = [];
    for (const el of els) {
      try { paint(ctx, el); } catch (e) { __powerboat.reportError(e); }
      const [x, y, w, h] = rectOf(el);
      rects.push(x - b.x, y - b.y, w, h);
    }
    if (debug) console.log("forms: box " + JSON.stringify(b) + " view " + JSON.stringify(v) + " rects " + JSON.stringify(rects));
    ops.op_ui_overlay(canvas._powerboatCanvasId, b.w, b.h, new Float32Array(rects));
    on = true;
  };

  // ---- the canvas box: where the page has the game canvas, where the window shows it -------------
  // Construct places elements and reads the pointer against the canvas's getBoundingClientRect
  // (00_env.js: at 0,0, its backing size), whatever CSS box it letterboxes the canvas into (BOD
  // EFSANESI: 427x240 with 170,96 margins in 768x432); the runtime shows the canvas fitted to the
  // whole window. So that rect is the box both overlay and pointer map through.
  const mainCanvas = () => { const m = __powerboat.mainCanvas; return typeof m === "function" ? m() : m; };
  // Boxes are a class, not {x, y, w, h} literals: those share one V8 shape with every 4-property game object whose
  // keys start x, y, and the fractional values here would make its x and y boxed doubles (00_env.js PointerState).
  class Box { constructor(x, y, w, h) { this.x = x; this.y = y; this.w = w; this.h = h; } }
  const canvasBox = () => {
    const c = mainCanvas();
    const r = c && typeof c.getBoundingClientRect === "function" ? c.getBoundingClientRect() : null;
    if (!r || !(r.width > 0) || !(r.height > 0)) return new Box(0, 0, Math.max(1, g.innerWidth), Math.max(1, g.innerHeight));
    return new Box(r.left, r.top, r.width, r.height);
  };
  // The game rect in window pixels (gl.rs present: the canvas fitted, centered).
  const view = () => {
    const c = mainCanvas(), W = g.innerWidth, H = g.innerHeight;
    const cw = (c && c.width) || W, ch = (c && c.height) || H;
    const fit = Math.min(W / cw, H / ch), w = cw * fit, h = ch * fit;
    return new Box((W - w) / 2, (H - h) / 2, w, h);
  };
  // Window fractions (SDL's mouse) -> page CSS pixels through the canvas box, so that the page sees
  // the pointer where the window shows it (00_env.js mouse events).
  __powerboat.pagePoint = (fx, fy) => {
    const b = canvasBox(), v = view();
    return [b.x + ((fx * g.innerWidth - v.x) / v.w) * b.w, b.y + ((fy * g.innerHeight - v.y) / v.h) * b.h];
  };

  // ---- input ------------------------------------------------------------------------------------
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  // Topmost visible element under a page point (the last painted wins, as later DOM order does).
  __powerboat.hitTarget = (x, y, type) => {
    if (!forms.size) return null;
    let hit = null;
    for (const el of visible()) {
      const [ex, ey, ew, eh] = rectOf(el);
      if (x >= ex && x < ex + ew && y >= ey && y < ey + eh) hit = el;
    }
    if (type === "pointerdown" || type === "mousedown") {
      if (type === "pointerdown") {
        pressed = hit && !hit.disabled ? hit : null;
        const f = hit && /^(text|password|number|email|search|url|tel|textarea)$/.test(kind(hit)) ? hit : null;
        if (f !== focused) { if (focused) fire(focused, "blur"); focused = f; if (f) fire(f, "focus"); }
      }
    }
    if (debug && (type === "pointerdown" || type === "click")) console.log("forms: " + type + " at " + x.toFixed(1) + "," + y.toFixed(1) + " -> " + (hit ? kind(hit) + " " + JSON.stringify(rectOf(hit)) : "none"));
    if (type === "click" && hit && !hit.disabled) act(hit, x, y);
    if (type === "pointerup") pressed = null;
    return hit;
  };
  // What a browser does on a click, before the page's own click listener runs.
  const act = (el, x, y) => {
    const t = kind(el), [ex, ey, ew, eh] = rectOf(el);
    if (t === "checkbox") { el.checked = !el.checked; fire(el, "input"); fire(el, "change"); }
    else if (t === "range") {
      const min = px(el.min, 0), max = px(el.max, 100), step = px(el.step, 1) || 1;
      let v = min + Math.min(1, Math.max(0, (x - ex) / Math.max(1, ew))) * (max - min);
      v = Math.round((v - min) / step) * step + min;
      el.value = String(v); fire(el, "input"); fire(el, "change");
    } else if (t === "select") {
      if (el.size > 1 || el.multiple) {
        const rh = Math.max(12, Math.round(fontOf(el).size * 1.25)), i = Math.floor((y - ey - 1) / rh);
        if (i >= 0 && i < el.options.length && i !== el.selectedIndex) { el.selectedIndex = i; fire(el, "change"); }
      } else if (el.options.length) {
        // No dropdown to open: a click steps to the next option.
        el.selectedIndex = (el.selectedIndex + 1) % el.options.length; fire(el, "change");
      }
    }
  };
  // Typing into the focused text box (keyboard or gptokeyb's keys).
  g.addEventListener("keydown", (e) => {
    const el = focused;
    if (!el || el.disabled || el.readOnly || !forms.has(el)) return;
    let v = String(el.value ?? "");
    if (e.key === "Backspace") v = v.slice(0, -1);
    else if (e.key === "Enter" && kind(el) === "textarea") v += "\n";
    else if (e.key === "Escape") { fire(el, "blur"); focused = null; return; }
    else if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      if (el.maxLength > 0 && v.length >= el.maxLength) return;
      v += e.key;
    } else { el.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, code: e.code, keyCode: e.keyCode })); return; }
    el.value = v;
    fire(el, "input");
  });
})();
