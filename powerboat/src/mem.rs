//! Memory readings for process.memoryUsage(), process.resourceUsage() (js/60_node.js) and performance.memory
//! (js/00_env.js). Each op writes plain numbers into a byte view of a Float64Array the JS side keeps, so a game
//! that reads them every frame makes no objects here and pays a few microseconds.

use std::fs::File;
use std::os::unix::fs::FileExt;

use deno_core::{op2, v8, OpState};

use crate::ops::App;

fn put(out: &mut [u8], vals: &[f64]) {
    for (chunk, v) in out.chunks_exact_mut(8).zip(vals) {
        chunk.copy_from_slice(&v.to_ne_bytes());
    }
}

/// Bytes the runtime holds outside V8 for JS objects: decoded images, Canvas 2D pixmaps and audio PCM. main.rs
/// reports this to V8 as external memory so its GC runs when games drop them.
pub fn native_bytes(app: &App) -> usize {
    app.images.bytes() + app.canvases.bytes() + app.audio.as_ref().map(|a| a.bytes()).unwrap_or(0)
}

thread_local! {
    // Opened once; every reading is one pread() at offset 0 (procfs regenerates the line).
    static STATM: Option<File> = File::open("/proc/self/statm").ok();
}

extern "C" {
    fn getpagesize() -> std::ffi::c_int;
    fn getrusage(who: std::ffi::c_int, usage: *mut Rusage) -> std::ffi::c_int;
}

/// Resident set size in bytes (/proc/self/statm's second field times the page size), 0 where there is none.
pub fn rss_bytes() -> u64 {
    STATM.with(|f| {
        let Some(f) = f else { return 0 };
        let mut buf = [0u8; 256];
        let n = f.read_at(&mut buf, 0).unwrap_or(0);
        let pages: u64 = std::str::from_utf8(&buf[..n]).ok().and_then(|s| s.split_ascii_whitespace().nth(1)).and_then(|v| v.parse().ok()).unwrap_or(0);
        pages * unsafe { getpagesize() } as u64
    })
}

/// struct rusage on 64-bit Linux (glibc, x86_64 and aarch64): two timevals, then 14 longs from ru_maxrss on.
#[repr(C)]
struct Rusage {
    utime: [i64; 2],
    stime: [i64; 2],
    longs: [i64; 14],
}

/// The V8 heap in bytes: [used, total (committed), limit, external (ArrayBuffer backing stores), physical, malloced].
#[op2(fast)]
pub fn op_powerboat_heap_stats(isolate: &mut v8::Isolate, #[buffer] out: &mut [u8]) {
    let hs = isolate.get_heap_statistics();
    put(
        out,
        &[
            hs.used_heap_size() as f64,
            hs.total_heap_size() as f64,
            hs.heap_size_limit() as f64,
            hs.external_memory() as f64,
            hs.total_physical_size() as f64,
            hs.malloced_memory() as f64,
        ],
    );
}

#[op2(fast)]
pub fn op_powerboat_rss() -> f64 {
    rss_bytes() as f64
}

#[op2(fast)]
pub fn op_powerboat_bytes(state: &mut OpState) -> f64 {
    native_bytes(state.borrow::<App>()) as f64
}

/// getrusage(RUSAGE_SELF) in the order of Node's process.resourceUsage(): user and system CPU time in
/// microseconds, then ru_maxrss (KB) to ru_nivcsw. All zero if the call fails.
#[op2(fast)]
pub fn op_powerboat_rusage(#[buffer] out: &mut [u8]) {
    let mut r = Rusage { utime: [0; 2], stime: [0; 2], longs: [0; 14] };
    let mut v = [0f64; 16];
    if unsafe { getrusage(0, &mut r) } == 0 {
        v[0] = (r.utime[0] * 1_000_000 + r.utime[1]) as f64;
        v[1] = (r.stime[0] * 1_000_000 + r.stime[1]) as f64;
        for (d, s) in v[2..].iter_mut().zip(r.longs) {
            *d = s as f64;
        }
    }
    put(out, &v);
}
