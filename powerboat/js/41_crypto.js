// powerboat JS environment, part 4b: Web Crypto's random part (crypto.getRandomValues, crypto.randomUUID) from
// the OS random source. Without it, seedrandom (Cookie Clicker and other games) seeds itself by flattening the
// whole window object three levels deep: tens of milliseconds per call, and Cookie Clicker reseeds in every
// building row draw.
"use strict";
(() => {
  const ops = Deno.core.ops, g = globalThis;
  const INTS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array];
  const domErr = (name, msg) => (typeof DOMException === "function" ? new DOMException(msg, name) : Object.assign(new Error(msg), { name }));
  function getRandomValues(a) {
    if (!INTS.some((T) => a instanceof T)) throw domErr("TypeMismatchError", "getRandomValues: an integer typed array is needed");
    if (a.byteLength > 65536) throw domErr("QuotaExceededError", "getRandomValues: at most 65536 bytes");
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    if (!ops.op_powerboat_random_bytes(b)) throw domErr("OperationError", "getRandomValues: /dev/urandom unreadable");
    return a;
  }
  function randomUUID() {
    const b = getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  const c = g.crypto && typeof g.crypto === "object" ? g.crypto : {};
  if (typeof c.getRandomValues !== "function") c.getRandomValues = getRandomValues;
  if (typeof c.randomUUID !== "function") c.randomUUID = randomUUID;
  if (g.crypto !== c) Object.defineProperty(g, "crypto", { value: c, configurable: true, enumerable: true, writable: true });
})();
