// Listening test for the Web Audio mixer (src/audio.rs): one short scene per feature, each labeled on screen with what
// you should hear. Scenes advance by themselves; Left/Right go back or on, A (or Enter) plays the scene again.
// Run: powerboat --game tests/audio-demo (a plain 2D GameCanvas, as MV's canvas renderer: no page mode)
"use strict";
const ctx = new AudioContext();
const RATE = ctx.sampleRate;
const SCENE_SECONDS = 7;

// The test music: a plucked arpeggio with a soft tick on every note, two seconds, looped.
function makeMusic() {
  const seconds = 2;
  const b = ctx.createBuffer(2, Math.round(RATE * seconds), RATE);
  const left = b.getChannelData(0), right = b.getChannelData(1);
  const notes = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63, 261.63, 196.0];
  const step = seconds / notes.length;
  let seed = 7;
  notes.forEach((f, n) => {
    const start = Math.round(n * step * RATE), len = Math.round(step * RATE);
    for (let i = 0; i < len; i++) {
      const t = i / RATE, env = Math.exp(-t * 6);
      const v = 0.2 * env * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t));
      left[start + i] += v; right[start + i] += v;
    }
    for (let i = 0; i < Math.round(0.03 * RATE); i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = 0.08 * (seed / 0x7fffffff - 0.5) * Math.exp(-i / RATE * 120);
      left[start + i] += v; right[start + i] += v;
    }
  });
  return b;
}
const music = makeMusic();

// Everything goes through one bus, so a scene change can fade out cleanly.
const bus = ctx.createGain();
bus.connect(ctx.destination);

function loop(into, setup) {
  const s = ctx.createBufferSource();
  s.buffer = music; s.loop = true;
  if (setup) setup(s);
  s.connect(into);
  s.start();
  return s;
}
function lfo(hz, depth, target, type) {
  const o = ctx.createOscillator(); o.frequency.value = hz; if (type) o.type = type;
  const g = ctx.createGain(); g.gain.value = depth;
  o.connect(g); g.connect(target); o.start();
  return o;
}
const gain = (v, to) => { const g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };

// Each scene builds its graph into `out` and returns what to stop when it ends.
const scenes = [
  { title: "Reference", hear: "The test music with no effect. Compare the scenes after it with this one.",
    play(out) { return [loop(out)]; } },
  { title: "Filter: lowpass 800 Hz", hear: "Muffled, as if through a wall. The ticks lose their edge.",
    play(out) { const f = ctx.createBiquadFilter(); f.frequency.value = 800; f.connect(out); return [loop(f)]; } },
  { title: "Filter at 50% mix", hear: "Half muffled, half clear. Before this mixer change, it played at half volume, all muffled.",
    play(out) {
      const f = ctx.createBiquadFilter(); f.frequency.value = 800;
      const wet = gain(0.5, out), dry = gain(0.5, out); f.connect(wet);
      const s = loop(dry); s.connect(f); return [s];
    } },
  { title: "Delay: echoes", hear: "Each note repeats every 0.3 s, quieter each time.",
    play(out) {
      const input = gain(1, out), d = ctx.createDelay(1), back = gain(0.5), wet = gain(0.6, out);
      d.delayTime.value = 0.3; input.connect(d); d.connect(back); back.connect(d); d.connect(wet);
      return [loop(input)];
    } },
  { title: "Flanger", hear: "A slow swoosh, like a jet passing, sweeping up and down.",
    play(out) {
      const input = gain(0.6, out), d = ctx.createDelay(0.05), back = gain(0.6), wet = gain(0.6, out);
      d.delayTime.value = 0.005; input.connect(d); d.connect(back); back.connect(d); d.connect(wet);
      return [loop(input), lfo(0.3, 0.004, d.delayTime)];
    } },
  { title: "Phaser", hear: "A softer, hollow sweep moving through the sound.",
    play(out) {
      const input = gain(0.6, out), wet = gain(0.6, out);
      let last = input;
      const stops = [];
      for (let k = 0; k < 4; k++) {
        const f = ctx.createBiquadFilter(); f.type = "allpass"; f.frequency.value = 900; f.Q.value = 2;
        last.connect(f); last = f;
        stops.push(lfo(0.4, 700, f.frequency));
      }
      last.connect(wet);
      return [loop(input), ...stops];
    } },
  { title: "Tremolo", hear: "The volume pulses five times a second.",
    play(out) { const g = gain(0.6, out); return [loop(g), lfo(5, 0.4, g.gain)]; } },
  { title: "Ring modulation", hear: "Metallic and robotic: every note splits into two off-key tones.",
    play(out) { const g = gain(0, out); return [loop(g), lfo(60, 1, g.gain)]; } },
  { title: "Oscillators", hear: "Four tones at 440 Hz: sine (pure), square (hollow), sawtooth (buzzy), triangle (soft).",
    play(out) {
      return ["sine", "square", "sawtooth", "triangle"].map((type, k) => {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = 440;
        o.connect(gain(type === "sine" || type === "triangle" ? 0.35 : 0.2, out));
        const t = ctx.currentTime + 0.25 + k * 1.6; o.start(t); o.stop(t + 1.3);
        return o;
      });
    } },
  { title: "Oscillator sweep", hear: "A tone gliding from low to high, then back down.",
    play(out) {
      const o = ctx.createOscillator(), t = ctx.currentTime + 0.25;
      o.frequency.setValueAtTime(100, t); o.frequency.exponentialRampToValueAtTime(3000, t + 3); o.frequency.exponentialRampToValueAtTime(100, t + 6);
      o.connect(gain(0.3, out)); o.start(t); o.stop(t + 6.2);
      return [o];
    } },
  { title: "Detune", hear: "The music an octave up, then normal, then an octave down.",
    play(out) {
      const t = ctx.currentTime;
      return [loop(out, (s) => { s.detune.setValueAtTime(1200, t); s.detune.setValueAtTime(0, t + 2.3); s.detune.setValueAtTime(-1200, t + 4.6); })];
    } },
  { title: "Panning, RPG Maker style", hear: "Left, then center, then right. RPG Maker games pan this way; it should sound as before.",
    play(out) {
      const p = ctx.createPanner(); p.connect(out);
      const steps = [-1, 0, 1], t = ctx.currentTime;
      steps.forEach((pan, k) => {
        const x = pan, z = 1 - Math.abs(pan);
        p.positionX.setValueAtTime(x, t + k * 2.3); p.positionZ.setValueAtTime(z, t + k * 2.3);
      });
      return [loop(p)];
    } },
  { title: "A sound circling you", hear: "It moves left, in front, right and behind you, around and around.",
    play(out) {
      const p = ctx.createPanner(); p.connect(gain(2, out));
      const t = ctx.currentTime;
      for (let i = 0; i <= 140; i++) {
        const a = i / 140 * 4 * Math.PI;
        p.positionX.setValueAtTime(-3 * Math.cos(a), t + i * 0.05); p.positionZ.setValueAtTime(-3 * Math.sin(a), t + i * 0.05);
      }
      return [loop(p)];
    } },
  { title: "A sound passing by", hear: "Far away on the left, loud as it passes in front of you, fading away on the right.",
    play(out) {
      const p = ctx.createPanner(); p.refDistance = 2; p.connect(gain(1.5, out));
      p.positionZ.value = -2;
      const t = ctx.currentTime;
      p.positionX.setValueAtTime(-40, t); p.positionX.linearRampToValueAtTime(40, t + SCENE_SECONDS);
      return [loop(p)];
    } },
];

let current = -1, sceneStart = 0, stops = [], shown = 0;
// Fade out, stop the old scene's sources, then start the new one, unless another press came first.
function show(k) {
  bus.gain.cancelScheduledValues(0);
  bus.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
  const old = stops;
  stops = [];
  setTimeout(() => {
    for (const n of old) { try { n.stop(); } catch (_) {} try { n.disconnect(); } catch (_) {} }
  }, 120);
  current = (k + scenes.length) % scenes.length;
  sceneStart = performance.now();
  const mine = ++shown;
  setTimeout(() => {
    if (mine !== shown) return;
    const out = ctx.createGain();
    out.connect(bus);
    stops = scenes[current].play(out);
    bus.gain.cancelScheduledValues(0);
    bus.gain.setTargetAtTime(0.8, ctx.currentTime, 0.02);
  }, 130);
}

// ---- drawing and input
// Made by script, as MV makes its GameCanvas: the runtime runs a plain game's scripts without building the page.
const canvas = document.getElementById("GameCanvas") || document.createElement("canvas");
canvas.id = "GameCanvas"; canvas.width = 640; canvas.height = 480;
if (!canvas.parentNode) document.body.appendChild(canvas);
const g2 = canvas.getContext("2d");
function wrap(text, x, y, width, lineHeight) {
  const words = text.split(" ");
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (g2.measureText(test).width > width && line) { g2.fillText(line, x, y); y += lineHeight; line = w; } else line = test;
  }
  if (line) g2.fillText(line, x, y);
}
function draw() {
  const s = scenes[current];
  const done = Math.min(1, (performance.now() - sceneStart) / (SCENE_SECONDS * 1000));
  g2.fillStyle = "#101418"; g2.fillRect(0, 0, 640, 480);
  g2.fillStyle = "#7a8794"; g2.font = "20px sans-serif";
  g2.fillText(`Mixer test   ${current + 1} / ${scenes.length}`, 32, 48);
  g2.fillStyle = "#ffffff"; g2.font = "bold 34px sans-serif";
  g2.fillText(s.title, 32, 120);
  g2.fillStyle = "#d6dde4"; g2.font = "24px sans-serif";
  wrap(s.hear, 32, 180, 576, 34);
  g2.fillStyle = "#26313b"; g2.fillRect(32, 380, 576, 10);
  g2.fillStyle = "#4fa3e0"; g2.fillRect(32, 380, 576 * done, 10);
  g2.fillStyle = "#7a8794"; g2.font = "18px sans-serif";
  g2.fillText("Left / Right: previous / next     A: play again     Select + Start: quit", 32, 440);
}
const held = {};
function pressed(name, down) {
  const was = held[name];
  held[name] = down;
  return down && !was;
}
function frame() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = [...pads].find((p) => p && p.connected);
  const b = (i) => !!(pad && pad.buttons[i] && pad.buttons[i].pressed);
  const axis = pad && pad.axes ? pad.axes[0] || 0 : 0;
  if (pressed("next", b(15) || axis > 0.6 || keys.ArrowRight)) show(current + 1);
  if (pressed("prev", b(14) || axis < -0.6 || keys.ArrowLeft)) show(current - 1);
  if (pressed("again", b(0) || keys.Enter || keys.KeyZ)) show(current);
  if (performance.now() - sceneStart > SCENE_SECONDS * 1000) show(current + 1);
  draw();
  requestAnimationFrame(frame);
}
const keys = {};
addEventListener("keydown", (e) => { keys[e.code] = true; });
addEventListener("keyup", (e) => { keys[e.code] = false; });
show(0);
requestAnimationFrame(frame);
console.log("audio demo: " + scenes.length + " scenes");
