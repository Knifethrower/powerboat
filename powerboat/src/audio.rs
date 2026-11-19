//! Web Audio: a small push-model mixer in the SDL audio callback. MV's graph per sound is
//! BufferSource -> Gain -> Panner -> destination (never disconnected: the Servo route's
//! audio-thread leak), so the mixer pushes each live source down its outputs and accumulates into
//! the output; nodes nobody feeds cost nothing, finished sources retire themselves. Buffer PCM lives
//! in V8 ArrayBuffer backing stores created from Rust (decoded once, readable by JS through
//! getChannelData and by the mixer thread without a copy).
//!
//! Gains and pans are linear, so each source goes through them on its own, in place; a node with
//! several outputs copies the block for each. Filters and delays have state, so they collect what
//! reaches them and run once per pass (Mixer::pass). A delay plays its past first and takes its input
//! last, which is what makes a feedback loop safe: a walk stops at it. Graphs with any of those, with
//! oscillators or with modulated params run in QUANTUM-sized passes; plain graphs in one per callback.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::rc::Rc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock, Weak};

use deno_core::{op2, v8, OpState};
use deno_error::JsErrorBox;
use sdl2::audio::{AudioCallback, AudioDevice, AudioSpecDesired};
use symphonia::core::audio::{Audio as SymAudio, GenericAudioBufferRef};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::formats::probe::Hint;
use symphonia::core::codecs::audio::AudioDecoder;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::units::{TimeBase, Timestamp};
use symphonia::core::meta::MetadataOptions;

use crate::ops::App;

pub const BLOCK: usize = 1024;
/// Frames per pass when the graph needs more than one per callback, as in browsers: a delay in a feedback
/// loop cannot be shorter than this, and modulation reaches a param one pass late.
const QUANTUM: usize = 128;
/// The longest delay line: seconds of stereo memory on a 1 GB handheld. createDelay's own limit is 180 s.
const MAX_DELAY: f64 = 10.0;
/// The one AudioListener, a node of its own so that its params work like any other (Kind::param).
const LISTENER: u32 = 1;

// ---- buffers ----------------------------------------------------------------------------------

/// One channel of samples: f32 owned by a V8 backing store (shared with JS) or still a Vec until
/// JS first asks for it; decoded files are kept as i16 (half the memory: an 82 s stereo BGM is
/// 14 MB instead of 29) and become f32 only if JS reads them (getChannelData), which MV never does.
enum Channel {
    Pending(Vec<f32>),
    Shared(v8::SharedRef<v8::BackingStore>),
    Pcm16(Arc<Vec<i16>>),
}

/// A channel as the mixer thread reads it.
enum ChanRef {
    F32(v8::SharedRef<v8::BackingStore>),
    I16(Arc<Vec<i16>>),
}

pub struct AudioBuf {
    pub rate: u32,
    pub frames: usize,
    channels: Vec<Channel>,
    /// A long file kept compressed (channels empty until JS reads the samples).
    packed: Option<Arc<Packed>>,
}

/// What the mixer thread reads: the backing stores (refcounted, thread-safe) of every channel.
struct BufRef {
    rate: u32,
    frames: usize,
    stores: Vec<ChanRef>,
    packed: Option<Arc<Packed>>,
}

impl BufRef {
    #[inline]
    fn sample(&self, ch: usize, i: usize) -> f32 {
        let ch = ch.min(self.stores.len().saturating_sub(1));
        let Some(store) = self.stores.get(ch) else { return 0.0 };
        if i >= self.frames {
            return 0.0;
        }
        match store {
            ChanRef::F32(store) => match store.data() {
                Some(p) => unsafe { *(p.as_ptr() as *const f32).add(i) },
                None => 0.0,
            },
            ChanRef::I16(v) => v.get(i).map(|s| *s as f32 * (1.0 / 32768.0)).unwrap_or(0.0),
        }
    }
}

pub fn to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

fn to_pcm16(mut v: Vec<i16>) -> Channel {
    v.shrink_to_fit();
    Channel::Pcm16(Arc::new(v))
}

// ---- params -----------------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum EvKind {
    Set,
    Linear,
    Exp,
}

#[derive(Clone)]
struct ParamEv {
    time: f64,
    value: f32,
    kind: EvKind,
}

#[derive(Clone)]
struct Param {
    value: f32,
    events: Vec<ParamEv>,
    /// What other nodes feed this param (node.connect(param)).
    modulation: Option<Box<Modulation>>,
}

/// A param's input, mono, added to its value: `now` is what arrived during the last pass, `next` is filling up.
#[derive(Clone)]
struct Modulation {
    now: Vec<f32>,
    next: Vec<f32>,
}

impl Param {
    fn new(v: f32) -> Param {
        Param { value: v, events: Vec::new(), modulation: None }
    }
    /// The param's input at frame i of this pass.
    #[inline]
    fn input(&self, i: usize) -> f32 {
        self.modulation.as_ref().map_or(0.0, |m| m.now.get(i).copied().unwrap_or(0.0))
    }
    fn push(&mut self, ev: ParamEv) {
        self.events.push(ev);
        self.events.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    }
    fn cancel(&mut self, t: f64) {
        self.events.retain(|e| e.time < t);
    }
    /// Value at time t; the value before any event is `value`.
    fn at(&self, t: f64) -> f32 {
        let mut v = self.value;
        let mut vt = f64::NEG_INFINITY;
        for (i, e) in self.events.iter().enumerate() {
            if e.time <= t {
                v = e.value;
                vt = e.time;
                // A ramp ends here; its start was the previous value.
                continue;
            }
            // e is the first event after t: if it is a ramp, interpolate from (vt, v) to it.
            match e.kind {
                EvKind::Linear | EvKind::Exp => {
                    let t0 = if vt.is_finite() { vt } else { t };
                    let span = e.time - t0;
                    if span <= 0.0 {
                        return e.value;
                    }
                    let k = ((t - t0) / span).clamp(0.0, 1.0) as f32;
                    return match e.kind {
                        EvKind::Exp if v > 0.0 && e.value > 0.0 => v * (e.value / v).powf(k),
                        _ => v + (e.value - v) * k,
                    };
                }
                EvKind::Set => {
                    let _ = i;
                    return v;
                }
            }
        }
        v
    }
    /// Drops events that are over (keeps the last one as the base value).
    fn prune(&mut self, t: f64) {
        while self.events.len() > 1 && self.events[1].time <= t {
            let e = self.events.remove(0);
            self.value = e.value;
        }
        if self.events.len() == 1 && self.events[0].time <= t - 1.0 {
            self.value = self.events[0].value;
            self.events.clear();
        }
    }
}

// ---- nodes ------------------------------------------------------------------------------------

enum Kind {
    Gain(Param),
    Panner(Box<Panner>),
    StereoPanner(Param),
    Pass,
    Source(Source),
    Delay(Box<Delay>),
    Filter(Box<Filter>),
    Oscillator(Box<Oscillator>),
    Listener(Box<[Param; 9]>),
}

impl Kind {
    /// A mixer param by JS's slot (js/50_audio.js). Other params live in JS.
    fn param(&mut self, slot: u32) -> Option<&mut Param> {
        let i = slot as usize;
        match (self, slot) {
            (Kind::Gain(p), 0) | (Kind::StereoPanner(p), 0) => Some(p),
            (Kind::Source(s), 0) => Some(&mut s.rate),
            (Kind::Source(s), 1) => Some(&mut s.detune),
            (Kind::Panner(p), 0..=2) => Some(&mut p.position[i]),
            (Kind::Panner(p), 3..=5) => Some(&mut p.orientation[i - 3]),
            (Kind::Delay(d), 0) => Some(&mut d.time),
            (Kind::Filter(f), 0) => Some(&mut f.frequency),
            (Kind::Filter(f), 1) => Some(&mut f.q),
            (Kind::Filter(f), 2) => Some(&mut f.gain),
            (Kind::Filter(f), 3) => Some(&mut f.detune),
            (Kind::Oscillator(o), 0) => Some(&mut o.frequency),
            (Kind::Oscillator(o), 1) => Some(&mut o.detune),
            (Kind::Listener(l), 0..=8) => Some(&mut l[i]),
            _ => None,
        }
    }
}

struct Source {
    buf: Option<Arc<BufRef>>,
    looping: bool,
    loop_start: f64,
    loop_end: f64,
    rate: Param,
    /// Cents, on top of `rate`.
    detune: Param,
    /// Absolute context time to start at, with buffer offset in seconds.
    start_at: Option<(f64, f64)>,
    stop_at: Option<f64>,
    duration: Option<f64>,
    /// Position in buffer frames (fractional); None until started.
    pos: Option<f64>,
    played: f64,
    ended: bool,
}

impl Source {
    fn new() -> Source {
        Source {
            buf: None,
            looping: false,
            loop_start: 0.0,
            loop_end: 0.0,
            rate: Param::new(1.0),
            detune: Param::new(0.0),
            start_at: None,
            stop_at: None,
            duration: None,
            pos: None,
            played: 0.0,
            ended: false,
        }
    }
}

// ---- spatial ----------------------------------------------------------------------------------

type Vec3 = [f32; 3];

fn dot(a: Vec3, b: Vec3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn normalized(a: Vec3) -> Vec3 {
    let len = dot(a, a).sqrt();
    if len > 0.0 { [a[0] / len, a[1] / len, a[2] / len] } else { [0.0; 3] }
}

/// PannerNode: pan and level from where it is relative to the listener. Web Audio's equal-power panning,
/// distance models and sound cone. MV's setPosition(pan, 0, 1 - |pan|) stays within refDistance of a listener
/// at the origin, so it pans as asked with no change in level.
struct Panner {
    position: [Param; 3],
    orientation: [Param; 3],
    /// 0 inverse, 1 linear, 2 exponential.
    distance_model: u32,
    ref_distance: f32,
    max_distance: f32,
    rolloff: f32,
    cone_inner: f32,
    cone_outer: f32,
    cone_outer_gain: f32,
}

impl Panner {
    fn new() -> Panner {
        Panner {
            position: [Param::new(0.0), Param::new(0.0), Param::new(0.0)],
            orientation: [Param::new(1.0), Param::new(0.0), Param::new(0.0)],
            distance_model: 0,
            ref_distance: 1.0,
            max_distance: 10000.0,
            rolloff: 1.0,
            cone_inner: 360.0,
            cone_outer: 360.0,
            cone_outer_gain: 0.0,
        }
    }
    fn distance_gain(&self, distance: f32) -> f32 {
        let reference = self.ref_distance.max(0.0);
        match self.distance_model {
            1 => {
                let span = self.max_distance - reference;
                if span <= 0.0 {
                    return 1.0 - self.rolloff.clamp(0.0, 1.0) * if distance > reference { 1.0 } else { 0.0 };
                }
                1.0 - self.rolloff.clamp(0.0, 1.0) * (distance.clamp(reference, self.max_distance) - reference) / span
            }
            2 if reference > 0.0 => (distance.max(reference) / reference).powf(-self.rolloff.max(0.0)),
            2 => 0.0,
            _ => {
                let below = reference + self.rolloff.max(0.0) * (distance.max(reference) - reference);
                if below > 0.0 { reference / below } else { 0.0 }
            }
        }
    }
    fn cone_gain(&self, to_listener: Vec3, facing: Vec3) -> f32 {
        if (self.cone_inner >= 360.0 && self.cone_outer >= 360.0) || dot(facing, facing) == 0.0 {
            return 1.0;
        }
        let angle = dot(normalized(to_listener), normalized(facing)).clamp(-1.0, 1.0).acos().to_degrees().abs();
        let (inner, outer) = (self.cone_inner.abs() / 2.0, self.cone_outer.abs() / 2.0);
        if angle <= inner {
            1.0
        } else if angle >= outer || outer <= inner {
            self.cone_outer_gain
        } else {
            1.0 + (angle - inner) / (outer - inner) * (self.cone_outer_gain - 1.0)
        }
    }
    /// (pan in [-1, 1], level) at time t, for a listener as read by Mixer::listener_at.
    fn spatial(&mut self, listener: &[f32; 9], t: f64) -> (f32, f32) {
        let at = |p: &[Param; 3]| [p[0].at(t), p[1].at(t), p[2].at(t)];
        let (position, facing) = (at(&self.position), at(&self.orientation));
        for p in self.position.iter_mut().chain(self.orientation.iter_mut()) {
            p.prune(t);
        }
        let from_listener = [position[0] - listener[0], position[1] - listener[1], position[2] - listener[2]];
        let forward = normalized([listener[3], listener[4], listener[5]]);
        let right = normalized(cross(forward, [listener[6], listener[7], listener[8]]));
        let az = dot(from_listener, right).atan2(dot(from_listener, forward)).to_degrees();
        let az = if az < -90.0 { -180.0 - az } else if az > 90.0 { 180.0 - az } else { az };
        let to_listener = [-from_listener[0], -from_listener[1], -from_listener[2]];
        ((az / 90.0).clamp(-1.0, 1.0), self.distance_gain(dot(from_listener, from_listener).sqrt()) * self.cone_gain(to_listener, facing))
    }
}

// ---- delay ------------------------------------------------------------------------------------

/// DelayNode: a ring of stereo frames. Plays first and takes its input last in a pass, so its shortest delay is
/// one quantum, in or out of a feedback loop.
struct Delay {
    time: Param,
    ring: Vec<f32>,
    /// Frame the next input goes to.
    write: usize,
    max_frames: f64,
    input: Vec<f32>,
    has_input: bool,
    /// Frames until the ring has only silence in it: it stops costing anything then.
    tail: usize,
}

impl Delay {
    fn new(max_seconds: f64, rate: f64) -> Delay {
        let max_frames = (max_seconds.clamp(0.0, MAX_DELAY) * rate).ceil().max(QUANTUM as f64);
        let frames = max_frames as usize + QUANTUM + 2;
        Delay { time: Param::new(0.0), ring: vec![0.0; frames * 2], write: 0, max_frames, input: vec![0.0; QUANTUM * 2], has_input: false, tail: 0 }
    }
    /// The delayed signal for this pass; false when there is nothing left in the ring.
    fn play(&mut self, block: &mut [f32], t0: f64, t1: f64, rate: f64) -> bool {
        if self.tail == 0 {
            return false;
        }
        let frames = block.len() / 2;
        let len = self.ring.len() / 2;
        let (d0, d1) = (self.time.at(t0) as f64 * rate, self.time.at(t1) as f64 * rate);
        self.time.prune(t0);
        for (i, fr) in block.chunks_exact_mut(2).enumerate() {
            let delay = d0 + (d1 - d0) * i as f64 / frames as f64 + self.time.input(i) as f64 * rate;
            let back = (self.write + i + len) as f64 - delay.clamp(frames as f64, self.max_frames);
            let i0 = back as usize;
            let frac = (back - i0 as f64) as f32;
            let (a, b) = (i0 % len * 2, (i0 + 1) % len * 2);
            fr[0] = self.ring[a] * (1.0 - frac) + self.ring[b] * frac;
            fr[1] = self.ring[a + 1] * (1.0 - frac) + self.ring[b + 1] * frac;
        }
        true
    }
    fn take_input(&mut self, frames: usize) {
        let len = self.ring.len() / 2;
        if self.has_input {
            self.tail = len;
        }
        if self.tail == 0 {
            return;
        }
        for i in 0..frames {
            let w = (self.write + i) % len * 2;
            // A feedback gain above 1 must not end in infinities that never leave the ring.
            let safe = |v: f32| if v.is_finite() { v.clamp(-32.0, 32.0) } else { 0.0 };
            self.ring[w] = safe(self.input[i * 2]);
            self.ring[w + 1] = safe(self.input[i * 2 + 1]);
        }
        self.write = (self.write + frames) % len;
        if self.has_input {
            self.input[..frames * 2].fill(0.0);
            self.has_input = false;
        } else {
            self.tail = self.tail.saturating_sub(frames);
        }
    }
}

// ---- filter -----------------------------------------------------------------------------------

/// BiquadFilterNode, with the coefficients of the Web Audio spec. Input is collected, then filtered once per pass.
struct Filter {
    /// lowpass, highpass, bandpass, lowshelf, highshelf, peaking, notch, allpass.
    kind: u32,
    frequency: Param,
    q: Param,
    gain: Param,
    detune: Param,
    /// What the coefficients were made from.
    made_from: (u32, f32, f32, f32),
    /// b0, b1, b2, a1, a2 (a0 divided out).
    coef: [f64; 5],
    /// Transposed direct form II, per channel.
    state: [[f64; 2]; 2],
    input: Vec<f32>,
    has_input: bool,
}

impl Filter {
    fn new() -> Filter {
        Filter {
            kind: 0,
            frequency: Param::new(350.0),
            q: Param::new(1.0),
            gain: Param::new(0.0),
            detune: Param::new(0.0),
            made_from: (u32::MAX, 0.0, 0.0, 0.0),
            coef: [1.0, 0.0, 0.0, 0.0, 0.0],
            state: [[0.0; 2]; 2],
            input: vec![0.0; QUANTUM * 2],
            has_input: false,
        }
    }
    /// Web Audio spec, "Filters characteristics". f in Hz, gain in dB; q is in dB for lowpass and highpass only.
    fn coefficients(kind: u32, f: f64, q: f64, gain: f64, rate: f64) -> [f64; 5] {
        let w0 = 2.0 * std::f64::consts::PI * f.clamp(1.0, rate * 0.4999) / rate;
        let (sin, cos) = w0.sin_cos();
        let a = 10f64.powf(gain / 40.0);
        let alpha_q = sin / (2.0 * q.max(1e-4));
        let alpha_db = sin / (2.0 * 10f64.powf(q / 20.0));
        // Shelf slope S = 1.
        let alpha_s = sin / 2.0 * std::f64::consts::SQRT_2;
        let root = 2.0 * alpha_s * a.sqrt();
        let (b0, b1, b2, a0, a1, a2) = match kind {
            0 => ((1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0, 1.0 + alpha_db, -2.0 * cos, 1.0 - alpha_db),
            1 => ((1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0, 1.0 + alpha_db, -2.0 * cos, 1.0 - alpha_db),
            2 => (alpha_q, 0.0, -alpha_q, 1.0 + alpha_q, -2.0 * cos, 1.0 - alpha_q),
            3 => (
                a * ((a + 1.0) - (a - 1.0) * cos + root),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                a * ((a + 1.0) - (a - 1.0) * cos - root),
                (a + 1.0) + (a - 1.0) * cos + root,
                -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                (a + 1.0) + (a - 1.0) * cos - root,
            ),
            4 => (
                a * ((a + 1.0) + (a - 1.0) * cos + root),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                a * ((a + 1.0) + (a - 1.0) * cos - root),
                (a + 1.0) - (a - 1.0) * cos + root,
                2.0 * ((a - 1.0) - (a + 1.0) * cos),
                (a + 1.0) - (a - 1.0) * cos - root,
            ),
            5 => (1.0 + alpha_q * a, -2.0 * cos, 1.0 - alpha_q * a, 1.0 + alpha_q / a, -2.0 * cos, 1.0 - alpha_q / a),
            6 => (1.0, -2.0 * cos, 1.0, 1.0 + alpha_q, -2.0 * cos, 1.0 - alpha_q),
            _ => (1.0 - alpha_q, -2.0 * cos, 1.0 + alpha_q, 1.0 + alpha_q, -2.0 * cos, 1.0 - alpha_q),
        };
        [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
    }
    /// The filtered input for this pass; false when it has no input and has rung out.
    fn run(&mut self, block: &mut [f32], t0: f64, rate: f64) -> bool {
        let quiet = self.state.iter().flatten().all(|z| z.abs() < 1e-9);
        if !self.has_input && quiet {
            self.state = [[0.0; 2]; 2];
            return false;
        }
        let middle = block.len() / 4;
        let f = self.frequency.at(t0) + self.frequency.input(middle);
        let cents = self.detune.at(t0) + self.detune.input(middle);
        let (q, gain) = (self.q.at(t0) + self.q.input(middle), self.gain.at(t0) + self.gain.input(middle));
        for p in [&mut self.frequency, &mut self.q, &mut self.gain, &mut self.detune] {
            p.prune(t0);
        }
        let hz = f * (cents as f64 / 1200.0).exp2() as f32;
        if self.made_from != (self.kind, hz, q, gain) {
            self.made_from = (self.kind, hz, q, gain);
            self.coef = Filter::coefficients(self.kind, hz as f64, q as f64, gain as f64, rate);
        }
        let [b0, b1, b2, a1, a2] = self.coef;
        for (fr, input) in block.chunks_exact_mut(2).zip(self.input.chunks_exact(2)) {
            for ch in 0..2 {
                let x = input[ch] as f64;
                let [z1, z2] = self.state[ch];
                let y = b0 * x + z1;
                self.state[ch] = if y.is_finite() { [b1 * x - a1 * y + z2, b2 * x - a2 * y] } else { [0.0; 2] };
                fr[ch] = if y.is_finite() { y as f32 } else { 0.0 };
            }
        }
        if self.has_input {
            self.input[..block.len()].fill(0.0);
            self.has_input = false;
        }
        true
    }
}

// ---- oscillator -------------------------------------------------------------------------------

struct Oscillator {
    /// sine, square, sawtooth, triangle.
    wave: u32,
    frequency: Param,
    detune: Param,
    /// Fraction of a cycle.
    phase: f64,
    start_at: Option<f64>,
    stop_at: Option<f64>,
    ended: bool,
}

/// Softens a jump at phase 0 so that it does not alias.
fn poly_blep(phase: f64, step: f64) -> f64 {
    if step <= 0.0 {
        0.0
    } else if phase < step {
        let x = phase / step;
        x + x - x * x - 1.0
    } else if phase > 1.0 - step {
        let x = (phase - 1.0) / step;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

impl Oscillator {
    fn new() -> Oscillator {
        Oscillator { wave: 0, frequency: Param::new(440.0), detune: Param::new(0.0), phase: 0.0, start_at: None, stop_at: None, ended: false }
    }
    /// The shapes in phase with a browser's: from 0 rising, the square from +1.
    fn sample(wave: u32, phase: f64, step: f64) -> f32 {
        (match wave {
            1 => (if phase < 0.5 { 1.0 } else { -1.0 }) + poly_blep(phase, step) - poly_blep((phase + 0.5).fract(), step),
            2 => {
                let p = (phase + 0.5).fract();
                2.0 * p - 1.0 - poly_blep(p, step)
            }
            3 => 4.0 * ((phase + 0.75).fract() - 0.5).abs() - 1.0,
            _ => (std::f64::consts::TAU * phase).sin(),
        }) as f32
    }
    /// One pass; false while there is nothing to hear yet or any more.
    fn run(&mut self, block: &mut [f32], t0: f64, t1: f64, rate: f64) -> bool {
        block.fill(0.0);
        let Some(when) = self.start_at.filter(|_| !self.ended) else { return false };
        let frames = block.len() / 2;
        let dt = 1.0 / rate;
        let (f0, f1) = (self.frequency.at(t0) as f64, self.frequency.at(t1) as f64);
        let ratio = ((self.detune.at(t0) + self.detune.input(0)) as f64 / 1200.0).exp2();
        self.frequency.prune(t0);
        self.detune.prune(t0);
        let mut any = false;
        for (i, fr) in block.chunks_exact_mut(2).enumerate() {
            let t = t0 + i as f64 * dt;
            if t < when {
                continue;
            }
            if self.stop_at.is_some_and(|stop| t >= stop) {
                self.ended = true;
                break;
            }
            let hz = (f0 + (f1 - f0) * i as f64 / frames as f64 + self.frequency.input(i) as f64) * ratio;
            // Past half the sample rate a browser's oscillator has nothing left to play.
            let step = hz * dt;
            let v = if step.abs() < 0.5 { Oscillator::sample(self.wave, self.phase, step.abs()) } else { 0.0 };
            fr[0] = v;
            fr[1] = v;
            self.phase = (self.phase + step).rem_euclid(1.0);
            any = true;
        }
        any
    }
}

// ---- the graph --------------------------------------------------------------------------------

struct Node {
    kind: Kind,
    outputs: Vec<u32>, // 0 = destination
    /// Params this node's output feeds, as (node, slot).
    param_outputs: Vec<(u32, u32)>,
}

impl Node {
    fn new(kind: Kind) -> Node {
        Node { kind, outputs: Vec::new(), param_outputs: Vec::new() }
    }
}

/// POWERBOAT_AUDIO_DEBUG: per 2 s, how many source blocks reached the output and how many ended in a
/// node that leads nowhere, and the output peak.
static MIX_DEBUG: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var_os("POWERBOAT_AUDIO_DEBUG").is_some());
thread_local! {
    static MIX_COUNTS: std::cell::RefCell<(u64, u64, f32, f64)> = const { std::cell::RefCell::new((0, 0, 0.0, 0.0)) };
}

pub struct Mixer {
    /// Master level (POWERBOAT_VOLUME, 0..1, default 1).
    volume: f32,
    nodes: HashMap<u32, Node>,
    next: u32,
    rate: u32,
    frames: Arc<AtomicU64>,
    ended: Vec<u32>,
    scratch: Vec<f32>,
    /// Blocks for nodes with several outputs.
    spare: Vec<Vec<f32>>,
    /// Every param something connects to, as (node, slot).
    modulated: Vec<(u32, u32)>,
}

/// One walk through the graph.
struct Walk {
    t0: f64,
    t1: f64,
    listener: [f32; 9],
    /// The nodes on the way here: a cycle with no delay in it stays silent, as in browsers.
    path: Vec<u32>,
    /// Steps left: wide graphs of many outputs cannot take the audio thread with them.
    steps: u32,
}

/// Per source, far above anything a game builds.
const WALK_STEPS: u32 = 256;

impl Mixer {
    fn new(rate: u32, volume: f32, frames: Arc<AtomicU64>) -> Mixer {
        let mut nodes = HashMap::new();
        let listener = [0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0].map(Param::new);
        nodes.insert(LISTENER, Node::new(Kind::Listener(Box::new(listener))));
        Mixer { volume, nodes, next: LISTENER + 1, rate, frames, ended: Vec::new(), scratch: vec![0.0; BLOCK * 2], spare: Vec::new(), modulated: Vec::new() }
    }
    fn now(&self) -> f64 {
        self.frames.load(Ordering::Relaxed) as f64 / self.rate as f64
    }
    /// Position, forward and up.
    fn listener_at(&mut self, t: f64) -> [f32; 9] {
        let mut now = [0.0; 9];
        if let Some(Node { kind: Kind::Listener(l), .. }) = self.nodes.get_mut(&LISTENER) {
            for (v, p) in now.iter_mut().zip(l.iter_mut()) {
                *v = p.at(t);
                p.prune(t);
            }
        }
        now
    }
    /// Sends a node's output in `block` on to whatever it connects to. True if it reached anything that plays.
    fn send(&mut self, from: u32, block: &mut [f32], walk: &mut Walk, out: &mut [f32]) -> bool {
        let Some(n) = self.nodes.get(&from) else { return false };
        let count = n.outputs.len();
        if !n.param_outputs.is_empty() {
            for (node, slot) in n.param_outputs.clone() {
                let target = self.nodes.get_mut(&node).and_then(|t| t.kind.param(slot)).and_then(|p| p.modulation.as_mut());
                if let Some(m) = target {
                    for (v, fr) in m.next.iter_mut().zip(block.chunks_exact(2)) {
                        *v += (fr[0] + fr[1]) * 0.5;
                    }
                }
            }
        }
        let mut reached = false;
        for i in 0..count {
            let Some(&to) = self.nodes.get(&from).and_then(|n| n.outputs.get(i)) else { break };
            if i + 1 == count {
                reached |= self.deliver(to, block, walk, out);
            } else {
                let mut copy = self.spare.pop().unwrap_or_default();
                copy.clear();
                copy.extend_from_slice(block);
                reached |= self.deliver(to, &mut copy, walk, out);
                self.spare.push(copy);
            }
        }
        reached
    }
    /// One input of a node: applies a gain or pan in place and goes on, or leaves the block with a node that has state.
    fn deliver(&mut self, to: u32, block: &mut [f32], walk: &mut Walk, out: &mut [f32]) -> bool {
        if to == 0 {
            for (o, b) in out.iter_mut().zip(block.iter()) {
                *o += *b;
            }
            return true;
        }
        let Some(n) = self.nodes.get_mut(&to) else { return false };
        // A node with state takes the block and goes no further now: always safe, also from inside a loop. Below
        // -120 dB counts as silence, or a feedback loop would fade forever and its delay never rest.
        match &mut n.kind {
            Kind::Delay(d) => {
                if audible(block) {
                    add_input(&mut d.input, block);
                    d.has_input = true;
                }
                return true;
            }
            Kind::Filter(f) => {
                if audible(block) {
                    add_input(&mut f.input, block);
                    f.has_input = true;
                }
                return true;
            }
            _ => {}
        }
        if walk.steps == 0 || walk.path.contains(&to) {
            return false;
        }
        walk.steps -= 1;
        let Some(n) = self.nodes.get_mut(&to) else { return false };
        match &mut n.kind {
            Kind::Gain(p) => apply_gain(p, block, walk.t0, walk.t1),
            Kind::Panner(p) => {
                let (pan, level) = p.spatial(&walk.listener, walk.t0);
                apply_pan(block, pan);
                if level != 1.0 {
                    for v in block.iter_mut() {
                        *v *= level;
                    }
                }
            }
            Kind::StereoPanner(p) => {
                let pan = p.at(walk.t0) + p.input(0);
                p.prune(walk.t0);
                apply_pan(block, pan);
            }
            Kind::Pass => {}
            Kind::Delay(_) | Kind::Filter(_) | Kind::Source(_) | Kind::Oscillator(_) | Kind::Listener(_) => return false,
        }
        walk.path.push(to);
        let reached = self.send(to, block, walk, out);
        walk.path.pop();
        reached
    }
    /// Filters feeding other filters run first (reverse post-order; a loop with no delay is cut somewhere).
    fn order_filters(&self, filters: &mut Vec<u32>) {
        fn visit(m: &Mixer, id: u32, seen: &mut HashSet<u32>, order: &mut Vec<u32>) {
            if id == 0 || !seen.insert(id) {
                return;
            }
            if let Some(n) = m.nodes.get(&id) {
                for &o in &n.outputs {
                    visit(m, o, seen, order);
                }
                if matches!(n.kind, Kind::Filter(_)) {
                    order.push(id);
                }
            }
        }
        if filters.len() < 2 {
            return;
        }
        let (mut seen, mut order) = (HashSet::new(), Vec::with_capacity(filters.len()));
        for &f in filters.iter() {
            visit(self, f, &mut seen, &mut order);
        }
        order.reverse();
        *filters = order;
    }
    /// One pass through the graph, for one output slice.
    fn pass(&mut self, out: &mut [f32], t0: f64, t1: f64, makers: &[u32], delays: &[u32], filters: &[u32]) {
        let rate = self.rate as f64;
        // What fed the params during the last pass is what they hear now.
        for i in 0..self.modulated.len() {
            let (node, slot) = self.modulated[i];
            if let Some(m) = self.nodes.get_mut(&node).and_then(|t| t.kind.param(slot)).and_then(|p| p.modulation.as_mut()) {
                let m = &mut **m;
                std::mem::swap(&mut m.now, &mut m.next);
                m.next.fill(0.0);
            }
        }
        let frames = out.len() / 2;
        let listener = self.listener_at(t0);
        let mut walk = Walk { t0, t1, listener, path: Vec::with_capacity(8), steps: WALK_STEPS };
        let mut scratch = std::mem::take(&mut self.scratch);
        let block = &mut scratch[..out.len()];
        for &id in delays {
            let playing = match self.nodes.get_mut(&id) {
                Some(Node { kind: Kind::Delay(d), .. }) => d.play(block, t0, t1, rate),
                _ => false,
            };
            if playing {
                walk.path.clear();
                walk.path.push(id);
                walk.steps = WALK_STEPS;
                self.send(id, block, &mut walk, out);
            }
        }
        for &id in makers {
            // Ended once: a callback has several passes, and the node retires only at its end.
            let (active, ends) = match self.nodes.get_mut(&id).map(|n| &mut n.kind) {
                Some(Kind::Source(s)) => {
                    let was = s.ended;
                    (render_source(s, block, t0, rate), s.ended && !was)
                }
                Some(Kind::Oscillator(o)) => {
                    let was = o.ended;
                    (o.run(block, t0, t1, rate), o.ended && !was)
                }
                _ => (false, false),
            };
            if ends {
                self.ended.push(id);
            }
            if active {
                walk.path.clear();
                walk.path.push(id);
                walk.steps = WALK_STEPS;
                let reached = self.send(id, block, &mut walk, out);
                if *MIX_DEBUG {
                    MIX_COUNTS.with(|c| {
                        let mut c = c.borrow_mut();
                        if reached { c.0 += 1 } else { c.1 += 1 }
                    });
                }
            }
        }
        for &id in filters {
            let sounding = match self.nodes.get_mut(&id) {
                Some(Node { kind: Kind::Filter(f), .. }) => f.run(block, t0, rate),
                _ => false,
            };
            if sounding {
                walk.path.clear();
                walk.path.push(id);
                walk.steps = WALK_STEPS;
                self.send(id, block, &mut walk, out);
            }
        }
        for &id in delays {
            if let Some(Node { kind: Kind::Delay(d), .. }) = self.nodes.get_mut(&id) {
                d.take_input(frames);
            }
        }
        self.scratch = scratch;
    }
    fn render(&mut self, out: &mut [f32]) {
        out.fill(0.0);
        let frames = out.len() / 2;
        let t0 = self.now();
        let rate = self.rate as f64;
        if self.scratch.len() < out.len() {
            self.scratch.resize(out.len(), 0.0);
        }
        let (mut makers, mut delays, mut filters) = (Vec::new(), Vec::new(), Vec::new());
        let mut oscillators = false;
        for (&id, n) in &self.nodes {
            match n.kind {
                Kind::Source(_) => makers.push(id),
                Kind::Oscillator(_) => {
                    oscillators = true;
                    makers.push(id);
                }
                Kind::Delay(_) => delays.push(id),
                Kind::Filter(_) => filters.push(id),
                _ => {}
            }
        }
        self.order_filters(&mut filters);
        let quantum = if oscillators || !delays.is_empty() || !filters.is_empty() || !self.modulated.is_empty() { QUANTUM } else { frames.max(1) };
        let mut done = 0;
        while done < frames {
            let n = quantum.min(frames - done);
            let start = t0 + done as f64 / rate;
            self.pass(&mut out[done * 2..(done + n) * 2], start, start + n as f64 / rate, &makers, &delays, &filters);
            done += n;
        }
        if *MIX_DEBUG {
            let peak = out.iter().fold(0f32, |m, v| m.max(v.abs()));
            MIX_COUNTS.with(|c| {
                let mut c = c.borrow_mut();
                c.2 = c.2.max(peak);
                if t0 - c.3 >= 2.0 {
                    eprintln!("[powerboat] mixer 2 s: source blocks reaching the output {}, dead ends {}, peak {:.3}", c.0, c.1, c.2);
                    *c = (0, 0, 0.0, t0);
                }
            });
        }
        // Finished one-shot sources retire themselves (MV never disconnects).
        self.nodes.retain(|_, n| match &n.kind {
            Kind::Source(s) => !s.ended,
            Kind::Oscillator(o) => !o.ended,
            _ => true,
        });
        for v in out.iter_mut() {
            *v = (*v * self.volume).clamp(-1.0, 1.0);
        }
        self.frames.fetch_add(frames as u64, Ordering::Relaxed);
    }
}

fn audible(block: &[f32]) -> bool {
    block.iter().any(|v| v.abs() > 1e-6)
}

fn add_input(input: &mut [f32], block: &[f32]) {
    for (i, b) in input.iter_mut().zip(block.iter()) {
        *i += *b;
    }
}

fn apply_gain(p: &mut Param, block: &mut [f32], t0: f64, t1: f64) {
    let g0 = p.at(t0);
    let g1 = p.at(t1);
    p.prune(t0);
    let frames = (block.len() / 2) as f32;
    if p.modulation.is_some() {
        for (i, fr) in block.chunks_exact_mut(2).enumerate() {
            let g = g0 + (g1 - g0) * (i as f32 / frames) + p.input(i);
            fr[0] *= g;
            fr[1] *= g;
        }
    } else if (g0 - g1).abs() < 1e-6 {
        if g0 != 1.0 {
            for v in block.iter_mut() {
                *v *= g0;
            }
        }
    } else {
        for (i, fr) in block.chunks_exact_mut(2).enumerate() {
            let g = g0 + (g1 - g0) * (i as f32 / frames);
            fr[0] *= g;
            fr[1] *= g;
        }
    }
}

/// Equal-power panning, Web Audio's stereo-input rule, pan in [-1, 1].
fn apply_pan(block: &mut [f32], pan: f32) {
    if pan.abs() < 1e-4 {
        return;
    }
    let pan = pan.clamp(-1.0, 1.0);
    let x = if pan <= 0.0 { pan + 1.0 } else { pan };
    let (gl, gr) = ((x * std::f32::consts::FRAC_PI_2).cos(), (x * std::f32::consts::FRAC_PI_2).sin());
    for fr in block.chunks_exact_mut(2) {
        let (l, r) = (fr[0], fr[1]);
        if pan <= 0.0 {
            fr[0] = l + r * gl;
            fr[1] = r * gr;
        } else {
            fr[0] = l * gl;
            fr[1] = r + l * gr;
        }
    }
}

/// Renders one block of a source (stereo interleaved). Returns false if it produced nothing.
fn render_source(s: &mut Source, block: &mut [f32], t0: f64, out_rate: f64) -> bool {
    block.fill(0.0);
    if s.ended {
        return false;
    }
    let Some(buf) = s.buf.clone() else { return false };
    let frames = block.len() / 2;
    let dt = 1.0 / out_rate;
    let rate = (s.rate.at(t0) + s.rate.input(0)).max(0.0) as f64 * ((s.detune.at(t0) + s.detune.input(0)) as f64 / 1200.0).exp2();
    s.rate.prune(t0);
    s.detune.prune(t0);
    let step = rate * buf.rate as f64 / out_rate;
    let loop_start_f = (s.loop_start.max(0.0) * buf.rate as f64).min(buf.frames as f64);
    let mut loop_end_f = if s.loop_end > 0.0 { (s.loop_end * buf.rate as f64).min(buf.frames as f64) } else { buf.frames as f64 };
    if loop_end_f <= loop_start_f {
        loop_end_f = buf.frames as f64;
    }
    let stereo = buf.stores.len() > 1;
    let packed = buf.packed.clone();
    // Packed: the chunk being read (None inside = not decoded yet: silence, asked for); a looping
    // source keeps its loop start's chunk.
    let mut cur: Option<(usize, Option<Arc<Vec<i16>>>)> = None;
    if let Some(p) = packed.as_ref().filter(|p| s.looping && !p.lazy) {
        p.pin(loop_start_f as usize / p.chunk);
    }
    let lazy = packed.as_ref().is_some_and(|p| p.lazy);
    let mut any = false;
    for i in 0..frames {
        let t = t0 + i as f64 * dt;
        if s.pos.is_none() {
            match s.start_at {
                Some((when, offset)) if t >= when => s.pos = Some(offset.max(0.0) * buf.rate as f64),
                _ => continue,
            }
        }
        if let Some(stop) = s.stop_at {
            if t >= stop {
                s.ended = true;
                break;
            }
        }
        if let Some(d) = s.duration {
            if s.played >= d {
                s.ended = true;
                break;
            }
        }
        let pos = s.pos.unwrap();
        if pos >= buf.frames as f64 {
            s.ended = true;
            break;
        }
        let i0 = pos as usize;
        // A lazy sound whose samples were dropped waits for the audio-stream thread (a block or two
        // late the first time) instead of losing its start.
        if lazy && !packed.as_ref().unwrap().ready(&mut cur, i0) {
            break;
        }
        let frac = (pos - i0 as f64) as f32;
        let i1 = i0 + 1;
        let (l, r) = if let Some(p) = &packed {
            let (l0, r0) = p.frame(&mut cur, i0);
            let (l1, r1) = p.frame(&mut cur, i1);
            (l0 * (1.0 - frac) + l1 * frac, r0 * (1.0 - frac) + r1 * frac)
        } else {
            let l = buf.sample(0, i0) * (1.0 - frac) + buf.sample(0, i1) * frac;
            (l, if stereo { buf.sample(1, i0) * (1.0 - frac) + buf.sample(1, i1) * frac } else { l })
        };
        block[i * 2] = l;
        block[i * 2 + 1] = r;
        any = true;
        let mut np = pos + step;
        if s.looping && np >= loop_end_f {
            np = loop_start_f + (np - loop_end_f);
            if np >= loop_end_f {
                np = loop_start_f;
            }
        }
        s.pos = Some(np);
        s.played += dt;
    }
    any
}

struct Cb {
    mixer: Arc<Mutex<Mixer>>,
}

impl AudioCallback for Cb {
    type Channel = f32;
    fn callback(&mut self, out: &mut [f32]) {
        match self.mixer.try_lock() {
            Ok(mut m) => m.render(out),
            Err(_) => match self.mixer.lock() {
                Ok(mut m) => m.render(out),
                Err(_) => out.fill(0.0),
            },
        }
    }
}

pub struct AudioSys {
    _device: AudioDevice<Cb>,
    mixer: Arc<Mutex<Mixer>>,
    frames: Arc<AtomicU64>,
    pub rate: u32,
    buffers: HashMap<u32, Rc<RefCell<AudioBuf>>>,
    next_buffer: u32,
}

impl AudioSys {
    pub fn open(audio: &sdl2::AudioSubsystem) -> Result<AudioSys, String> {
        let want = AudioSpecDesired { freq: Some(44100), channels: Some(2), samples: Some(BLOCK as u16) };
        let frames = Arc::new(AtomicU64::new(0));
        let volume = std::env::var("POWERBOAT_VOLUME").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0f32).clamp(0.0, 1.0);
        let mixer = Arc::new(Mutex::new(Mixer::new(44100, volume, frames.clone())));
        let m2 = mixer.clone();
        let device = audio.open_playback(None, &want, move |spec| {
            m2.lock().unwrap().rate = spec.freq as u32;
            eprintln!("[powerboat] audio {} Hz, {} ch, {} samples/callback", spec.freq, spec.channels, spec.samples);
            Cb { mixer: m2.clone() }
        })?;
        let rate = device.spec().freq as u32;
        if device.spec().channels != 2 {
            return Err(format!("audio device gave {} channels, need 2", device.spec().channels));
        }
        device.resume();
        Ok(AudioSys { _device: device, mixer, frames, rate, buffers: HashMap::new(), next_buffer: 1 })
    }
    pub fn now(&self) -> f64 {
        self.frames.load(Ordering::Relaxed) as f64 / self.rate as f64
    }
    fn buffer_ref(&self, id: u32) -> Option<Arc<BufRef>> {
        let b = self.buffers.get(&id)?;
        let mut b = b.borrow_mut();
        let (rate, frames) = (b.rate, b.frames);
        let mut stores = Vec::with_capacity(b.channels.len());
        for ch in b.channels.iter_mut() {
            if let Channel::Pending(v) = ch {
                let data = std::mem::take(v);
                *ch = Channel::Shared(vec_to_store(data));
            }
            match ch {
                Channel::Shared(s) => stores.push(ChanRef::F32(s.clone())),
                Channel::Pcm16(v) => stores.push(ChanRef::I16(v.clone())),
                Channel::Pending(_) => {}
            }
        }
        Some(Arc::new(BufRef { rate, frames, stores, packed: b.packed.clone() }))
    }
    /// Registers decoded PCM (a video's soundtrack) as a buffer JS can play.
    pub fn add_buffer(&mut self, rate: u32, channels: Vec<Vec<i16>>) -> u32 {
        let id = self.next_buffer;
        self.next_buffer += 1;
        let frames = channels.first().map(|c| c.len()).unwrap_or(0);
        self.buffers.insert(id, Rc::new(RefCell::new(AudioBuf { rate, frames, channels: channels.into_iter().map(to_pcm16).collect(), packed: None })));
        id
    }
    pub fn bytes(&self) -> usize {
        self.buffers
            .values()
            .map(|b| {
                let b = b.borrow();
                b.channels.iter().map(|c| if matches!(c, Channel::Pcm16(_)) { b.frames * 2 } else { b.frames * 4 }).sum::<usize>()
                    + b.packed.as_ref().map_or(0, |p| p.bytes())
            })
            .sum()
    }
}

fn vec_to_store(v: Vec<f32>) -> v8::SharedRef<v8::BackingStore> {
    let bytes: Vec<u8> = unsafe {
        let mut v = std::mem::ManuallyDrop::new(v);
        Vec::from_raw_parts(v.as_mut_ptr() as *mut u8, v.len() * 4, v.capacity() * 4)
    };
    v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared()
}

// ---- decode -----------------------------------------------------------------------------------

/// Decodes a whole file straight to 16-bit channels: each packet is converted as it comes, so no
/// full-length f32 copy exists (VUG on the R36S 2GB peaked at 767 MB loading its music that way).
pub fn decode(data: Vec<u8>, hint_ext: Option<&str>) -> Result<(u32, Vec<Vec<i16>>), String> {
    decode_all(Arc::new(data), hint_ext)
}

fn decode_all(data: Arc<Vec<u8>>, hint_ext: Option<&str>) -> Result<(u32, Vec<Vec<i16>>), String> {
    decode_reader(Reader::open(data, hint_ext)?)
}

fn decode_reader(mut r: Reader) -> Result<(u32, Vec<Vec<i16>>), String> {
    let reserve = r.frames.unwrap_or(0).min(48_000 * 60 * 20) as usize;
    let mut channels: Vec<Vec<i16>> = (0..r.channels).map(|_| Vec::with_capacity(reserve)).collect();
    while r.next(&mut channels)?.is_some() {}
    if channels.first().map_or(true, |c| c.is_empty()) {
        return Err("no audio decoded".into());
    }
    Ok((r.rate, channels))
}

/// The compressed file as a symphonia source without copying it.
struct ArcSource {
    d: Arc<Vec<u8>>,
    pos: u64,
}
impl Read for ArcSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let p = (self.pos as usize).min(self.d.len());
        let n = buf.len().min(self.d.len() - p);
        buf[..n].copy_from_slice(&self.d[p..p + n]);
        self.pos += n as u64;
        Ok(n)
    }
}
impl Seek for ArcSource {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        let p = match to {
            SeekFrom::Start(o) => o as i64,
            SeekFrom::End(o) => self.d.len() as i64 + o,
            SeekFrom::Current(o) => self.pos as i64 + o,
        };
        if p < 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "seek before the start"));
        }
        self.pos = p as u64;
        Ok(self.pos)
    }
}
impl MediaSource for ArcSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.d.len() as u64)
    }
}

enum Dec {
    Sym(Box<dyn AudioDecoder>, Vec<f32>),
    /// WebM/Opus (Construct 3): symphonia demuxes, libopus decodes (OpusHead kept for re-opens).
    Opus(crate::opus::Decoder, Option<Vec<u8>>),
}

/// One audio track being decoded packet by packet, to i16 channels.
struct Reader {
    format: Box<dyn FormatReader>,
    track_id: u32,
    dec: Dec,
    rate: u32,
    channels: usize,
    /// Length in frames when the container says.
    frames: Option<u64>,
    time_base: Option<TimeBase>,
}

impl Reader {
    fn open(data: Arc<Vec<u8>>, hint_ext: Option<&str>) -> Result<Reader, String> {
        let mss = MediaSourceStream::new(Box::new(ArcSource { d: data, pos: 0 }), MediaSourceStreamOptions::default());
        let mut hint = Hint::new();
        if let Some(e) = hint_ext {
            hint.with_extension(e);
        }
        let format = symphonia::default::get_probe()
            .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
            .map_err(|e| format!("probe: {e}"))?;
        let track = format.default_track(TrackType::Audio).ok_or("no audio track")?;
        let (track_id, frames, time_base) = (track.id, track.num_frames, track.time_base);
        let Some(CodecParameters::Audio(params)) = track.codec_params.clone() else { return Err("no audio codec params".into()) };
        let hint_ch = params.channels.as_ref().map(|c| c.count()).unwrap_or(0);
        let (dec, rate, channels) = if params.codec == symphonia::core::codecs::audio::well_known::CODEC_ID_OPUS {
            let head = params.extra_data.as_deref().map(|h| h.to_vec());
            let d = crate::opus::Decoder::new(head.as_deref(), hint_ch.max(1))?;
            let ch = d.channels();
            (Dec::Opus(d, head), crate::opus::RATE, ch)
        } else {
            let d = symphonia::default::get_codecs()
                .make_audio_decoder(&params, &AudioDecoderOptions::default())
                .map_err(|e| format!("decoder: {e}"))?;
            (Dec::Sym(d, Vec::new()), params.sample_rate.unwrap_or(44100), hint_ch)
        };
        Ok(Reader { format, track_id, dec, rate, channels, frames, time_base })
    }
    /// Decodes the next packet with output onto `out` (sized to the channel count): the frame that
    /// output starts at (from the packet's timestamp), None at the end.
    fn next(&mut self, out: &mut Vec<Vec<i16>>) -> Result<Option<u64>, String> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => return Ok(None),
                Err(symphonia::core::errors::Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(e) => return Err(format!("read: {e}")),
            };
            if packet.track_id != self.track_id {
                continue;
            }
            let before = out.first().map_or(0, |c| c.len());
            match &mut self.dec {
                Dec::Opus(d, _) => {
                    if out.len() != d.channels() {
                        out.resize(d.channels(), Vec::new());
                    }
                    d.decode_into(&packet.data, out)?;
                }
                Dec::Sym(d, interleaved) => {
                    let decoded: GenericAudioBufferRef = match d.decode(&packet) {
                        Ok(x) => x,
                        Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                        Err(e) => return Err(format!("decode: {e}")),
                    };
                    let n = decoded.num_planes();
                    if n == 0 || decoded.frames() == 0 {
                        continue;
                    }
                    self.rate = decoded.spec().rate();
                    self.channels = n;
                    if out.len() != n {
                        out.resize(n, Vec::new());
                    }
                    // Vorbis (and most codecs) decode to f32 planes: each straight into its i16 channel, a
                    // loop LLVM vectorizes. Interleaving first and dealing samples out by `i % n` cost as
                    // much as decoding (PC: 10-18 ms of a 10 s stereo file, decoding 12-19).
                    let planes = match &decoded {
                        GenericAudioBufferRef::F32(buf) => (0..n).map(|ch| SymAudio::plane(*buf, ch)).collect::<Option<Vec<&[f32]>>>(),
                        _ => None,
                    };
                    if let Some(planes) = planes {
                        for (o, p) in out.iter_mut().zip(planes) {
                            o.extend(p.iter().map(|&s| to_i16(s)));
                        }
                    } else {
                        decoded.copy_to_vec_interleaved::<f32>(interleaved);
                        for (i, s) in interleaved.iter().enumerate() {
                            out[i % n].push(to_i16(*s));
                        }
                    }
                }
            }
            if out.first().map_or(0, |c| c.len()) == before {
                continue; // no output (e.g. the first packet after a seek)
            }
            return Ok(Some(self.frame_of(packet.pts.get().max(0) as u64)));
        }
    }
    /// Frames to start decoding before a seek target: a reset Opus decoder needs its first packets to
    /// converge (about 8% of a chunk differed without); Vorbis is exact from the seek point.
    fn preroll(&self) -> usize {
        match self.dec {
            Dec::Opus(..) => self.rate as usize / 4,
            Dec::Sym(..) => 0,
        }
    }
    fn frame_of(&self, ts: u64) -> u64 {
        let (num, den) = self.time_base.map_or((1, self.rate as u64), |t| (t.numer.get() as u64, t.denom.get() as u64));
        ts * self.rate as u64 * num / den
    }
    /// Seeks to at or before `frame`; returns the frame decoding resumes at.
    fn seek(&mut self, frame: u64) -> Result<u64, String> {
        let (num, den) = self.time_base.map_or((1, self.rate as u64), |t| (t.numer.get() as u64, t.denom.get() as u64));
        let ts = frame * den / (self.rate as u64 * num);
        let to = SeekTo::Timestamp { ts: Timestamp::new(ts as i64), track_id: self.track_id };
        let got = self.format.seek(SeekMode::Accurate, to).map_err(|e| format!("seek: {e}"))?;
        match &mut self.dec {
            Dec::Sym(d, _) => d.reset(),
            Dec::Opus(d, head) => *d = crate::opus::Decoder::new(head.as_deref(), self.channels.max(1))?.without_preskip(),
        }
        Ok((got.actual_ts.get().max(0) as u64) * self.rate as u64 * num / den)
    }
}

// ---- long files kept compressed ----------------------------------------------------------------

/// Frames per chunk of a packed file (~3 s at 44.1 kHz) and how many chunks besides pinned ones stay.
const CHUNK: usize = 1 << 17;
const KEEP_CHUNKS: usize = 4;

/// A decoded file longer than 30 s (music: Construct plays it as a sound, MV as BGM) kept compressed:
/// the mixer reads chunks decoded ahead by the audio-stream thread (chunk 0 and loop starts stay).
/// VUG held 199 MB of music PCM before this. POWERBOAT_AUDIO_STREAM=0 decodes everything up front.
pub struct Packed {
    data: Arc<Vec<u8>>,
    ext: Option<String>,
    rate: u32,
    frames: usize,
    nch: usize,
    /// Frames per chunk: CHUNK for a streamed long file; the whole file for a lazy short one.
    chunk: usize,
    /// A short sound kept compressed (Packed::lazy): one chunk, held in the global LAZY cache (a byte
    /// budget over all such sounds) instead of by itself; the mixer waits for it rather than skipping.
    lazy: bool,
    cache: Mutex<ChunkCache>,
    /// The decoder, positioned at a frame, with frames already decoded past the last chunk.
    dec: Mutex<Option<(Reader, usize, Vec<Vec<i16>>)>>,
    /// Frames to add to a post-seek output timestamp (measured once: WebM/Opus block timestamps sit
    /// 72 frames off the decoded samples for VUG's music; Ogg Vorbis 0).
    seek_shift: AtomicI64,
}

#[derive(Default)]
struct ChunkCache {
    chunks: HashMap<usize, Arc<Vec<i16>>>,
    lru: VecDeque<usize>,
    pinned: HashSet<usize>,
    queued: HashSet<usize>,
}

// The Reader inside is only used under the dec lock.
unsafe impl Send for Packed {}
unsafe impl Sync for Packed {}

impl Packed {
    /// None: short (or not streamable) - decode it whole.
    fn new(data: Arc<Vec<u8>>, ext: Option<&str>) -> Result<Option<Arc<Packed>>, String> {
        Self::new_or_short(data, ext).map(|r| r.ok())
    }
    /// Packed::new, but a short file whose length had to be counted by decoding (WebM) comes back
    /// with those samples (Err(Some)), so it is not decoded a second time: C3 games load hundreds of
    /// WebM/Opus effects at boot. Err(None): short, nothing decoded yet.
    fn new_or_short(data: Arc<Vec<u8>>, ext: Option<&str>) -> Result<Result<Arc<Packed>, Option<(u32, Vec<Vec<i16>>)>>, String> {
        if std::env::var("POWERBOAT_AUDIO_STREAM").is_ok_and(|v| v == "0") {
            return Ok(Err(None));
        }
        let mut r = Reader::open(data.clone(), ext)?;
        let long = 30.0 * r.rate as f64;
        let frames = match r.frames {
            Some(f) => f as usize,
            None => {
                // No length in the container (WebM): the samples are kept while the file is short
                // enough to be a sound, then only counted (music is never held whole).
                let mut n = 0usize;
                let mut keep = true;
                let mut chans: Vec<Vec<i16>> = vec![Vec::new(); r.channels.max(1)];
                while r.next(&mut chans)?.is_some() {
                    if keep && chans.first().map_or(0, |c| c.len()) as f64 >= long {
                        keep = false;
                    }
                    if !keep {
                        n += chans.first().map_or(0, |c| c.len());
                        chans.iter_mut().for_each(|c| {
                            c.clear();
                            c.shrink_to_fit();
                        });
                    }
                }
                if keep {
                    if chans.first().map_or(true, |c| c.is_empty()) {
                        return Err("no audio decoded".into());
                    }
                    let rate = r.rate;
                    chans.iter_mut().for_each(|c| c.shrink_to_fit());
                    return Ok(Err(Some((rate, chans))));
                }
                n
            }
        };
        if (frames as f64) < long {
            return Ok(Err(None));
        }
        let r = Reader::open(data.clone(), ext)?;
        let p = Arc::new(Packed {
            data,
            ext: ext.map(|e| e.to_string()),
            rate: r.rate,
            frames,
            nch: r.channels.max(1),
            chunk: CHUNK,
            lazy: false,
            cache: Mutex::new(ChunkCache::default()),
            dec: Mutex::new(Some((r, 0, Vec::new()))),
            seek_shift: AtomicI64::new(0),
        });
        // Chunk 0 now: it checks the file decodes and lets the music start at once.
        let c0 = p.decode_chunk(0)?;
        p.seek_shift.store(p.measure_seek_shift(&c0).unwrap_or(0), Ordering::Relaxed);
        let mut c = p.cache.lock().unwrap();
        c.chunks.insert(0, Arc::new(c0));
        c.pinned.insert(0);
        drop(c);
        Ok(Ok(p))
    }
    /// A short sound kept compressed: its samples (just decoded, so they are there to begin with) sit
    /// in the global LAZY cache and are decoded again on the audio-stream thread when they were
    /// dropped and it plays. Moonstone Island decodes 431 effects at boot: 164 MB of PCM, OOM on the
    /// 1 GB Smart Pro.
    fn lazy(data: Arc<Vec<u8>>, ext: Option<&str>, rate: u32, chans: Vec<Vec<i16>>) -> Arc<Packed> {
        let nch = chans.len().max(1);
        let frames = chans.first().map_or(0, |c| c.len());
        let p = Arc::new(Packed {
            data,
            ext: ext.map(|e| e.to_string()),
            rate,
            frames,
            nch,
            chunk: frames.max(1),
            lazy: true,
            cache: Mutex::new(ChunkCache::default()),
            dec: Mutex::new(None),
            seek_shift: AtomicI64::new(0),
        });
        let mut pcm = Vec::with_capacity(frames * nch);
        for f in 0..frames {
            for c in 0..nch {
                pcm.push(chans[c.min(chans.len() - 1)][f]);
            }
        }
        drop(chans);
        p.insert(0, pcm);
        p
    }
    /// Drops a lazy sound's samples (LAZY cache eviction).
    fn drop_samples(&self) {
        let mut c = self.cache.lock().unwrap();
        c.chunks.clear();
        c.lru.clear();
    }
    /// Seeks into chunk 0 (decoded in order) and finds the shift that lines the output up with it.
    fn measure_seek_shift(&self, c0: &[i16]) -> Option<i64> {
        let at = (CHUNK / 2).min(self.frames / 2) as u64;
        let mut r = Reader::open(self.data.clone(), self.ext.as_deref()).ok()?;
        r.seek(at).ok()?;
        // past the decoder's warm-up (the window below starts 2048 frames in)
        let mut out: Vec<Vec<i16>> = vec![Vec::new(); self.nch];
        let f = r.next(&mut out).ok()?? as i64;
        while out[0].len() < 12288 {
            r.next(&mut out).ok()??;
        }
        let mut best = (i64::MAX, 0i64);
        for sh in -2048i64..=2048 {
            let mut err = 0i64;
            for j in (2048..10240).step_by(5) {
                let w = f + j as i64 + sh;
                if w < 0 || w as usize >= CHUNK {
                    err = i64::MAX / 2;
                    break;
                }
                err += (out[0][j] as i64 - c0[w as usize * self.nch] as i64).abs();
            }
            if err < best.0 {
                best = (err, sh);
            }
        }
        Some(best.1)
    }
    fn bytes(&self) -> usize {
        self.data.len() + self.cache.lock().unwrap().chunks.values().map(|c| c.len() * 2).sum::<usize>()
    }
    /// Interleaved i16 frames [k*chunk, (k+1)*chunk), zero-padded past the end (a lazy sound's one
    /// chunk is exactly its length).
    fn decode_chunk(&self, k: usize) -> Result<Vec<i16>, String> {
        let start = k * self.chunk;
        let need = self.chunk.min(self.frames.saturating_sub(start));
        let mut g = self.dec.lock().unwrap();
        let (mut r, mut pos, mut carry) = match g.take() {
            Some(st) if st.1 == start => st,
            _ => {
                let mut r = Reader::open(self.data.clone(), self.ext.as_deref())?;
                let mut carry: Vec<Vec<i16>> = vec![Vec::new(); self.nch];
                let mut pos = 0;
                if start > 0 {
                    // Positioned by the first output's timestamp: the decoder's first packets
                    // after a reset need not start where the container's seek says.
                    r.seek(start.saturating_sub(r.preroll()) as u64)?;
                    pos = match r.next(&mut carry)? {
                        Some(f) => (f as i64 + self.seek_shift.load(Ordering::Relaxed)).max(0) as usize,
                        None => start,
                    };
                    if pos > start {
                        for ch in carry.iter_mut() {
                            ch.splice(0..0, std::iter::repeat_n(0, pos - start));
                        }
                        pos = start;
                    }
                }
                (r, pos, carry)
            }
        };
        if carry.len() < self.nch {
            carry.resize(self.nch, Vec::new());
        }
        // carry holds frames from `pos`: decode until [start, start + need) is covered.
        while pos + carry[0].len() < start + need {
            if r.next(&mut carry)?.is_none() {
                break;
            }
        }
        let skip = start - pos;
        let len = if self.lazy { need } else { self.chunk };
        let mut out = Vec::with_capacity(len * self.nch);
        for f in 0..len {
            for c in 0..self.nch {
                let ch = &carry[c.min(carry.len() - 1)];
                out.push(if f < need { ch.get(skip + f).copied().unwrap_or(0) } else { 0 });
            }
        }
        for ch in carry.iter_mut() {
            let n = (skip + need).min(ch.len());
            ch.drain(..n);
        }
        pos = start + need;
        // A lazy sound is decoded whole each time: no decoder kept (hundreds of them).
        if !self.lazy {
            *g = Some((r, pos, carry));
        }
        Ok(out)
    }
    /// The decoded chunk k, or None (asked for; the mixer plays silence until it is there).
    fn chunk(self: &Arc<Self>, k: usize) -> Option<Arc<Vec<i16>>> {
        let mut c = self.cache.lock().unwrap();
        if let Some(x) = c.chunks.get(&k).cloned() {
            if let Some(i) = c.lru.iter().position(|&j| j == k) {
                c.lru.remove(i);
            }
            c.lru.push_back(k);
            drop(c);
            if self.lazy {
                lazy_cache_use(self, None);
            }
            return Some(x);
        }
        drop(c);
        self.request(k);
        None
    }
    fn request(self: &Arc<Self>, k: usize) {
        if k * self.chunk >= self.frames {
            return;
        }
        let mut c = self.cache.lock().unwrap();
        if c.chunks.contains_key(&k) || !c.queued.insert(k) {
            return;
        }
        drop(c);
        let _ = stream_worker().send((Arc::downgrade(self), k));
    }
    fn pin(self: &Arc<Self>, k: usize) {
        let new = self.cache.lock().unwrap().pinned.insert(k);
        if new {
            self.request(k);
        }
    }
    fn insert(self: &Arc<Self>, k: usize, data: Vec<i16>) {
        let mut c = self.cache.lock().unwrap();
        c.queued.remove(&k);
        let bytes = data.len() * 2;
        c.chunks.insert(k, Arc::new(data));
        c.lru.push_back(k);
        if self.lazy {
            drop(c);
            lazy_cache_use(self, Some(bytes));
            return;
        }
        loop {
            let unpinned = c.chunks.keys().filter(|j| !c.pinned.contains(j)).count();
            if unpinned <= KEEP_CHUNKS {
                break;
            }
            let Some(old) = c.lru.pop_front() else { break };
            if !c.pinned.contains(&old) && old != k {
                c.chunks.remove(&old);
            }
        }
    }
    /// One frame (left, right) for the mixer; `cur` caches the chunk across a block.
    #[inline]
    fn frame(self: &Arc<Self>, cur: &mut Option<(usize, Option<Arc<Vec<i16>>>)>, i: usize) -> (f32, f32) {
        if i >= self.frames {
            return (0.0, 0.0);
        }
        let k = i / self.chunk;
        self.select(cur, k);
        match cur {
            Some((_, Some(c))) => {
                let o = (i - k * self.chunk) * self.nch;
                let l = c[o] as f32 * (1.0 / 32768.0);
                (l, if self.nch > 1 { c[o + 1] as f32 * (1.0 / 32768.0) } else { l })
            }
            _ => (0.0, 0.0),
        }
    }
    /// Points `cur` at chunk k (asking for it, and for the next one once it is there).
    #[inline]
    fn select(self: &Arc<Self>, cur: &mut Option<(usize, Option<Arc<Vec<i16>>>)>, k: usize) {
        if cur.as_ref().map(|c| c.0) != Some(k) {
            let got = self.chunk(k);
            if got.is_some() {
                self.request(k + 1);
            }
            *cur = Some((k, got));
        }
    }
    /// A lazy sound: whether frame i's samples are there (if not they are asked for; the mixer then
    /// holds the source where it is instead of letting it run on in silence).
    #[inline]
    fn ready(self: &Arc<Self>, cur: &mut Option<(usize, Option<Arc<Vec<i16>>>)>, i: usize) -> bool {
        if i >= self.frames {
            return true;
        }
        self.select(cur, i / self.chunk);
        matches!(cur, Some((_, Some(_))))
    }
    fn decode_whole(&self) -> Result<(u32, Vec<Vec<i16>>), String> {
        decode_all(self.data.clone(), self.ext.as_deref())
    }
}

impl Drop for Packed {
    fn drop(&mut self) {
        if self.lazy {
            lazy_cache_forget(self as *const Packed as usize);
        }
    }
}

// ---- short sounds kept compressed: one byte budget over all of them -----------------------------

/// Least recently used order over lazy sounds whose samples are decoded. `order` holds (key, stamp)
/// and may hold stale entries (a newer stamp in `live` wins); keys are Packed addresses.
#[derive(Default)]
struct LazyCache {
    order: VecDeque<(usize, u64)>,
    live: HashMap<usize, (Weak<Packed>, usize, u64)>,
    total: usize,
    stamp: u64,
}

fn lazy_cache() -> &'static Mutex<LazyCache> {
    static C: OnceLock<Mutex<LazyCache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(LazyCache::default()))
}

/// POWERBOAT_AUDIO_LAZY=0: decode short sounds whole and keep them (as before). POWERBOAT_AUDIO_LAZY_MB: the
/// budget for decoded short sounds (default 32 MB, ~3 min of 48 kHz stereo).
fn lazy_on() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| !std::env::var("POWERBOAT_AUDIO_LAZY").is_ok_and(|v| v == "0") && !std::env::var("POWERBOAT_AUDIO_STREAM").is_ok_and(|v| v == "0"))
}
fn lazy_budget() -> usize {
    static B: OnceLock<usize> = OnceLock::new();
    *B.get_or_init(|| std::env::var("POWERBOAT_AUDIO_LAZY_MB").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(32) * 1_048_576)
}

/// A lazy sound was used (bytes None) or its samples were just decoded (Some): it becomes the most
/// recent; over the budget, the least recent ones drop their samples (after the lock is released).
fn lazy_cache_use(p: &Arc<Packed>, bytes: Option<usize>) {
    let key = Arc::as_ptr(p) as usize;
    let mut victims = Vec::new();
    {
        let mut c = lazy_cache().lock().unwrap();
        c.stamp += 1;
        let stamp = c.stamp;
        match (c.live.get_mut(&key), bytes) {
            (Some(e), b) => {
                let old = e.1;
                e.2 = stamp;
                if let Some(b) = b {
                    e.1 = b;
                    c.total = c.total + b - old;
                }
            }
            (None, Some(b)) => {
                c.live.insert(key, (Arc::downgrade(p), b, stamp));
                c.total += b;
            }
            (None, None) => return,
        }
        c.order.push_back((key, stamp));
        let budget = lazy_budget();
        while c.total > budget {
            let Some((k, st)) = c.order.pop_front() else { break };
            if k == key || c.live.get(&k).is_none_or(|e| e.2 != st) {
                continue;
            }
            if let Some((w, b, _)) = c.live.remove(&k) {
                c.total -= b;
                victims.push(w);
            }
        }
        if c.order.len() > 4 * c.live.len() + 256 {
            let live = std::mem::take(&mut c.live);
            let mut order: Vec<(usize, u64)> = live.iter().map(|(k, e)| (*k, e.2)).collect();
            order.sort_by_key(|e| e.1);
            c.order = order.into();
            c.live = live;
        }
    }
    for w in victims {
        if let Some(v) = w.upgrade() {
            v.drop_samples();
        }
    }
}

fn lazy_cache_forget(key: usize) {
    let mut c = lazy_cache().lock().unwrap();
    if let Some((_, b, _)) = c.live.remove(&key) {
        c.total -= b;
    }
}

/// The thread that decodes requested chunks of packed files.
fn stream_worker() -> &'static mpsc::Sender<(Weak<Packed>, usize)> {
    static TX: OnceLock<mpsc::Sender<(Weak<Packed>, usize)>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<(Weak<Packed>, usize)>();
        std::thread::Builder::new()
            .name("audio-stream".into())
            .spawn(move || {
                for (w, k) in rx {
                    let Some(p) = w.upgrade() else { continue };
                    match p.decode_chunk(k) {
                        Ok(d) => p.insert(k, d),
                        // A lazy sound that will not decode again plays as silence (the mixer would
                        // otherwise hold its sources for good).
                        Err(e) if p.lazy => {
                            eprintln!("[powerboat] audio: short sound did not decode again: {e}");
                            p.insert(k, vec![0; p.frames * p.nch]);
                        }
                        Err(e) => {
                            eprintln!("[powerboat] audio stream chunk {k}: {e}");
                            p.cache.lock().unwrap().queued.remove(&k);
                        }
                    }
                }
            })
            .expect("audio-stream thread");
        tx
    })
}

/// powerboat --stream-test <file>: a packed file's chunks against the whole decode, read in order
/// (playback) and each after a fresh seek (loop jumps). Prints mismatching frames per chunk.
pub fn stream_test(path: &str) {
    let data = Arc::new(std::fs::read(path).expect("read"));
    let ext = path.rsplit('.').next().map(|e| e.to_ascii_lowercase());
    let (rate, whole) = decode_all(data.clone(), ext.as_deref()).expect("decode");
    let frames = whole[0].len();
    eprintln!("whole: {rate} Hz, {} ch, {frames} frames ({:.1} s)", whole.len(), frames as f64 / rate as f64);
    std::env::set_var("POWERBOAT_AUDIO_STREAM", "1");
    let Some(p) = Packed::new(data, ext.as_deref()).expect("pack") else {
        eprintln!("not packed (shorter than 30 s)");
        return;
    };
    eprintln!("packed: {} Hz, {} ch, {} frames, seek shift {}", p.rate, p.nch, p.frames, p.seek_shift.load(Ordering::Relaxed));
    let n = p.frames.div_ceil(CHUNK);
    for pass in ["in order", "after seek"] {
        let (mut bad_total, mut worst) = (0usize, 0i32);
        for k in 0..n {
            if pass == "after seek" {
                *p.dec.lock().unwrap() = None; // forces a re-open + seek
            }
            let c = p.decode_chunk(k).expect("chunk");
            let mut bad = 0;
            for f in 0..CHUNK.min(p.frames - k * CHUNK) {
                for ch in 0..p.nch {
                    let want = whole[ch.min(whole.len() - 1)].get(k * CHUNK + f).copied().unwrap_or(0) as i32;
                    let d = (c[f * p.nch + ch] as i32 - want).abs();
                    if d > 2 {
                        bad += 1;
                        worst = worst.max(d);
                    }
                }
            }
            if bad > 0 {
                // how far off: the shift (in frames) that best lines the chunk up with the whole decode
                let mut best = (i64::MAX, 0i64);
                for sh in -2048i64..=2048 {
                    let mut err = 0i64;
                    for f in (4096..8192).step_by(7) {
                        let w = (k * CHUNK) as i64 + f as i64 + sh;
                        let want = if w >= 0 { whole[0].get(w as usize).copied().unwrap_or(0) as i64 } else { 0 };
                        err += (c[f * p.nch] as i64 - want).abs();
                    }
                    if err < best.0 {
                        best = (err, sh);
                    }
                }
                eprintln!("  {pass}: chunk {k}: {bad} samples differ, best alignment shift {} frames", best.1);
            }
            bad_total += bad;
        }
        eprintln!("{pass}: {n} chunks, {bad_total} samples differ (worst {worst})");
    }
}

enum Decoded {
    Pcm(u32, Vec<Vec<i16>>),
    Packed(Arc<Packed>),
}

fn decode_or_pack(data: Vec<u8>, ext: Option<&str>) -> Result<Decoded, String> {
    let data = Arc::new(data);
    // A short file (length in the container under 30 s) is decoded with the reader that read its
    // length: opening a second one set the Vorbis decoder up twice (an ImpactJS game's 510 effects).
    let t0 = std::time::Instant::now();
    if let Ok(r) = Reader::open(data.clone(), ext) {
        let stream_off = std::env::var("POWERBOAT_AUDIO_STREAM").is_ok_and(|v| v == "0");
        if stream_off || r.frames.is_some_and(|f| (f as f64) < 30.0 * r.rate as f64) {
            let t1 = std::time::Instant::now();
            let out = decode_reader(r).map(|(rate, c)| if lazy_on() { Decoded::Packed(Packed::lazy(data.clone(), ext, rate, c)) } else { Decoded::Pcm(rate, c) });
            if std::env::var_os("POWERBOAT_AUDIO_DEBUG").is_some() {
                eprintln!("[powerboat] decode split {} bytes: open (probe + decoder setup) {:.1} ms, decode {:.1} ms", data.len(), (t1 - t0).as_secs_f64() * 1000.0, t1.elapsed().as_secs_f64() * 1000.0);
            }
            return out;
        }
    }
    let short = |data: Arc<Vec<u8>>, r: u32, c: Vec<Vec<i16>>| if lazy_on() { Decoded::Packed(Packed::lazy(data, ext, r, c)) } else { Decoded::Pcm(r, c) };
    match Packed::new_or_short(data.clone(), ext) {
        Ok(Ok(p)) => Ok(Decoded::Packed(p)),
        // Short WebM: its length was counted by decoding, and those samples are used.
        Ok(Err(Some((r, c)))) => Ok(short(data, r, c)),
        Ok(Err(None)) => decode_all(data.clone(), ext).map(|(r, c)| short(data, r, c)),
        Err(e) => {
            if std::env::var_os("POWERBOAT_AUDIO_DEBUG").is_some() {
                eprintln!("[powerboat] audio stream: {e}: decoding it whole");
            }
            decode_all(data, ext).map(|(r, c)| Decoded::Pcm(r, c))
        }
    }
}

// ---- ops --------------------------------------------------------------------------------------

fn sys(state: &mut OpState) -> Option<&mut AudioSys> {
    state.borrow_mut::<App>().audio.as_mut()
}

#[op2(fast)]
pub fn op_audio_available(state: &mut OpState) -> bool {
    state.borrow::<App>().audio.is_some()
}
#[op2(fast)]
pub fn op_audio_now(state: &mut OpState) -> f64 {
    sys(state).map(|s| s.now()).unwrap_or(0.0)
}
#[op2(fast)]
pub fn op_audio_rate(state: &mut OpState) -> u32 {
    sys(state).map(|s| s.rate).unwrap_or(44100)
}
#[op2(fast)]
pub fn op_audio_bytes(state: &mut OpState) -> f64 {
    sys(state).map(|s| s.bytes()).unwrap_or(0) as f64
}

/// kind: 1 gain, 2 panner, 3 buffer source, 4 pass-through, 5 stereo panner, 6 delay (arg: longest delay in
/// seconds), 7 filter, 8 oscillator.
#[op2(fast)]
pub fn op_audio_node_create(state: &mut OpState, kind: u32, arg: f64) -> u32 {
    let Some(s) = sys(state) else { return 0 };
    let rate = s.rate as f64;
    // Delay memory is made here, not with the audio thread waiting on the lock.
    let kind = match kind {
        1 => Kind::Gain(Param::new(1.0)),
        2 => Kind::Panner(Box::new(Panner::new())),
        3 => Kind::Source(Source::new()),
        5 => Kind::StereoPanner(Param::new(0.0)),
        6 => Kind::Delay(Box::new(Delay::new(arg, rate))),
        7 => Kind::Filter(Box::new(Filter::new())),
        8 => Kind::Oscillator(Box::new(Oscillator::new())),
        _ => Kind::Pass,
    };
    let mut m = s.mixer.lock().unwrap();
    let id = m.next;
    m.next += 1;
    m.nodes.insert(id, Node::new(kind));
    id
}
#[op2(fast)]
pub fn op_audio_node_free(state: &mut OpState, id: u32) {
    if let Some(s) = sys(state) {
        let mut m = s.mixer.lock().unwrap();
        m.nodes.remove(&id);
        m.modulated.retain(|(node, _)| *node != id);
    }
}
/// The AudioListener's node, for its params. One listener for all of a game's AudioContexts.
#[op2(fast)]
pub fn op_audio_listener() -> u32 {
    LISTENER
}
/// A node's setting that is no param. Panner: 0 distance model (0 inverse, 1 linear, 2 exponential), 1 refDistance,
/// 2 maxDistance, 3 rolloffFactor, 4 coneInnerAngle, 5 coneOuterAngle, 6 coneOuterGain. Filter and oscillator: 0 type,
/// as an index into their lists in Filter and Oscillator.
#[op2(fast)]
pub fn op_audio_node_set(state: &mut OpState, id: u32, field: u32, value: f64) {
    let Some(s) = sys(state) else { return };
    let mut m = s.mixer.lock().unwrap();
    let Some(n) = m.nodes.get_mut(&id) else { return };
    let v = value as f32;
    match (&mut n.kind, field) {
        (Kind::Panner(p), 0) => p.distance_model = value as u32,
        (Kind::Panner(p), 1) => p.ref_distance = v,
        (Kind::Panner(p), 2) => p.max_distance = v,
        (Kind::Panner(p), 3) => p.rolloff = v,
        (Kind::Panner(p), 4) => p.cone_inner = v,
        (Kind::Panner(p), 5) => p.cone_outer = v,
        (Kind::Panner(p), 6) => p.cone_outer_gain = v,
        (Kind::Filter(f), 0) => f.kind = value as u32,
        (Kind::Oscillator(o), 0) => o.wave = value as u32,
        _ => {}
    }
}
#[op2(fast)]
pub fn op_audio_connect(state: &mut OpState, from: u32, to: u32) {
    if let Some(s) = sys(state) {
        let mut m = s.mixer.lock().unwrap();
        if let Some(n) = m.nodes.get_mut(&from) {
            if !n.outputs.contains(&to) {
                n.outputs.push(to);
            }
        }
    }
}
/// to = u32::MAX disconnects everything.
#[op2(fast)]
pub fn op_audio_disconnect(state: &mut OpState, from: u32, to: u32) {
    if let Some(s) = sys(state) {
        let mut m = s.mixer.lock().unwrap();
        if let Some(n) = m.nodes.get_mut(&from) {
            if to == u32::MAX {
                n.outputs.clear();
                n.param_outputs.clear();
            } else {
                n.outputs.retain(|o| *o != to);
            }
        }
    }
}
/// node.connect(param): the node's output is added to the param, from the next pass on.
#[op2(fast)]
pub fn op_audio_connect_param(state: &mut OpState, from: u32, to: u32, slot: u32) {
    let Some(s) = sys(state) else { return };
    let mut m = s.mixer.lock().unwrap();
    let Some(p) = m.nodes.get_mut(&to).and_then(|n| n.kind.param(slot)) else { return };
    p.modulation.get_or_insert_with(|| Box::new(Modulation { now: vec![0.0; QUANTUM], next: vec![0.0; QUANTUM] }));
    if !m.modulated.contains(&(to, slot)) {
        m.modulated.push((to, slot));
    }
    if let Some(n) = m.nodes.get_mut(&from) {
        if !n.param_outputs.contains(&(to, slot)) {
            n.param_outputs.push((to, slot));
        }
    }
}
#[op2(fast)]
pub fn op_audio_disconnect_param(state: &mut OpState, from: u32, to: u32, slot: u32) {
    if let Some(s) = sys(state) {
        if let Some(n) = s.mixer.lock().unwrap().nodes.get_mut(&from) {
            n.param_outputs.retain(|t| *t != (to, slot));
        }
    }
}
/// slot: see Kind::param. kind: 0 set at time, 1 linear ramp, 2 exponential ramp, 3 setTarget
/// (approximated as a ramp over 3 time constants, `extra`), 4 set value now (cancels later events).
#[op2(fast)]
pub fn op_audio_param(state: &mut OpState, node: u32, slot: u32, kind: u32, value: f32, time: f64, extra: f32) {
    let Some(s) = sys(state) else { return };
    let now = s.now();
    let mut m = s.mixer.lock().unwrap();
    let Some(p) = m.nodes.get_mut(&node).and_then(|n| n.kind.param(slot)) else { return };
    match kind {
        0 => p.push(ParamEv { time, value, kind: EvKind::Set }),
        1 => p.push(ParamEv { time, value, kind: EvKind::Linear }),
        2 => p.push(ParamEv { time, value, kind: EvKind::Exp }),
        3 => p.push(ParamEv { time: time + 3.0 * extra.max(0.001) as f64, value, kind: EvKind::Exp }),
        _ => {
            p.cancel(now);
            p.value = value;
            p.push(ParamEv { time: now, value, kind: EvKind::Set });
        }
    }
}
#[op2(fast)]
pub fn op_audio_param_cancel(state: &mut OpState, node: u32, slot: u32, time: f64) {
    let Some(s) = sys(state) else { return };
    let mut m = s.mixer.lock().unwrap();
    if let Some(p) = m.nodes.get_mut(&node).and_then(|n| n.kind.param(slot)) {
        p.cancel(time);
    }
}
#[op2(fast)]
pub fn op_audio_param_get(state: &mut OpState, node: u32, slot: u32) -> f32 {
    let Some(s) = sys(state) else { return 0.0 };
    let now = s.now();
    let mut m = s.mixer.lock().unwrap();
    m.nodes.get_mut(&node).and_then(|n| n.kind.param(slot)).map_or(0.0, |p| p.at(now))
}
#[op2(fast)]
pub fn op_audio_source_buffer(state: &mut OpState, node: u32, buffer: u32) {
    let Some(s) = sys(state) else { return };
    let b = s.buffer_ref(buffer);
    let mut m = s.mixer.lock().unwrap();
    if let Some(Node { kind: Kind::Source(src), .. }) = m.nodes.get_mut(&node) {
        src.buf = b;
    }
}
#[op2(fast)]
pub fn op_audio_source_loop(state: &mut OpState, node: u32, looping: bool, start: f64, end: f64) {
    let Some(s) = sys(state) else { return };
    let mut m = s.mixer.lock().unwrap();
    if let Some(Node { kind: Kind::Source(src), .. }) = m.nodes.get_mut(&node) {
        src.looping = looping;
        src.loop_start = start;
        src.loop_end = end;
    }
}
#[op2(fast)]
pub fn op_audio_source_start(state: &mut OpState, node: u32, when: f64, offset: f64, duration: f64) {
    let Some(s) = sys(state) else { return };
    let now = s.now();
    let mut m = s.mixer.lock().unwrap();
    match m.nodes.get_mut(&node).map(|n| &mut n.kind) {
        Some(Kind::Source(src)) => {
            src.start_at = Some((when.max(now), offset));
            src.duration = if duration > 0.0 { Some(duration) } else { None };
        }
        Some(Kind::Oscillator(o)) => o.start_at = Some(when.max(now)),
        _ => {}
    }
}
#[op2(fast)]
pub fn op_audio_source_stop(state: &mut OpState, node: u32, when: f64) {
    let Some(s) = sys(state) else { return };
    let now = s.now();
    let mut m = s.mixer.lock().unwrap();
    match m.nodes.get_mut(&node).map(|n| &mut n.kind) {
        Some(Kind::Source(src)) => src.stop_at = Some(when.max(now)),
        Some(Kind::Oscillator(o)) => o.stop_at = Some(when.max(now)),
        _ => {}
    }
}
/// Sources that finished since the last poll (their onended fires in JS).
#[op2]
#[serde]
pub fn op_audio_poll_ended(state: &mut OpState) -> Vec<u32> {
    match sys(state) {
        Some(s) => std::mem::take(&mut s.mixer.lock().unwrap().ended),
        None => Vec::new(),
    }
}

/// decodeAudioData: ogg/vorbis (symphonia) on a blocking thread. Returns [id, rate, channels, frames].
#[op2]
#[serde]
pub async fn op_audio_decode(state: Rc<RefCell<OpState>>, #[buffer(copy)] data: Vec<u8>, #[string] ext: String) -> Result<(u32, u32, u32, u32), JsErrorBox> {
    let ext = if ext.is_empty() { None } else { Some(ext) };
    let t0 = std::time::Instant::now();
    let len = data.len();
    if std::env::var_os("POWERBOAT_AUDIO_DEBUG").is_some() { eprintln!("[powerboat] decode start {len} bytes"); }
    // At most two big decodes at once: each holds its compressed file and growing PCM until it is
    // done. Small files (sound effects, hundreds at boot) have three slots of their own, so they
    // never queue behind music.
    static DECODES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    static SMALL: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);
    let sem = if len < 256 * 1024 { &SMALL } else { &DECODES };
    let _slot = sem.acquire().await.map_err(|e| JsErrorBox::generic(e.to_string()))?;
    let waited = t0.elapsed().as_millis();
    let decoded = tokio::task::spawn_blocking(move || decode_or_pack(data, ext.as_deref()))
        .await
        .map_err(|e| JsErrorBox::generic(e.to_string()))?
        .map_err(JsErrorBox::generic)?;
    let (rate, channels, packed) = match decoded {
        Decoded::Pcm(r, c) => (r, c, None),
        Decoded::Packed(p) => (p.rate, Vec::new(), Some(p)),
    };
    let frames = packed.as_ref().map_or_else(|| channels.first().map(|c| c.len()).unwrap_or(0), |p| p.frames);
    let nch = packed.as_ref().map_or(channels.len(), |p| p.nch) as u32;
    if std::env::var_os("POWERBOAT_AUDIO_DEBUG").is_some() { eprintln!("[powerboat] decode done {len} bytes in {} ms (queued {waited} ms)", t0.elapsed().as_millis()); }
    let mut st = state.borrow_mut();
    let Some(s) = sys(&mut st) else { return Err(JsErrorBox::generic("audio not available")) };
    let id = s.next_buffer;
    s.next_buffer += 1;
    if packed.is_some() && std::env::var_os("POWERBOAT_AUDIO_DEBUG").is_some() {
        eprintln!("[powerboat] audio: {len} bytes kept compressed ({:.0} s)", frames as f64 / rate as f64);
    }
    s.buffers.insert(id, Rc::new(RefCell::new(AudioBuf { rate, frames, channels: channels.into_iter().map(to_pcm16).collect(), packed })));
    Ok((id, rate, nch, frames as u32))
}
#[op2(fast)]
pub fn op_audio_buffer_create(state: &mut OpState, channels: u32, frames: u32, rate: u32) -> u32 {
    let Some(s) = sys(state) else { return 0 };
    let id = s.next_buffer;
    s.next_buffer += 1;
    let channels = (0..channels.clamp(1, 8)).map(|_| Channel::Pending(vec![0.0; frames as usize])).collect();
    s.buffers.insert(id, Rc::new(RefCell::new(AudioBuf { rate, frames: frames as usize, channels, packed: None })));
    id
}
/// The ArrayBuffer behind one channel (shared with the mixer; getChannelData writes through).
#[op2]
pub fn op_audio_buffer_channel<'s>(scope: &mut v8::PinScope<'s, '_>, state: &mut OpState, id: u32, ch: u32) -> v8::Local<'s, v8::ArrayBuffer> {
    let Some(s) = sys(state) else { return v8::ArrayBuffer::new(scope, 0) };
    let Some(b) = s.buffers.get(&id) else { return v8::ArrayBuffer::new(scope, 0) };
    let mut b = b.borrow_mut();
    // JS reads a packed file's samples: decode it whole now (sources playing keep the packed copy).
    if let Some(p) = b.packed.take() {
        match p.decode_whole() {
            Ok((_, chans)) => b.channels = chans.into_iter().map(to_pcm16).collect(),
            Err(e) => eprintln!("[powerboat] audio getChannelData: {e}"),
        }
    }
    let Some(chan) = b.channels.get_mut(ch as usize) else { return v8::ArrayBuffer::new(scope, 0) };
    if let Channel::Pending(v) = chan {
        let data = std::mem::take(v);
        *chan = Channel::Shared(vec_to_store(data));
    }
    if let Channel::Pcm16(v) = chan {
        // JS wants the samples: from here on this channel is f32 (sources already playing keep
        // reading the i16 copy they hold).
        let data: Vec<f32> = v.iter().map(|s| *s as f32 * (1.0 / 32768.0)).collect();
        *chan = Channel::Shared(vec_to_store(data));
    }
    match chan {
        Channel::Shared(store) => v8::ArrayBuffer::with_backing_store(scope, store),
        _ => v8::ArrayBuffer::new(scope, 0),
    }
}
#[op2(fast)]
pub fn op_audio_buffer_free(state: &mut OpState, id: u32) {
    if let Some(s) = sys(state) {
        s.buffers.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How many buffer frames 100 output frames advance, with the buffer's rate equal to the output's.
    fn frames_played(rate: f32, detune: f32) -> f64 {
        let mut s = Source::new();
        s.buf = Some(Arc::new(BufRef { rate: 1000, frames: 10_000, stores: vec![ChanRef::I16(Arc::new(vec![1000; 10_000]))], packed: None }));
        s.start_at = Some((0.0, 0.0));
        s.rate = Param::new(rate);
        s.detune = Param::new(detune);
        let mut block = vec![0.0; 200];
        assert!(render_source(&mut s, &mut block, 0.0, 1000.0));
        s.pos.unwrap()
    }

    #[test]
    fn detune_is_cents_on_top_of_the_playback_rate() {
        assert_eq!(frames_played(1.0, 0.0), 100.0);
        assert_eq!(frames_played(2.0, 0.0), 200.0);
        assert_eq!(frames_played(1.0, 1200.0), 200.0);
        assert_eq!(frames_played(1.0, -1200.0), 50.0);
        assert_eq!(frames_played(2.0, -1200.0), 100.0);
    }

    /// One shared value was the bug: source.detune.value = 100 set the playback rate to 100.
    #[test]
    fn a_source_keeps_its_two_params_apart() {
        let mut k = Kind::Source(Source::new());
        k.param(1).unwrap().value = 100.0;
        assert_eq!(k.param(0).unwrap().value, 1.0);
        assert_eq!(k.param(1).unwrap().value, 100.0);
    }

    #[test]
    fn only_real_mixer_params_have_a_slot() {
        assert!(Kind::Gain(Param::new(1.0)).param(0).is_some());
        assert!(Kind::StereoPanner(Param::new(0.0)).param(0).is_some());
        assert!(Kind::Gain(Param::new(1.0)).param(1).is_none());
        assert!(Kind::Source(Source::new()).param(2).is_none());
        assert!(Kind::Pass.param(0).is_none());
        assert!(Kind::Panner(Box::new(Panner::new())).param(5).is_some());
        assert!(Kind::Panner(Box::new(Panner::new())).param(6).is_none());
        assert!(Kind::Filter(Box::new(Filter::new())).param(3).is_some());
        assert!(Kind::Filter(Box::new(Filter::new())).param(4).is_none());
        assert!(Kind::Oscillator(Box::new(Oscillator::new())).param(1).is_some());
        assert!(Kind::Delay(Box::new(Delay::new(1.0, 44100.0))).param(1).is_none());
    }

    // ---- a small graph builder ----------------------------------------------------------------

    const RATE: u32 = 44100;
    const DEST: u32 = 0;

    fn mixer() -> Mixer {
        Mixer::new(RATE, 1.0, Arc::new(AtomicU64::new(0)))
    }

    impl Mixer {
        fn add(&mut self, kind: Kind) -> u32 {
            let id = self.next;
            self.next += 1;
            self.nodes.insert(id, Node::new(kind));
            id
        }
        fn wire(&mut self, from: u32, to: u32) {
            self.nodes.get_mut(&from).unwrap().outputs.push(to);
        }
        /// node.connect(param), as op_audio_connect_param does it.
        fn wire_param(&mut self, from: u32, to: u32, slot: u32) {
            let p = self.nodes.get_mut(&to).unwrap().kind.param(slot).unwrap();
            p.modulation = Some(Box::new(Modulation { now: vec![0.0; QUANTUM], next: vec![0.0; QUANTUM] }));
            self.modulated.push((to, slot));
            self.nodes.get_mut(&from).unwrap().param_outputs.push((to, slot));
        }
        fn gain(&mut self, g: f32) -> u32 {
            self.add(Kind::Gain(Param::new(g)))
        }
        fn play(&mut self, samples: Vec<f32>) -> u32 {
            let frames = samples.len();
            let pcm = samples.iter().map(|v| to_i16(*v)).collect::<Vec<i16>>();
            let mut s = Source::new();
            s.buf = Some(Arc::new(BufRef { rate: RATE, frames, stores: vec![ChanRef::I16(Arc::new(pcm))], packed: None }));
            s.start_at = Some((0.0, 0.0));
            self.add(Kind::Source(s))
        }
        fn oscillator(&mut self, wave: u32, hz: f32) -> u32 {
            let mut o = Oscillator::new();
            o.wave = wave;
            o.frequency = Param::new(hz);
            o.start_at = Some(0.0);
            self.add(Kind::Oscillator(Box::new(o)))
        }
        /// The next `frames` frames, in callbacks of BLOCK, one channel.
        fn left(&mut self, frames: usize) -> Vec<f32> {
            self.stereo(frames).chunks_exact(2).map(|fr| fr[0]).collect()
        }
        fn stereo(&mut self, frames: usize) -> Vec<f32> {
            let mut all = vec![0.0; frames * 2];
            for chunk in all.chunks_mut(BLOCK * 2) {
                self.render(chunk);
            }
            all
        }
    }

    fn sine(hz: f32, frames: usize, level: f32) -> Vec<f32> {
        (0..frames).map(|i| level * (std::f32::consts::TAU * hz * i as f32 / RATE as f32).sin()).collect()
    }

    fn rms(v: &[f32]) -> f32 {
        (v.iter().map(|x| x * x).sum::<f32>() / v.len() as f32).sqrt()
    }

    fn peak(v: &[f32]) -> f32 {
        v.iter().fold(0.0, |m, x| m.max(x.abs()))
    }

    fn close(a: f32, b: f32, tolerance: f32, what: &str) {
        assert!((a - b).abs() <= tolerance, "{what}: {a} is not within {tolerance} of {b}");
    }

    // ---- paths --------------------------------------------------------------------------------

    /// MV's graph: one pass per callback, and the numbers it always gave.
    #[test]
    fn a_plain_chain_is_one_pass_and_keeps_its_level() {
        let mut m = mixer();
        let src = m.play(vec![0.5; 5000]);
        let gain = m.gain(0.5);
        m.wire(src, gain);
        m.wire(gain, DEST);
        let out = m.left(3000);
        assert!(out.iter().all(|v| *v == 0.25), "first wrong value: {:?}", out.iter().find(|v| **v != 0.25));
    }

    #[test]
    fn a_node_with_two_outputs_plays_both() {
        let mut m = mixer();
        let src = m.play(vec![0.5; 5000]);
        let (wet, dry) = (m.gain(0.25), m.gain(0.75));
        for g in [wet, dry] {
            m.wire(src, g);
            m.wire(g, DEST);
        }
        assert!(m.left(1000).iter().all(|v| (*v - 0.5).abs() < 1e-6));
    }

    /// The old walk followed the first output and went silent at a dead end.
    #[test]
    fn a_dead_end_output_does_not_silence_the_others() {
        let mut m = mixer();
        let src = m.play(vec![0.5; 5000]);
        let nowhere = m.add(Kind::Pass);
        m.wire(src, nowhere);
        m.wire(src, DEST);
        assert!(m.left(1000).iter().all(|v| (*v - 0.5).abs() < 1e-6));
    }

    #[test]
    fn a_cycle_with_no_delay_in_it_cannot_hang_and_its_way_out_still_plays() {
        let mut m = mixer();
        let src = m.play(vec![0.5; 5000]);
        let (a, b) = (m.gain(1.0), m.gain(1.0));
        m.wire(src, a);
        m.wire(a, b);
        m.wire(b, a);
        m.wire(b, DEST);
        assert!(m.left(1000).iter().all(|v| (*v - 0.5).abs() < 1e-6));
    }

    #[test]
    fn many_outputs_cannot_take_the_audio_thread_with_them() {
        let mut m = mixer();
        let src = m.play(vec![0.5; 5000]);
        // Every layer fans out to two nodes of the next: 2^20 paths with nothing to stop them.
        let mut layer = vec![src];
        for _ in 0..20 {
            let (x, y) = (m.gain(1.0), m.gain(1.0));
            for &from in &layer {
                m.wire(from, x);
                m.wire(from, y);
            }
            layer = vec![x, y];
        }
        for &from in &layer {
            m.wire(from, DEST);
        }
        let t = std::time::Instant::now();
        m.left(BLOCK * 4);
        assert!(t.elapsed().as_secs() < 2, "{:?}", t.elapsed());
    }

    // ---- delay --------------------------------------------------------------------------------

    fn first_sound(v: &[f32]) -> Option<usize> {
        v.iter().position(|x| x.abs() > 1e-3)
    }

    #[test]
    fn a_delay_plays_late_by_its_time_and_never_early() {
        let mut m = mixer();
        let mut click = vec![0.0; 100];
        click[0] = 0.9;
        let src = m.play(click);
        let mut d = Delay::new(1.0, RATE as f64);
        d.time = Param::new(0.1);
        let d = m.add(Kind::Delay(Box::new(d)));
        m.wire(src, d);
        m.wire(d, DEST);
        let out = m.left(RATE as usize / 2);
        close(first_sound(&out).unwrap() as f32, 4410.0, 1.0, "echo at");
        close(peak(&out), 0.9, 0.01, "echo level");
    }

    #[test]
    fn a_delay_of_nothing_is_one_quantum_as_in_a_browser_loop() {
        let mut m = mixer();
        let src = m.play(vec![0.5; 4096]);
        let d = m.add(Kind::Delay(Box::new(Delay::new(1.0, RATE as f64))));
        m.wire(src, d);
        m.wire(d, DEST);
        assert_eq!(first_sound(&m.left(1024)), Some(QUANTUM));
    }

    /// Construct's Delay effect: input -> main -> wet -> out, main -> delay -> gain -> main.
    #[test]
    fn a_feedback_loop_repeats_fades_and_then_costs_nothing() {
        let mut m = mixer();
        let mut click = vec![0.0; 4];
        click[0] = 0.8;
        let src = m.play(click);
        let (main, feedback) = (m.gain(1.0), m.gain(0.5));
        let mut d = Delay::new(0.1, RATE as f64);
        d.time = Param::new(0.05);
        let delay = m.add(Kind::Delay(Box::new(d)));
        m.wire(src, main);
        m.wire(main, DEST);
        m.wire(main, delay);
        m.wire(delay, feedback);
        m.wire(feedback, main);
        let out = m.left(RATE as usize);
        let at = |t: f32| peak(&out[(t * RATE as f32) as usize - 50..(t * RATE as f32) as usize + 50]);
        close(at(0.05), 0.4, 0.02, "first repeat");
        close(at(0.10), 0.2, 0.02, "second");
        close(at(0.15), 0.1, 0.02, "third");
        // Long after: silent, and the ring has stopped running.
        m.left(RATE as usize * 3);
        assert_eq!(peak(&m.left(BLOCK)), 0.0);
        let Kind::Delay(d) = &m.nodes[&delay].kind else { panic!() };
        assert_eq!(d.tail, 0);
    }

    #[test]
    fn a_runaway_feedback_loop_stays_finite() {
        let mut m = mixer();
        let src = m.play(vec![0.5; 2000]);
        let (main, feedback) = (m.gain(1.0), m.gain(3.0));
        let delay = m.add(Kind::Delay(Box::new(Delay::new(0.1, RATE as f64))));
        m.wire(src, main);
        m.wire(main, DEST);
        m.wire(main, delay);
        m.wire(delay, feedback);
        m.wire(feedback, main);
        assert!(m.left(RATE as usize).iter().all(|v| v.is_finite()));
    }

    /// Flanger: an oscillator moves the delay's time, which only works reading between frames.
    #[test]
    fn a_modulated_delay_bends_pitch() {
        let mut m = mixer();
        let src = m.play(sine(1000.0, RATE as usize, 0.5));
        let mut d = Delay::new(0.1, RATE as f64);
        d.time = Param::new(0.05);
        let delay = m.add(Kind::Delay(Box::new(d)));
        let lfo = m.oscillator(0, 5.0);
        let depth = m.gain(0.002);
        m.wire(src, delay);
        m.wire(delay, DEST);
        m.wire(lfo, depth);
        m.wire_param(depth, delay, 0);
        let out = m.left(RATE as usize);
        // Zero crossings per 0.05 s: the moving delay pushes a steady 1 kHz up and down, by about 2 pi f d / lfo period.
        let crossings = |v: &[f32]| v.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        let span = RATE as usize / 20;
        let counts: Vec<usize> = out[RATE as usize / 4..].chunks(span).map(crossings).collect();
        let (low, high) = (counts.iter().min().unwrap(), counts.iter().max().unwrap());
        assert!(high > low, "steady pitch: {counts:?}");
        close(rms(&out[RATE as usize / 2..]), 0.5 / 2f32.sqrt(), 0.03, "level");
    }

    // ---- filter -------------------------------------------------------------------------------

    /// Level out over level in, of a sine through a filter.
    fn through_filter(kind: u32, f: f32, q: f32, gain: f32, tone: f32) -> f32 {
        let mut m = mixer();
        let src = m.play(sine(tone, RATE as usize, 0.25));
        let mut filter = Filter::new();
        filter.kind = kind;
        filter.frequency = Param::new(f);
        filter.q = Param::new(q);
        filter.gain = Param::new(gain);
        let filter = m.add(Kind::Filter(Box::new(filter)));
        m.wire(src, filter);
        m.wire(filter, DEST);
        let out = m.left(RATE as usize / 2);
        rms(&out[RATE as usize / 4..]) / (0.25 / 2f32.sqrt())
    }

    fn db(v: f32) -> f32 {
        20.0 * v.log10()
    }

    const LOWPASS: u32 = 0;
    const HIGHPASS: u32 = 1;
    const BANDPASS: u32 = 2;
    const LOWSHELF: u32 = 3;
    const HIGHSHELF: u32 = 4;
    const PEAKING: u32 = 5;
    const NOTCH: u32 = 6;
    const ALLPASS: u32 = 7;

    /// Each type at the points whose response the spec's formulas fix exactly.
    #[test]
    fn every_filter_type_has_its_textbook_response() {
        // Q is in dB for these two: 0 dB means a flat 0 dB at the corner.
        close(db(through_filter(LOWPASS, 1000.0, 0.0, 0.0, 1000.0)), 0.0, 0.2, "lowpass at f");
        close(db(through_filter(LOWPASS, 1000.0, 6.0, 0.0, 1000.0)), 6.0, 0.2, "lowpass at f, Q 6 dB");
        close(db(through_filter(LOWPASS, 1000.0, 0.0, 0.0, 100.0)), 0.0, 0.2, "lowpass below");
        assert!(db(through_filter(LOWPASS, 1000.0, 0.0, 0.0, 8000.0)) < -30.0, "lowpass above");
        close(db(through_filter(HIGHPASS, 1000.0, 0.0, 0.0, 1000.0)), 0.0, 0.2, "highpass at f");
        close(db(through_filter(HIGHPASS, 1000.0, 0.0, 0.0, 10000.0)), 0.0, 0.2, "highpass above");
        assert!(db(through_filter(HIGHPASS, 1000.0, 0.0, 0.0, 100.0)) < -30.0, "highpass below");
        close(db(through_filter(BANDPASS, 1000.0, 2.0, 0.0, 1000.0)), 0.0, 0.2, "bandpass at f");
        assert!(db(through_filter(BANDPASS, 1000.0, 2.0, 0.0, 100.0)) < -20.0, "bandpass below");
        assert!(db(through_filter(BANDPASS, 1000.0, 2.0, 0.0, 8000.0)) < -20.0, "bandpass above");
        close(db(through_filter(LOWSHELF, 1000.0, 1.0, 6.0, 50.0)), 6.0, 0.2, "lowshelf below");
        close(db(through_filter(LOWSHELF, 1000.0, 1.0, 6.0, 15000.0)), 0.0, 0.2, "lowshelf above");
        close(db(through_filter(HIGHSHELF, 1000.0, 1.0, 6.0, 15000.0)), 6.0, 0.2, "highshelf above");
        close(db(through_filter(HIGHSHELF, 1000.0, 1.0, 6.0, 50.0)), 0.0, 0.2, "highshelf below");
        close(db(through_filter(PEAKING, 1000.0, 1.0, 6.0, 1000.0)), 6.0, 0.2, "peaking at f");
        close(db(through_filter(PEAKING, 1000.0, 1.0, 6.0, 50.0)), 0.0, 0.2, "peaking far off");
        assert!(db(through_filter(NOTCH, 1000.0, 5.0, 0.0, 1000.0)) < -30.0, "notch at f");
        close(db(through_filter(NOTCH, 1000.0, 5.0, 0.0, 5000.0)), 0.0, 0.2, "notch far off");
        for tone in [100.0, 1000.0, 8000.0] {
            close(db(through_filter(ALLPASS, 1000.0, 1.0, 0.0, tone)), 0.0, 0.2, "allpass");
        }
    }

    #[test]
    fn a_filter_sums_its_inputs_before_filtering() {
        // Two sources into one filter: the state must see their sum once, not each in turn.
        let run = |pair: bool| {
            let mut m = mixer();
            let mut filter = Filter::new();
            filter.frequency = Param::new(800.0);
            let filter = m.add(Kind::Filter(Box::new(filter)));
            m.wire(filter, DEST);
            let level = if pair { 0.125 } else { 0.25 };
            for _ in 0..if pair { 2 } else { 1 } {
                let src = m.play(sine(3000.0, RATE as usize / 2, level));
                m.wire(src, filter);
            }
            m.left(RATE as usize / 4)
        };
        let (one, two) = (run(false), run(true));
        for (a, b) in one.iter().zip(two.iter()) {
            close(*a, *b, 2e-4, "one source against two at half level");
        }
    }

    #[test]
    fn a_filter_rings_out_after_its_input_stops_then_rests() {
        let mut m = mixer();
        let src = m.play(sine(1000.0, 2048, 0.5));
        let mut filter = Filter::new();
        filter.frequency = Param::new(1000.0);
        filter.q = Param::new(30.0); // 30 dB: a long ring
        let filter = m.add(Kind::Filter(Box::new(filter)));
        m.wire(src, filter);
        m.wire(filter, DEST);
        let out = m.left(RATE as usize / 2);
        assert!(peak(&out[2200..2400]) > 0.01, "no ring after the source ended");
        m.left(RATE as usize * 2);
        assert_eq!(peak(&m.left(BLOCK)), 0.0);
        let Kind::Filter(f) = &m.nodes[&filter].kind else { panic!() };
        assert_eq!(f.state, [[0.0; 2]; 2]);
    }

    /// Phaser: an oscillator moves the corner of a filter.
    #[test]
    fn a_modulated_filter_moves_with_it() {
        let mut m = mixer();
        let src = m.play(sine(2000.0, RATE as usize * 2, 0.5));
        let mut filter = Filter::new();
        filter.frequency = Param::new(1000.0);
        let filter = m.add(Kind::Filter(Box::new(filter)));
        let lfo = m.oscillator(0, 2.0);
        let depth = m.gain(900.0);
        m.wire(src, filter);
        m.wire(filter, DEST);
        m.wire(lfo, depth);
        m.wire_param(depth, filter, 0);
        let out = m.left(RATE as usize);
        let span = RATE as usize / 10;
        let levels: Vec<f32> = out.chunks(span).map(rms).collect();
        let (low, high) = levels.iter().fold((f32::MAX, 0.0f32), |(l, h), v| (l.min(*v), h.max(*v)));
        assert!(high > low * 3.0, "level hardly moved: {levels:?}");
    }

    // ---- oscillator ---------------------------------------------------------------------------

    fn crossings_per_second(v: &[f32]) -> f32 {
        v.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count() as f32 * RATE as f32 / v.len() as f32
    }

    #[test]
    fn every_wave_plays_its_frequency_at_full_level() {
        // Expected RMS of a full-scale wave.
        for (wave, level) in [(0, 0.7071), (1, 1.0), (2, 0.5774), (3, 0.5774)] {
            let mut m = mixer();
            let o = m.oscillator(wave, 441.0);
            m.wire(o, DEST);
            let out = m.left(RATE as usize);
            close(crossings_per_second(&out), 441.0, 2.0, "frequency");
            close(rms(&out), level, 0.02, "level");
            assert!(peak(&out) <= 1.0);
        }
    }

    #[test]
    fn oscillators_start_where_a_browser_does() {
        for (wave, first) in [(0, 0.0), (1, 1.0), (2, 0.0), (3, 0.0)] {
            let mut o = Oscillator::new();
            o.wave = wave;
            close(Oscillator::sample(wave, 0.25, 0.001), [1.0, 1.0, 0.5, 1.0][wave as usize], 0.001, "a quarter in");
            let v = Oscillator::sample(wave, 0.5 / 44100.0, 0.0);
            close(v, first, 0.01, "at the start");
        }
    }

    #[test]
    fn detune_shifts_an_oscillator_by_cents() {
        let mut m = mixer();
        let o = m.oscillator(0, 440.0);
        let Kind::Oscillator(osc) = &mut m.nodes.get_mut(&o).unwrap().kind else { panic!() };
        osc.detune = Param::new(1200.0);
        m.wire(o, DEST);
        close(crossings_per_second(&m.left(RATE as usize)), 880.0, 2.0, "an octave up");
    }

    #[test]
    fn an_oscillator_keeps_to_its_start_and_stop_and_says_so() {
        let mut m = mixer();
        let o = m.oscillator(1, 1000.0);
        let Kind::Oscillator(osc) = &mut m.nodes.get_mut(&o).unwrap().kind else { panic!() };
        osc.start_at = Some(0.01);
        osc.stop_at = Some(0.03);
        m.wire(o, DEST);
        let out = m.left(RATE as usize / 10);
        close(first_sound(&out).unwrap() as f32, 441.0, 1.0, "start");
        let last = out.iter().rposition(|x| x.abs() > 1e-3).unwrap();
        close(last as f32, 1323.0, 2.0, "stop");
        assert_eq!(m.ended, vec![o]);
        assert!(!m.nodes.contains_key(&o), "retired");
    }

    #[test]
    fn an_oscillator_past_nyquist_is_silent() {
        let mut m = mixer();
        let o = m.oscillator(0, 30000.0);
        m.wire(o, DEST);
        assert_eq!(peak(&m.left(BLOCK)), 0.0);
    }

    #[test]
    fn a_frequency_can_be_modulated() {
        let mut m = mixer();
        let carrier = m.oscillator(0, 1000.0);
        let lfo = m.oscillator(1, 2.0);
        let depth = m.gain(500.0);
        m.wire(carrier, DEST);
        m.wire(lfo, depth);
        m.wire_param(depth, carrier, 0);
        let out = m.left(RATE as usize);
        // A square at 2 Hz: a quarter second at 1500 Hz, a quarter second at 500 Hz.
        close(crossings_per_second(&out[2000..RATE as usize / 4 - 2000]), 1500.0, 10.0, "up");
        close(crossings_per_second(&out[RATE as usize / 4 + 2000..RATE as usize / 2 - 2000]), 500.0, 10.0, "down");
    }

    // ---- modulated gains ----------------------------------------------------------------------

    /// Tremolo: base gain 1 - d/2, plus an oscillator at d/2.
    #[test]
    fn tremolo_moves_the_level_between_its_limits() {
        let mut m = mixer();
        let src = m.play(vec![0.5; RATE as usize]);
        let node = m.gain(0.75);
        let lfo = m.oscillator(0, 5.0);
        let depth = m.gain(0.25);
        m.wire(src, node);
        m.wire(node, DEST);
        m.wire(lfo, depth);
        m.wire_param(depth, node, 0);
        let out = m.left(RATE as usize);
        let (low, high) = out[2000..].iter().fold((f32::MAX, 0.0f32), |(l, h), v| (l.min(*v), h.max(*v)));
        close(low, 0.25, 0.01, "lowest");
        close(high, 0.5, 0.01, "highest");
        close(crossings_per_second(&out.iter().map(|v| v - 0.375).collect::<Vec<_>>()), 5.0, 1.0, "rate");
    }

    /// Ring modulation: a gain at 0 driven only by an oscillator multiplies the signal by it.
    #[test]
    fn ring_modulation_multiplies() {
        let mut m = mixer();
        let src = m.play(sine(1000.0, RATE as usize, 0.5));
        let ring = m.gain(0.0);
        let lfo = m.oscillator(0, 100.0);
        m.wire(src, ring);
        m.wire(ring, DEST);
        m.wire_param(lfo, ring, 0);
        let out = m.left(RATE as usize);
        // One pass late, the input arrives; from there on it is the product of the two sines.
        let late = QUANTUM;
        for (i, v) in out.iter().enumerate().skip(late * 2) {
            let carrier = 0.5 * (std::f32::consts::TAU * 1000.0 * i as f32 / RATE as f32).sin();
            let lfo = (std::f32::consts::TAU * 100.0 * (i - late) as f32 / RATE as f32).sin();
            close(*v, carrier * lfo, 0.001, "product");
        }
    }

    #[test]
    fn an_unconnected_param_input_is_no_input() {
        let mut m = mixer();
        let src = m.play(vec![0.5; 5000]);
        let gain = m.gain(0.5);
        let lfo = m.oscillator(0, 100.0);
        m.wire(src, gain);
        m.wire(gain, DEST);
        m.wire_param(lfo, gain, 0);
        m.left(BLOCK);
        m.nodes.get_mut(&lfo).unwrap().param_outputs.clear();
        m.left(QUANTUM * 2);
        assert!(m.left(1000).iter().all(|v| *v == 0.25));
    }

    // ---- panning ------------------------------------------------------------------------------

    fn panner_at(x: f32, y: f32, z: f32) -> Panner {
        let mut p = Panner::new();
        p.position = [Param::new(x), Param::new(y), Param::new(z)];
        p
    }

    const AT_ORIGIN: [f32; 9] = [0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0];

    /// MV's setPosition(pan, 0, 1 - |pan|) through the formula it always had: not one sample may change.
    #[test]
    fn mv_panning_is_exactly_what_it_was() {
        for i in -100..=100 {
            let pan = i as f32 / 100.0;
            let (x, z) = (pan, 1.0 - pan.abs());
            let az = x.atan2(-z).to_degrees();
            let az = if az < -90.0 { -180.0 - az } else if az > 90.0 { 180.0 - az } else { az };
            let old = (az / 90.0).clamp(-1.0, 1.0);
            let (new, level) = panner_at(x, 0.0, z).spatial(&AT_ORIGIN, 0.0);
            assert_eq!(new, old, "pan {pan}");
            assert_eq!(level, 1.0, "level at pan {pan}");
        }
    }

    #[test]
    fn panning_follows_the_listener() {
        let spot = |x: f32, listener: [f32; 3]| panner_at(x, 0.0, 0.0).spatial(&[listener[0], listener[1], listener[2], 0.0, 0.0, -1.0, 0.0, 1.0, 0.0], 0.0).0;
        // Phaser's numbers: world coordinates, with the listener on the camera.
        close(spot(400.0, [400.0, 300.0, 0.0]), 0.0, 1e-4, "straight above or below: centered");
        close(spot(500.0, [400.0, 0.0, 0.0]), 1.0, 1e-4, "right of the listener");
        close(spot(300.0, [400.0, 0.0, 0.0]), -1.0, 1e-4, "left of the listener");
        // Turned to face +x: a source there is straight ahead, one at -z to the left.
        let turned = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        close(panner_at(10.0, 0.0, 0.0).spatial(&turned, 0.0).0, 0.0, 1e-4, "ahead");
        close(panner_at(0.0, 0.0, -10.0).spatial(&turned, 0.0).0, -1.0, 1e-4, "left");
        close(panner_at(0.0, 0.0, 10.0).spatial(&turned, 0.0).0, 1.0, 1e-4, "right");
        // 45 degrees off to the right, ahead or behind, comes out the same.
        close(panner_at(1.0, 0.0, -1.0).spatial(&AT_ORIGIN, 0.0).0, 0.5, 1e-4, "front right");
        close(panner_at(1.0, 0.0, 1.0).spatial(&AT_ORIGIN, 0.0).0, 0.5, 1e-4, "back right");
    }

    #[test]
    fn the_distance_models_give_the_specs_numbers() {
        let level = |model: u32, ref_distance: f32, rolloff: f32, d: f32| {
            let mut p = panner_at(d, 0.0, 0.0);
            p.distance_model = model;
            p.ref_distance = ref_distance;
            p.rolloff = rolloff;
            p.max_distance = 100.0;
            p.spatial(&AT_ORIGIN, 0.0).1
        };
        close(level(0, 1.0, 1.0, 0.5), 1.0, 1e-5, "inverse inside ref");
        close(level(0, 1.0, 1.0, 10.0), 0.1, 1e-5, "inverse");
        close(level(0, 2.0, 0.5, 10.0), 2.0 / (2.0 + 0.5 * 8.0), 1e-5, "inverse with rolloff");
        close(level(1, 10.0, 1.0, 55.0), 0.5, 1e-5, "linear halfway");
        close(level(1, 10.0, 1.0, 500.0), 0.0, 1e-5, "linear past max");
        close(level(2, 1.0, 1.0, 10.0), 0.1, 1e-5, "exponential");
        close(level(2, 1.0, 2.0, 10.0), 0.01, 1e-5, "exponential with rolloff");
    }

    #[test]
    fn a_sound_cone_dims_what_faces_away() {
        let level = |facing: [f32; 3]| {
            let mut p = panner_at(0.0, 0.0, -1.0);
            p.orientation = facing.map(Param::new);
            p.cone_inner = 60.0;
            p.cone_outer = 120.0;
            p.cone_outer_gain = 0.25;
            p.spatial(&AT_ORIGIN, 0.0).1
        };
        close(level([0.0, 0.0, 1.0]), 1.0, 1e-4, "facing the listener");
        close(level([0.0, 0.0, -1.0]), 0.25, 1e-4, "facing away");
        close(level([1.0, 0.0, 1.0]), 0.625, 1e-3, "halfway between the cones");
    }

    #[test]
    fn a_panner_applies_its_level_and_position_changes_take_effect() {
        let mut m = mixer();
        let src = m.play(vec![0.5; RATE as usize]);
        let p = m.add(Kind::Panner(Box::new(panner_at(0.0, 0.0, -10.0))));
        m.wire(src, p);
        m.wire(p, DEST);
        let out = m.stereo(BLOCK);
        close(out[0], 0.05, 1e-3, "left at distance 10");
        close(out[1], 0.05, 1e-3, "right at distance 10");
        let Kind::Listener(l) = &mut m.nodes.get_mut(&LISTENER).unwrap().kind else { panic!() };
        l[0] = Param::new(-1.0);
        l[2] = Param::new(-10.0);
        let out = m.stereo(BLOCK);
        // The listener moved 1 to its left: the source is now 1 to the right, at distance 1.
        close(out[out.len() - 2], 0.0, 1e-3, "left");
        close(out[out.len() - 1], 1.0, 1e-3, "right holds both channels");
    }
}
