//! WebGL's GL calls on a thread of their own (POWERBOAT_GL_THREAD=1; off by default).
//!
//! The JS thread otherwise waits inside the driver for every draw, clear, framebuffer switch and swap.
//! Here glow gets trampolines from its loader instead of the driver's functions, so all the code using
//! `app.gl` stays as it is: a call that returns nothing is queued for this thread, with its data copied;
//! a call that answers (glGet*, a large upload from a pointer the caller owns) waits for the queue to run
//! empty and then runs here while the JS thread waits. Mesa's glthread works the same way.
//!
//! The answers asked for every frame come from a shadow copy on the JS thread: clear_drawing_buffer and
//! present_game put back scissor, clear values, masks and the bound framebuffer; Phaser 2 reads the bound
//! texture, active unit, viewport, blend and vertex array several times a frame. One wait per frame would
//! give back everything gained. A game that makes textures while it plays
//! (Moonstone Island: about one every two frames) must not wait either: glGen* names come from a pool the
//! GL thread keeps filled, and uploads up to MAX_COPY_TEX are copied and queued.
//!
//! The swap is queued too. The JS thread may run one frame ahead of what has been swapped; a frame
//! later it waits for the swap before that, which paces it to the driver and the display as its own
//! swap did.
//!
//! The window surface moves to this thread, so the paths that need a current context on the JS thread
//! find none and take their fallbacks: `upload::main_ctx` (2D pages draw on the CPU path) and
//! zero-copy video (`yuvgl`, no current EGL display).

use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, c_int, c_void};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering, Ordering::Relaxed};
use std::sync::{Condvar, Mutex};
use std::time::Instant;

use sdl2::sys::{SDL_GL_MakeCurrent, SDL_GL_SetSwapInterval, SDL_GL_SwapWindow, SDL_Window};

/// A batch goes to the GL thread at this many commands or words of data: the queue is ahead of the driver
/// by little, and a hand-over costs a lock and a futex call, so not at every draw.
const BATCH_CMDS: usize = 96;
const BATCH_WORDS: usize = 32 * 1024;
/// Larger buffer uploads wait instead of being copied.
const MAX_COPY: isize = 1 << 20;
/// Larger texture uploads wait too: a queued one costs its size twice in memory until it has run.
const MAX_COPY_TEX: usize = 4 << 20;
/// Words of data in the queue before the JS thread waits for it (64 MB): 1 GB handhelds have no room for more.
const QUEUE_LIMIT_WORDS: u64 = 8 << 20;
/// glGen* names: made this many at a time, again when fewer than POOL_LOW are left.
const POOL_SIZE: usize = 16;
const POOL_LOW: usize = 4;
/// Spins (~40-50 us on a Cortex-A53) before going to sleep: a wait for an answer is usually short, and at
/// load time there are thousands of them.
const SPINS: u32 = 2000;

const SCISSOR_TEST: u32 = 0x0C11;
/// The capabilities IsEnabled answers here.
const CAPS: [u32; 6] = [SCISSOR_TEST, 0x0BE2, 0x0B44, 0x0B71, 0x0B90, 0x0BD0]; // scissor, blend, cull, depth, stencil, dither
const ACTIVE_TEXTURE: u32 = 0x84E0;
const TEXTURE0: u32 = 0x84C0;
const TEXTURE_2D: u32 = 0x0DE1;
const TEXTURE_BINDING_2D: u32 = 0x8069;
const VIEWPORT: u32 = 0x0BA2;
const VERTEX_ARRAY_BINDING: u32 = 0x85B5;
const CURRENT_PROGRAM: u32 = 0x8B8D;
const ARRAY_BUFFER: u32 = 0x8892;
const ARRAY_BUFFER_BINDING: u32 = 0x8894;
const COLOR_CLEAR_VALUE: u32 = 0x0C22;
const DEPTH_CLEAR_VALUE: u32 = 0x0B73;
const STENCIL_CLEAR_VALUE: u32 = 0x0B91;
const COLOR_WRITEMASK: u32 = 0x0C23;
const DEPTH_WRITEMASK: u32 = 0x0B72;
const STENCIL_WRITEMASK: u32 = 0x0B98;
const FRAMEBUFFER_BINDING: u32 = 0x8CA6;
const READ_FRAMEBUFFER_BINDING: u32 = 0x8CAA;
const READ_FRAMEBUFFER: u32 = 0x8CA8;
const DRAW_FRAMEBUFFER: u32 = 0x8CA9;
const FRAMEBUFFER: u32 = 0x8D40;
const FRONT: u32 = 0x0404;
const FRONT_AND_BACK: u32 = 0x0408;
const UNPACK_ALIGNMENT: u32 = 0x0CF5;
const UNPACK_ROW_LENGTH: u32 = 0x0CF2;
const UNPACK_SKIP_ROWS: u32 = 0x0CF3;
const UNPACK_SKIP_PIXELS: u32 = 0x0CF4;
const UNPACK_IMAGE_HEIGHT: u32 = 0x806E;
const UNPACK_SKIP_IMAGES: u32 = 0x806D;

#[derive(Clone, Copy)]
struct Cmd {
    run: unsafe fn(&Cmd, *const u64),
    a: [u64; 10],
}

trait Arg: Copy {
    fn enc(self) -> u64;
    fn dec(v: u64) -> Self;
}
impl Arg for u32 {
    fn enc(self) -> u64 {
        self as u64
    }
    fn dec(v: u64) -> u32 {
        v as u32
    }
}
impl Arg for i32 {
    fn enc(self) -> u64 {
        self as u32 as u64
    }
    fn dec(v: u64) -> i32 {
        v as u32 as i32
    }
}
impl Arg for u8 {
    fn enc(self) -> u64 {
        self as u64
    }
    fn dec(v: u64) -> u8 {
        v as u8
    }
}
impl Arg for f32 {
    fn enc(self) -> u64 {
        self.to_bits() as u64
    }
    fn dec(v: u64) -> f32 {
        f32::from_bits(v as u32)
    }
}
impl Arg for *const c_void {
    fn enc(self) -> u64 {
        self as usize as u64
    }
    fn dec(v: u64) -> *const c_void {
        v as usize as *const c_void
    }
}

#[derive(Default)]
struct Batch {
    cmds: Vec<Cmd>,
    data: Vec<u64>,
}

struct Queue {
    batches: VecDeque<Batch>,
    free: Vec<Batch>,
    swaps_done: u64,
    stop: bool,
}
static QUEUE: Mutex<Queue> = Mutex::new(Queue { batches: VecDeque::new(), free: Vec::new(), swaps_done: 0, stop: false });
static GL_WAKE: Condvar = Condvar::new();
static MAIN_WAKE: Condvar = Condvar::new();
/// Batches handed over and batches finished. The main thread's wait for an answer spins on these first.
static SUBMITTED: AtomicU64 = AtomicU64::new(0);
static DONE: AtomicU64 = AtomicU64::new(0);
/// Words of data handed over and not run yet.
static QUEUED_WORDS: AtomicU64 = AtomicU64::new(0);

static BUSY_NS: AtomicU64 = AtomicU64::new(0);
static SWAP_NS: AtomicU64 = AtomicU64::new(0);

/// The JS thread's side. Only the thread that called `start` calls the trampolines (`App` lives there).
struct Producer {
    cmds: Vec<Cmd>,
    data: Vec<u64>,
    shadow: Shadow,
    /// After `stop`, calls run directly: the context is current on the JS thread again.
    stopped: bool,
    swaps_queued: u64,
    join: Option<std::thread::JoinHandle<()>>,
    // The frame report.
    total_cmds: u64,
    swap_wait_ns: u64,
    waits: HashMap<&'static str, (u64, u64)>,
    pname_tags: HashMap<(usize, u32), &'static str>,
}
struct Shadow {
    caps: [u8; CAPS.len()],
    active_texture: u32,
    /// TEXTURE_2D bound to each unit (more units than any game here uses are answered by the driver).
    tex2d: [u32; 32],
    viewport: [i32; 4],
    vao: u32,
    program: u32,
    array_buffer: u32,
    clear_color: [f32; 4],
    clear_depth: f32,
    clear_stencil: i32,
    color_mask: [u8; 4],
    depth_mask: u8,
    stencil_mask: u32,
    draw_fb: u32,
    read_fb: u32,
    unpack_alignment: i32,
    /// One bit per other unpack parameter that is not 0: such an upload's size is not worked out here.
    unpack_other: u8,
}
fn cap_index(cap: u32) -> Option<usize> {
    CAPS.iter().position(|&c| c == cap)
}
struct Global(std::cell::UnsafeCell<Option<Producer>>);
unsafe impl Sync for Global {}
static PRODUCER: Global = Global(std::cell::UnsafeCell::new(None));
static ACTIVE: AtomicBool = AtomicBool::new(false);

#[inline]
fn prod() -> &'static mut Producer {
    // Set once by `start`, before any trampoline can run, and only that thread gets here.
    unsafe { (*PRODUCER.0.get()).as_mut().unwrap_unchecked() }
}

pub fn active() -> bool {
    ACTIVE.load(Relaxed)
}

#[inline]
fn push(c: Cmd) {
    let p = prod();
    if p.stopped {
        unsafe { (c.run)(&c, p.data.as_ptr()) };
        p.data.clear();
        return;
    }
    p.cmds.push(c);
    p.total_cmds += 1;
    // After the push: a command and its data stay in one batch.
    if p.cmds.len() >= BATCH_CMDS || p.data.len() >= BATCH_WORDS {
        flush();
        if QUEUED_WORDS.load(Relaxed) > QUEUE_LIMIT_WORDS {
            wait_idle();
        }
    }
}

/// Everything queued so far goes to the GL thread (the main loop calls it at the end of every frame).
pub fn flush() {
    if !active() {
        return;
    }
    let p = prod();
    if p.cmds.is_empty() {
        return;
    }
    let mut q = QUEUE.lock().unwrap();
    let mut next = q.free.pop().unwrap_or_default();
    QUEUED_WORDS.fetch_add(p.data.len() as u64, Relaxed);
    std::mem::swap(&mut next.cmds, &mut p.cmds);
    std::mem::swap(&mut next.data, &mut p.data);
    q.batches.push_back(next);
    SUBMITTED.fetch_add(1, Relaxed);
    drop(q);
    GL_WAKE.notify_one();
}

fn wait_idle() {
    for _ in 0..SPINS {
        // Acquire: what the GL thread wrote before finishing the batch (an answer) is visible from here.
        if DONE.load(Ordering::Acquire) == SUBMITTED.load(Relaxed) {
            return;
        }
        std::hint::spin_loop();
    }
    let mut q = QUEUE.lock().unwrap();
    while DONE.load(Relaxed) != SUBMITTED.load(Relaxed) {
        q = MAIN_WAKE.wait(q).unwrap();
    }
}

/// Runs `f` on the GL thread after everything queued, while this thread waits: `f` may use this thread's
/// pointers and locals.
fn call<R>(name: &'static str, f: impl FnOnce() -> R) -> R {
    if prod().stopped {
        return f();
    }
    unsafe fn tramp<F: FnMut()>(c: &Cmd, _: *const u64) {
        (*(c.a[0] as usize as *mut F))()
    }
    fn cmd_of<F: FnMut()>(job: &mut F) -> Cmd {
        let mut a = [0u64; 10];
        a[0] = job as *mut F as usize as u64;
        Cmd { run: tramp::<F>, a }
    }
    let mut slot = None;
    let t = Instant::now();
    {
        let mut f = Some(f);
        let mut job = || slot = Some((f.take().unwrap())());
        prod().cmds.push(cmd_of(&mut job));
        flush();
        wait_idle();
    }
    let e = prod().waits.entry(name).or_insert((0, 0));
    e.0 += 1;
    e.1 += t.elapsed().as_nanos() as u64;
    slot.unwrap()
}

/// The bytes an upload reads from its pointer, when this thread can tell and they are few enough to copy.
fn upload_bytes(w: i32, h: i32, format: u32, ty: u32) -> Option<usize> {
    const RGBA: u32 = 0x1908;
    const RGB: u32 = 0x1907;
    const ALPHA: u32 = 0x1906;
    const LUMINANCE: u32 = 0x1909;
    const LUMINANCE_ALPHA: u32 = 0x190A;
    const RED: u32 = 0x1903;
    const RG: u32 = 0x8227;
    const UB: u32 = 0x1401;
    const S4444: u32 = 0x8033;
    const S5551: u32 = 0x8034;
    const S565: u32 = 0x8363;
    let s = &prod().shadow;
    if w < 0 || h < 0 || s.unpack_other != 0 || s.unpack_alignment <= 0 {
        return None;
    }
    let bpp = match (format, ty) {
        (RGBA, UB) => 4,
        (RGB, UB) => 3,
        (LUMINANCE_ALPHA, UB) | (RG, UB) | (RGBA, S4444) | (RGBA, S5551) | (RGB, S565) => 2,
        (ALPHA, UB) | (LUMINANCE, UB) | (RED, UB) => 1,
        _ => return None,
    };
    let (w, h, align) = (w as usize, h as usize, s.unpack_alignment as usize);
    if h == 0 || w == 0 {
        return Some(0);
    }
    // The last row needs no padding.
    let bytes = (w * bpp).next_multiple_of(align) * (h - 1) + w * bpp;
    (bytes <= MAX_COPY_TEX).then_some(bytes)
}

/// A waiting call's name in the frame report, with the parameter it asked for.
fn pname_tag(name: &str, pname: u32) -> &'static str {
    prod().pname_tags.entry((name.as_ptr() as usize, pname)).or_insert_with(|| Box::leak(format!("{name}(0x{pname:x})").into_boxed_str()))
}

struct NamePool {
    names: Mutex<Vec<u32>>,
    refilling: AtomicBool,
}
unsafe fn pool_get(pool: &'static NamePool, refill: unsafe fn(&Cmd, *const u64)) -> Option<u32> {
    let mut v = pool.names.lock().unwrap();
    let got = v.pop();
    let low = v.len() < POOL_LOW;
    drop(v);
    if low && !prod().stopped && !pool.refilling.swap(true, Relaxed) {
        push(Cmd { run: refill, a: [0u64; 10] });
    }
    got
}

/// Copies `bytes` into the batch's data, returning the offset in words.
unsafe fn copy_data(src: *const u8, bytes: usize) -> u64 {
    let p = prod();
    let off = p.data.len();
    let words = bytes.div_ceil(8);
    p.data.reserve(words);
    std::ptr::copy_nonoverlapping(src, p.data.as_mut_ptr().add(off) as *mut u8, bytes);
    p.data.set_len(off + words);
    off as u64
}

type Entry = (&'static str, *const c_void, &'static AtomicUsize);

/// Queued calls: arguments only. The block runs on the JS thread first (the shadow copy).
macro_rules! deferred {
    ($group:ident; $($name:ident($($a:ident: $t:ty),*) $hook:block)*) => {
        $(#[allow(non_snake_case, unused)]
        pub mod $name {
            use super::*;
            pub static REAL: AtomicUsize = AtomicUsize::new(0);
            pub unsafe fn real($($a: $t),*) {
                let f: unsafe extern "system" fn($($t),*) = std::mem::transmute(REAL.load(Relaxed));
                f($($a),*)
            }
            unsafe fn run(c: &Cmd, _d: *const u64) {
                let mut i = 0usize;
                $(let $a = <$t as Arg>::dec(c.a[i]); i += 1;)*
                real($($a),*)
            }
            pub unsafe extern "system" fn tramp($($a: $t),*) {
                $hook
                let mut a = [0u64; 10];
                let mut i = 0usize;
                $(a[i] = Arg::enc($a); i += 1;)*
                push(Cmd { run, a });
            }
        })*
        fn $group(v: &mut Vec<Entry>) {
            $(v.push((concat!("gl", stringify!($name)), $name::tramp as *const c_void, &$name::REAL));)*
        }
    };
}
/// Calls that wait for the queue and run on the GL thread while the JS thread waits.
macro_rules! waiting {
    ($group:ident; $($name:ident($($a:ident: $t:ty),*) $(-> $r:ty)?;)*) => {
        $(#[allow(non_snake_case, unused)]
        pub mod $name {
            use super::*;
            pub static REAL: AtomicUsize = AtomicUsize::new(0);
            pub unsafe fn real($($a: $t),*) $(-> $r)? {
                let f: unsafe extern "system" fn($($t),*) $(-> $r)? = std::mem::transmute(REAL.load(Relaxed));
                f($($a),*)
            }
            pub unsafe extern "system" fn tramp($($a: $t),*) $(-> $r)? {
                call(stringify!($name), move || real($($a),*))
            }
        })*
        fn $group(v: &mut Vec<Entry>) {
            $(v.push((concat!("gl", stringify!($name)), $name::tramp as *const c_void, &$name::REAL));)*
        }
    };
}
/// Written by hand: `real` is the driver's function.
macro_rules! custom {
    ($group:ident; $($name:ident($($a:ident: $t:ty),*) $(-> $r:ty)? $body:block)*) => {
        $(#[allow(non_snake_case, unused)]
        pub mod $name {
            use super::*;
            pub static REAL: AtomicUsize = AtomicUsize::new(0);
            pub unsafe fn real($($a: $t),*) $(-> $r)? {
                let f: unsafe extern "system" fn($($t),*) $(-> $r)? = std::mem::transmute(REAL.load(Relaxed));
                f($($a),*)
            }
            pub unsafe extern "system" fn tramp($($a: $t),*) $(-> $r)? $body
        })*
        fn $group(v: &mut Vec<Entry>) {
            $(v.push((concat!("gl", stringify!($name)), $name::tramp as *const c_void, &$name::REAL));)*
        }
    };
}
/// glUniform*v: the values are copied.
macro_rules! uniform_v {
    ($group:ident; $($name:ident: $elem:ty, $n:expr;)*) => {
        $(#[allow(non_snake_case, unused)]
        pub mod $name {
            use super::*;
            pub static REAL: AtomicUsize = AtomicUsize::new(0);
            unsafe fn run(c: &Cmd, d: *const u64) {
                let f: unsafe extern "system" fn(i32, i32, *const $elem) = std::mem::transmute(REAL.load(Relaxed));
                f(c.a[0] as u32 as i32, c.a[1] as u32 as i32, d.add(c.a[2] as usize) as *const $elem)
            }
            pub unsafe extern "system" fn tramp(loc: i32, count: i32, v: *const $elem) {
                let off = copy_data(v as *const u8, count.max(0) as usize * $n * 4);
                let mut a = [0u64; 10];
                a[0] = loc.enc();
                a[1] = count.enc();
                a[2] = off;
                push(Cmd { run, a });
            }
        })*
        fn $group(v: &mut Vec<Entry>) {
            $(v.push((concat!("gl", stringify!($name)), $name::tramp as *const c_void, &$name::REAL));)*
        }
    };
}
/// glUniformMatrix*fv.
macro_rules! uniform_m {
    ($group:ident; $($name:ident: $n:expr;)*) => {
        $(#[allow(non_snake_case, unused)]
        pub mod $name {
            use super::*;
            pub static REAL: AtomicUsize = AtomicUsize::new(0);
            unsafe fn run(c: &Cmd, d: *const u64) {
                let f: unsafe extern "system" fn(i32, i32, u8, *const f32) = std::mem::transmute(REAL.load(Relaxed));
                f(c.a[0] as u32 as i32, c.a[1] as u32 as i32, c.a[2] as u8, d.add(c.a[3] as usize) as *const f32)
            }
            pub unsafe extern "system" fn tramp(loc: i32, count: i32, transpose: u8, v: *const f32) {
                let off = copy_data(v as *const u8, count.max(0) as usize * $n * 4);
                let mut a = [0u64; 10];
                a[0] = loc.enc();
                a[1] = count.enc();
                a[2] = transpose.enc();
                a[3] = off;
                push(Cmd { run, a });
            }
        })*
        fn $group(v: &mut Vec<Entry>) {
            $(v.push((concat!("gl", stringify!($name)), $name::tramp as *const c_void, &$name::REAL));)*
        }
    };
}
/// glGen*(n, names): one name comes from the pool, more wait (glow always asks for one).
macro_rules! gen_named {
    ($group:ident; $($name:ident;)*) => {
        $(#[allow(non_snake_case, unused)]
        pub mod $name {
            use super::*;
            pub static REAL: AtomicUsize = AtomicUsize::new(0);
            static POOL: NamePool = NamePool { names: Mutex::new(Vec::new()), refilling: AtomicBool::new(false) };
            unsafe fn real(n: i32, names: *mut u32) {
                let f: unsafe extern "system" fn(i32, *mut u32) = std::mem::transmute(REAL.load(Relaxed));
                f(n, names)
            }
            unsafe fn refill(_c: &Cmd, _d: *const u64) {
                let mut names = [0u32; POOL_SIZE];
                real(POOL_SIZE as i32, names.as_mut_ptr());
                POOL.names.lock().unwrap().extend_from_slice(&names);
                POOL.refilling.store(false, Relaxed);
            }
            pub unsafe extern "system" fn tramp(n: i32, out: *mut u32) {
                if n == 1 {
                    if let Some(name) = pool_get(&POOL, refill) {
                        *out = name;
                        return;
                    }
                }
                call(stringify!($name), move || real(n, out))
            }
        })*
        fn $group(v: &mut Vec<Entry>) {
            $(v.push((concat!("gl", stringify!($name)), $name::tramp as *const c_void, &$name::REAL));)*
        }
    };
}
/// glDelete*(n, names): one name travels in the command; more wait (glow always passes one).
macro_rules! delete_named {
    ($group:ident; $($name:ident $hook:expr;)*) => {
        $(#[allow(non_snake_case, unused)]
        pub mod $name {
            use super::*;
            pub static REAL: AtomicUsize = AtomicUsize::new(0);
            unsafe fn real(n: i32, names: *const u32) {
                let f: unsafe extern "system" fn(i32, *const u32) = std::mem::transmute(REAL.load(Relaxed));
                f(n, names)
            }
            unsafe fn run(c: &Cmd, _d: *const u64) {
                let name = c.a[0] as u32;
                real(1, &name)
            }
            pub unsafe extern "system" fn tramp(n: i32, names: *const u32) {
                if n != 1 {
                    return call(stringify!($name), move || real(n, names));
                }
                let hook: fn(u32) = $hook;
                hook(*names);
                let mut a = [0u64; 10];
                a[0] = (*names) as u64;
                push(Cmd { run, a });
            }
        })*
        fn $group(v: &mut Vec<Entry>) {
            $(v.push((concat!("gl", stringify!($name)), $name::tramp as *const c_void, &$name::REAL));)*
        }
    };
}

deferred! { add_deferred;
    ActiveTexture(texture: u32) { prod().shadow.active_texture = texture; }
    AttachShader(program: u32, shader: u32) {}
    BindBuffer(target: u32, buffer: u32) {
        if target == ARRAY_BUFFER {
            prod().shadow.array_buffer = buffer;
        }
    }
    BindFramebuffer(target: u32, framebuffer: u32) {
        let s = &mut prod().shadow;
        if target == FRAMEBUFFER || target == DRAW_FRAMEBUFFER {
            s.draw_fb = framebuffer;
        }
        if target == FRAMEBUFFER || target == READ_FRAMEBUFFER {
            s.read_fb = framebuffer;
        }
    }
    BindRenderbuffer(target: u32, renderbuffer: u32) {}
    BindTexture(target: u32, texture: u32) {
        let s = &mut prod().shadow;
        if target == TEXTURE_2D {
            if let Some(b) = s.tex2d.get_mut(s.active_texture.wrapping_sub(TEXTURE0) as usize) {
                *b = texture;
            }
        }
    }
    BindVertexArray(array: u32) { prod().shadow.vao = array; }
    BindVertexArrayOES(array: u32) { prod().shadow.vao = array; }
    BlendColor(r: f32, g: f32, b: f32, a_: f32) {}
    BlendEquation(mode: u32) {}
    BlendEquationSeparate(rgb: u32, alpha: u32) {}
    BlendFunc(s: u32, d: u32) {}
    BlendFuncSeparate(sr: u32, dr: u32, sa: u32, da: u32) {}
    BlitFramebuffer(sx0: i32, sy0: i32, sx1: i32, sy1: i32, dx0: i32, dy0: i32, dx1: i32, dy1: i32, mask: u32, filter: u32) {}
    Clear(mask: u32) {}
    ClearColor(r: f32, g: f32, b: f32, a_: f32) { prod().shadow.clear_color = [r, g, b, a_]; }
    ClearDepthf(d: f32) { prod().shadow.clear_depth = d; }
    ClearStencil(s: i32) { prod().shadow.clear_stencil = s; }
    ColorMask(r: u8, g: u8, b: u8, a_: u8) { prod().shadow.color_mask = [r, g, b, a_]; }
    CopyTexImage2D(target: u32, level: i32, format: u32, x: i32, y: i32, w: i32, h: i32, border: i32) {}
    CopyTexSubImage2D(target: u32, level: i32, xo: i32, yo: i32, x: i32, y: i32, w: i32, h: i32) {}
    CullFace(mode: u32) {}
    DeleteProgram(program: u32) {}
    DeleteShader(shader: u32) {}
    DepthFunc(func: u32) {}
    DepthMask(flag: u8) { prod().shadow.depth_mask = flag; }
    DepthRangef(n: f32, f_: f32) {}
    DetachShader(program: u32, shader: u32) {}
    Disable(cap: u32) { if let Some(i) = cap_index(cap) { prod().shadow.caps[i] = 0; } }
    DisableVertexAttribArray(index: u32) {}
    DrawArrays(mode: u32, first: i32, count: i32) {}
    DrawArraysInstanced(mode: u32, first: i32, count: i32, n: i32) {}
    DrawElements(mode: u32, count: i32, ty: u32, indices: *const c_void) {}
    DrawElementsInstanced(mode: u32, count: i32, ty: u32, indices: *const c_void, n: i32) {}
    Enable(cap: u32) { if let Some(i) = cap_index(cap) { prod().shadow.caps[i] = 1; } }
    EnableVertexAttribArray(index: u32) {}
    Flush() {}
    FramebufferRenderbuffer(target: u32, attachment: u32, rbtarget: u32, rb: u32) {}
    FramebufferTexture2D(target: u32, attachment: u32, textarget: u32, texture: u32, level: i32) {}
    FrontFace(mode: u32) {}
    GenerateMipmap(target: u32) {}
    Hint(target: u32, mode: u32) {}
    LineWidth(width: f32) {}
    PixelStorei(pname: u32, param: i32) {
        let s = &mut prod().shadow;
        let bit = match pname {
            UNPACK_ALIGNMENT => {
                s.unpack_alignment = param;
                0
            }
            UNPACK_ROW_LENGTH => 1,
            UNPACK_SKIP_ROWS => 2,
            UNPACK_SKIP_PIXELS => 4,
            UNPACK_IMAGE_HEIGHT => 8,
            UNPACK_SKIP_IMAGES => 16,
            _ => 0,
        };
        if param != 0 {
            s.unpack_other |= bit;
        } else {
            s.unpack_other &= !bit;
        }
    }
    PolygonOffset(factor: f32, units: f32) {}
    RenderbufferStorage(target: u32, format: u32, w: i32, h: i32) {}
    SampleCoverage(value: f32, invert: u8) {}
    Scissor(x: i32, y: i32, w: i32, h: i32) {}
    StencilFunc(func: u32, ref_: i32, mask: u32) {}
    StencilFuncSeparate(face: u32, func: u32, ref_: i32, mask: u32) {}
    StencilMask(mask: u32) { prod().shadow.stencil_mask = mask; }
    StencilMaskSeparate(face: u32, mask: u32) {
        if face == FRONT || face == FRONT_AND_BACK {
            prod().shadow.stencil_mask = mask;
        }
    }
    StencilOp(fail: u32, zfail: u32, zpass: u32) {}
    StencilOpSeparate(face: u32, sfail: u32, dpfail: u32, dppass: u32) {}
    TexParameterf(target: u32, pname: u32, param: f32) {}
    TexParameteri(target: u32, pname: u32, param: i32) {}
    Uniform1f(loc: i32, v0: f32) {}
    Uniform2f(loc: i32, v0: f32, v1: f32) {}
    Uniform3f(loc: i32, v0: f32, v1: f32, v2: f32) {}
    Uniform4f(loc: i32, v0: f32, v1: f32, v2: f32, v3: f32) {}
    Uniform1i(loc: i32, v0: i32) {}
    Uniform2i(loc: i32, v0: i32, v1: i32) {}
    Uniform3i(loc: i32, v0: i32, v1: i32, v2: i32) {}
    Uniform4i(loc: i32, v0: i32, v1: i32, v2: i32, v3: i32) {}
    UseProgram(program: u32) { prod().shadow.program = program; }
    VertexAttrib4f(index: u32, x: f32, y: f32, z: f32, w: f32) {}
    VertexAttribDivisor(index: u32, divisor: u32) {}
    VertexAttribPointer(index: u32, size: i32, ty: u32, normalized: u8, stride: i32, pointer: *const c_void) {}
    Viewport(x: i32, y: i32, w: i32, h: i32) { prod().shadow.viewport = [x, y, w, h]; }
}

waiting! { add_waiting;
    BindAttribLocation(program: u32, index: u32, name: *const c_char);
    CheckFramebufferStatus(target: u32) -> u32;
    ClientWaitSync(sync: *const c_void, flags: u32, timeout: u64) -> u32;
    CompileShader(shader: u32);
    CreateProgram() -> u32;
    CreateShader(ty: u32) -> u32;
    DeleteSync(sync: *const c_void);
    FenceSync(condition: u32, flags: u32) -> *const c_void;
    Finish();
    GenVertexArrays(n: i32, out: *mut u32);
    GenVertexArraysOES(n: i32, out: *mut u32);
    GetActiveAttrib(program: u32, index: u32, size: i32, len: *mut i32, count: *mut i32, ty: *mut u32, name: *mut c_char);
    GetActiveUniform(program: u32, index: u32, size: i32, len: *mut i32, count: *mut i32, ty: *mut u32, name: *mut c_char);
    GetAttribLocation(program: u32, name: *const c_char) -> i32;
    GetBufferParameteriv(target: u32, pname: u32, out: *mut i32);
    GetError() -> u32;
    GetFramebufferAttachmentParameteriv(target: u32, attachment: u32, pname: u32, out: *mut i32);
    GetProgramBinary(program: u32, size: i32, len: *mut i32, format: *mut u32, binary: *mut c_void);
    GetProgramInfoLog(program: u32, size: i32, len: *mut i32, log: *mut c_char);
    GetProgramiv(program: u32, pname: u32, out: *mut i32);
    GetRenderbufferParameteriv(target: u32, pname: u32, out: *mut i32);
    GetShaderInfoLog(shader: u32, size: i32, len: *mut i32, log: *mut c_char);
    GetShaderPrecisionFormat(shader: u32, precision: u32, range: *mut i32, out: *mut i32);
    GetShaderiv(shader: u32, pname: u32, out: *mut i32);
    GetString(name: u32) -> *const u8;
    GetStringi(name: u32, index: u32) -> *const u8;
    GetTexParameteriv(target: u32, pname: u32, out: *mut i32);
    GetUniformLocation(program: u32, name: *const c_char) -> i32;
    LinkProgram(program: u32);
    ProgramBinary(program: u32, format: u32, binary: *const c_void, len: i32);
    ProgramParameteri(program: u32, pname: u32, value: i32);
    ReadPixels(x: i32, y: i32, w: i32, h: i32, format: u32, ty: u32, pixels: *mut c_void);
    ShaderSource(shader: u32, count: i32, strings: *const *const c_char, lengths: *const i32);
    ValidateProgram(program: u32);
    WaitSync(sync: *const c_void, flags: u32, timeout: u64);
}

uniform_v! { add_uniform_v;
    Uniform1fv: f32, 1;
    Uniform2fv: f32, 2;
    Uniform3fv: f32, 3;
    Uniform4fv: f32, 4;
    Uniform1iv: i32, 1;
    Uniform2iv: i32, 2;
    Uniform3iv: i32, 3;
    Uniform4iv: i32, 4;
}
uniform_m! { add_uniform_m;
    UniformMatrix2fv: 4;
    UniformMatrix3fv: 9;
    UniformMatrix4fv: 16;
}

gen_named! { add_gen;
    GenBuffers;
    GenFramebuffers;
    GenRenderbuffers;
    GenTextures;
}

delete_named! { add_delete;
    DeleteBuffers |name| { if prod().shadow.array_buffer == name { prod().shadow.array_buffer = 0; } };
    DeleteRenderbuffers |_| {};
    // GL unbinds a deleted texture or vertex array.
    DeleteTextures |name| {
        for b in prod().shadow.tex2d.iter_mut().filter(|b| **b == name) {
            *b = 0;
        }
    };
    DeleteVertexArrays |name| { if prod().shadow.vao == name { prod().shadow.vao = 0; } };
    DeleteVertexArraysOES |name| { if prod().shadow.vao == name { prod().shadow.vao = 0; } };
    // GL binds 0 when the bound framebuffer goes.
    DeleteFramebuffers |name| {
        let s = &mut prod().shadow;
        if s.draw_fb == name {
            s.draw_fb = 0;
        }
        if s.read_fb == name {
            s.read_fb = 0;
        }
    };
}

custom! { add_custom;
    TexImage2D(target: u32, level: i32, internal: i32, w: i32, h: i32, border: i32, format: u32, ty: u32, pixels: *const c_void) {
        let bytes = if pixels.is_null() { Some(0) } else { upload_bytes(w, h, format, ty) };
        let Some(bytes) = bytes else {
            return call("TexImage2D", move || real(target, level, internal, w, h, border, format, ty, pixels));
        };
        unsafe fn run(c: &Cmd, d: *const u64) {
            let pixels = if c.a[8] == u64::MAX { std::ptr::null() } else { d.add(c.a[8] as usize) as *const c_void };
            real(u32::dec(c.a[0]), i32::dec(c.a[1]), i32::dec(c.a[2]), i32::dec(c.a[3]), i32::dec(c.a[4]), i32::dec(c.a[5]), u32::dec(c.a[6]), u32::dec(c.a[7]), pixels)
        }
        let off = if pixels.is_null() { u64::MAX } else { copy_data(pixels as *const u8, bytes) };
        let mut a = [0u64; 10];
        (a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]) = (target.enc(), level.enc(), internal.enc(), w.enc(), h.enc(), border.enc(), format.enc(), ty.enc(), off);
        push(Cmd { run, a });
    }
    TexSubImage2D(target: u32, level: i32, xo: i32, yo: i32, w: i32, h: i32, format: u32, ty: u32, pixels: *const c_void) {
        let bytes = if pixels.is_null() { None } else { upload_bytes(w, h, format, ty) };
        let Some(bytes) = bytes else {
            return call("TexSubImage2D", move || real(target, level, xo, yo, w, h, format, ty, pixels));
        };
        unsafe fn run(c: &Cmd, d: *const u64) {
            real(u32::dec(c.a[0]), i32::dec(c.a[1]), i32::dec(c.a[2]), i32::dec(c.a[3]), i32::dec(c.a[4]), i32::dec(c.a[5]), u32::dec(c.a[6]), u32::dec(c.a[7]), d.add(c.a[8] as usize) as *const c_void)
        }
        let off = copy_data(pixels as *const u8, bytes);
        let mut a = [0u64; 10];
        (a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]) = (target.enc(), level.enc(), xo.enc(), yo.enc(), w.enc(), h.enc(), format.enc(), ty.enc(), off);
        push(Cmd { run, a });
    }
    BufferData(target: u32, size: isize, data: *const c_void, usage: u32) {
        if !data.is_null() && size > MAX_COPY {
            return call("BufferData", move || real(target, size, data, usage));
        }
        unsafe fn run(c: &Cmd, d: *const u64) {
            let data = if c.a[3] == u64::MAX { std::ptr::null() } else { d.add(c.a[3] as usize) as *const c_void };
            real(c.a[0] as u32, c.a[1] as usize as isize, data, c.a[2] as u32)
        }
        let off = if data.is_null() { u64::MAX } else { copy_data(data as *const u8, size.max(0) as usize) };
        let mut a = [0u64; 10];
        a[0] = target as u64;
        a[1] = size as usize as u64;
        a[2] = usage as u64;
        a[3] = off;
        push(Cmd { run, a });
    }
    BufferSubData(target: u32, offset: isize, size: isize, data: *const c_void) {
        if size > MAX_COPY {
            return call("BufferSubData", move || real(target, offset, size, data));
        }
        unsafe fn run(c: &Cmd, d: *const u64) {
            real(c.a[0] as u32, c.a[1] as usize as isize, c.a[2] as usize as isize, d.add(c.a[3] as usize) as *const c_void)
        }
        let off = copy_data(data as *const u8, size.max(0) as usize);
        let mut a = [0u64; 10];
        a[0] = target as u64;
        a[1] = offset as usize as u64;
        a[2] = size as usize as u64;
        a[3] = off;
        push(Cmd { run, a });
    }
    IsEnabled(cap: u32) -> u8 {
        if let Some(i) = cap_index(cap) {
            return prod().shadow.caps[i];
        }
        call(pname_tag("IsEnabled", cap), move || real(cap))
    }
    GetFloatv(pname: u32, out: *mut f32) {
        let s = &prod().shadow;
        match pname {
            COLOR_CLEAR_VALUE => std::ptr::copy_nonoverlapping(s.clear_color.as_ptr(), out, 4),
            DEPTH_CLEAR_VALUE => *out = s.clear_depth,
            _ => call(pname_tag("GetFloatv", pname), move || real(pname, out)),
        }
    }
    GetBooleanv(pname: u32, out: *mut u8) {
        let s = &prod().shadow;
        match pname {
            DEPTH_WRITEMASK => *out = s.depth_mask,
            COLOR_WRITEMASK => std::ptr::copy_nonoverlapping(s.color_mask.as_ptr(), out, 4),
            _ => call(pname_tag("GetBooleanv", pname), move || real(pname, out)),
        }
    }
    GetIntegerv(pname: u32, out: *mut i32) {
        let s = &prod().shadow;
        match pname {
            STENCIL_CLEAR_VALUE => *out = s.clear_stencil,
            STENCIL_WRITEMASK => *out = s.stencil_mask as i32,
            FRAMEBUFFER_BINDING => *out = s.draw_fb as i32,
            READ_FRAMEBUFFER_BINDING => *out = s.read_fb as i32,
            UNPACK_ALIGNMENT => *out = s.unpack_alignment,
            ACTIVE_TEXTURE => *out = s.active_texture as i32,
            VERTEX_ARRAY_BINDING => *out = s.vao as i32,
            CURRENT_PROGRAM => *out = s.program as i32,
            ARRAY_BUFFER_BINDING => *out = s.array_buffer as i32,
            VIEWPORT => std::ptr::copy_nonoverlapping(s.viewport.as_ptr(), out, 4),
            TEXTURE_BINDING_2D if (s.active_texture.wrapping_sub(TEXTURE0) as usize) < s.tex2d.len() => {
                *out = s.tex2d[s.active_texture.wrapping_sub(TEXTURE0) as usize] as i32
            }
            COLOR_WRITEMASK => {
                for i in 0..4 {
                    *out.add(i) = s.color_mask[i] as i32;
                }
            }
            _ => call(pname_tag("GetIntegerv", pname), move || real(pname, out)),
        }
    }
}

/// With the context current on this thread: loads the driver's functions, moves the context to a new GL
/// thread and returns the glow context the JS thread uses from now on. On an error the context is current here
/// again.
pub fn start(loader: impl Fn(&str) -> *const c_void, window: *mut SDL_Window, ctx: *mut c_void) -> Result<glow::Context, String> {
    let mut table: Vec<Entry> = Vec::new();
    add_deferred(&mut table);
    add_waiting(&mut table);
    add_uniform_v(&mut table);
    add_uniform_m(&mut table);
    add_gen(&mut table);
    add_delete(&mut table);
    add_custom(&mut table);
    for (name, _, real) in &table {
        real.store(loader(name) as usize, Relaxed);
    }
    let shadow = unsafe {
        let mut s = Shadow { caps: [0; CAPS.len()], active_texture: TEXTURE0, tex2d: [0; 32], viewport: [0; 4], vao: 0, program: 0, array_buffer: 0, clear_color: [0.0; 4], clear_depth: 1.0, clear_stencil: 0, color_mask: [1; 4], depth_mask: 1, stencil_mask: 0, draw_fb: 0, read_fb: 0, unpack_alignment: 4, unpack_other: 0 };
        for (i, cap) in CAPS.iter().enumerate() {
            s.caps[i] = IsEnabled::real(*cap);
        }
        GetIntegerv::real(VIEWPORT, s.viewport.as_mut_ptr());
        GetFloatv::real(COLOR_CLEAR_VALUE, s.clear_color.as_mut_ptr());
        GetFloatv::real(DEPTH_CLEAR_VALUE, &mut s.clear_depth);
        GetIntegerv::real(STENCIL_CLEAR_VALUE, &mut s.clear_stencil);
        GetBooleanv::real(COLOR_WRITEMASK, s.color_mask.as_mut_ptr());
        GetBooleanv::real(DEPTH_WRITEMASK, &mut s.depth_mask);
        let mut v = 0i32;
        GetIntegerv::real(STENCIL_WRITEMASK, &mut v);
        s.stencil_mask = v as u32;
        GetIntegerv::real(FRAMEBUFFER_BINDING, &mut v);
        s.draw_fb = v as u32;
        GetIntegerv::real(READ_FRAMEBUFFER_BINDING, &mut v);
        s.read_fb = v as u32;
        GetIntegerv::real(UNPACK_ALIGNMENT, &mut s.unpack_alignment);
        s
    };
    if unsafe { SDL_GL_MakeCurrent(window, std::ptr::null_mut()) } != 0 {
        return Err(format!("context off this thread: {}", sdl2::get_error()));
    }
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let (w, c) = (window as usize, ctx as usize);
    // The driver's shader compiler runs on this thread, used to the main thread's stack.
    let join = std::thread::Builder::new().name("gl".into()).stack_size(8 << 20).spawn(move || run(w, c, tx));
    let answer = match &join {
        Ok(_) => rx.recv().unwrap_or_else(|_| Err("no answer from the GL thread".into())),
        Err(e) => Err(e.to_string()),
    };
    if let Err(e) = answer {
        if let Ok(j) = join {
            let _ = j.join();
        }
        unsafe { SDL_GL_MakeCurrent(window, ctx) };
        return Err(e);
    }
    unsafe {
        *PRODUCER.0.get() = Some(Producer {
            cmds: Vec::new(),
            data: Vec::new(),
            shadow,
            stopped: false,
            swaps_queued: 0,
            join: join.ok(),
            total_cmds: 0,
            swap_wait_ns: 0,
            waits: HashMap::new(),
            pname_tags: HashMap::new(),
        });
    }
    ACTIVE.store(true, Relaxed);
    let tramps: HashMap<&str, usize> = table.iter().filter(|e| e.2.load(Relaxed) != 0).map(|e| (e.0, e.1 as usize)).collect();
    Ok(unsafe { glow::Context::from_loader_function(|s| tramps.get(s).copied().unwrap_or(0) as *const c_void) })
}

fn run(window: usize, ctx: usize, ready: std::sync::mpsc::Sender<Result<(), String>>) {
    let window = window as *mut SDL_Window;
    if unsafe { SDL_GL_MakeCurrent(window, ctx as *mut c_void) } != 0 {
        let _ = ready.send(Err(format!("context on the GL thread: {}", sdl2::get_error())));
        return;
    }
    let interval: c_int = crate::present::SWAP_INTERVAL.load(Relaxed);
    unsafe { SDL_GL_SetSwapInterval(interval) };
    let _ = ready.send(Ok(()));
    loop {
        let mut idle = 0;
        while DONE.load(Relaxed) == SUBMITTED.load(Relaxed) && idle < SPINS {
            std::hint::spin_loop();
            idle += 1;
        }
        let mut batch = {
            let mut q = QUEUE.lock().unwrap();
            loop {
                if let Some(b) = q.batches.pop_front() {
                    break b;
                }
                if q.stop {
                    drop(q);
                    unsafe { SDL_GL_MakeCurrent(window, std::ptr::null_mut()) };
                    return;
                }
                q = GL_WAKE.wait(q).unwrap();
            }
        };
        let t = Instant::now();
        let base = batch.data.as_ptr();
        for c in &batch.cmds {
            unsafe { (c.run)(c, base) };
        }
        BUSY_NS.fetch_add(t.elapsed().as_nanos() as u64, Relaxed);
        QUEUED_WORDS.fetch_sub(batch.data.len() as u64, Relaxed);
        batch.cmds.clear();
        batch.data.clear();
        // A big copied upload's room goes back; the usual batch keeps its own.
        if batch.data.capacity() > 2 * BATCH_WORDS {
            batch.data = Vec::new();
        }
        let mut q = QUEUE.lock().unwrap();
        q.free.push(batch);
        DONE.fetch_add(1, Ordering::Release);
        drop(q);
        MAIN_WAKE.notify_all();
    }
}

/// Queues the swap and waits for the one before it.
pub fn swap(window: *mut SDL_Window) {
    unsafe fn run(c: &Cmd, _: *const u64) {
        let t = Instant::now();
        SDL_GL_SwapWindow(c.a[0] as usize as *mut SDL_Window);
        SWAP_NS.fetch_add(t.elapsed().as_nanos() as u64, Relaxed);
        QUEUE.lock().unwrap().swaps_done += 1;
        MAIN_WAKE.notify_all();
    }
    let mut a = [0u64; 10];
    a[0] = window as usize as u64;
    prod().swaps_queued += 1;
    prod().cmds.push(Cmd { run, a });
    flush();
    let t = Instant::now();
    let queued = prod().swaps_queued;
    let mut q = QUEUE.lock().unwrap();
    while q.swaps_done + 1 < queued {
        q = MAIN_WAKE.wait(q).unwrap();
    }
    drop(q);
    prod().swap_wait_ns += t.elapsed().as_nanos() as u64;
}

/// Runs what is queued, ends the thread and makes the context current here again (before the window goes).
pub fn stop(window: *mut SDL_Window, ctx: *mut c_void) {
    if !active() {
        return;
    }
    flush();
    wait_idle();
    QUEUE.lock().unwrap().stop = true;
    GL_WAKE.notify_all();
    let p = prod();
    if let Some(j) = p.join.take() {
        let _ = j.join();
    }
    unsafe { SDL_GL_MakeCurrent(window, ctx) };
    p.stopped = true;
    ACTIVE.store(false, Relaxed);
}

/// For the frame report: per frame, since the last call.
pub fn report(frames: f64) -> Option<String> {
    if !active() {
        return None;
    }
    let p = prod();
    let per = |ns: u64| ns as f64 / 1e6 / frames;
    let mut w: Vec<_> = p.waits.drain().collect();
    w.sort_by(|a, b| b.1 .1.cmp(&a.1 .1));
    let (mut calls, mut ns) = (0, 0);
    for (_, (n, t)) in &w {
        calls += n;
        ns += t;
    }
    let top: Vec<String> = w.iter().take(6).map(|(k, (n, t))| format!("{k} {n}x {:.1} ms", *t as f64 / 1e6)).collect();
    let s = format!(
        "[powerboat] gl thread per frame: {:.0} commands, busy {:.2} ms, swap {:.2} ms; JS waited {:.2} ms for answers ({:.1} calls), {:.2} ms for swaps; top waits: {}",
        std::mem::take(&mut p.total_cmds) as f64 / frames,
        per(BUSY_NS.swap(0, Relaxed)),
        per(SWAP_NS.swap(0, Relaxed)),
        per(ns),
        calls as f64 / frames,
        per(std::mem::take(&mut p.swap_wait_ns)),
        top.join(", ")
    );
    Some(s)
}
