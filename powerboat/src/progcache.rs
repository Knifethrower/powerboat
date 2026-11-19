//! GL program binary cache. Construct, PIXI and the rest compile and link every shader program on
//! every boot: about 2 s of Moonstone Island's boot on the TrimUI Smart Pro (PowerVR GE8300). A
//! linked program's binary (glGetProgramBinary, core in GLES 3.0) is kept in <cache>/glprog.bin,
//! keyed by its shader sources and attribute bindings; the file belongs to one driver (vendor,
//! renderer, version strings in its header). On later boots glProgramBinary restores the program
//! and its shaders are never compiled.
//!
//! WebGL code checks COMPILE_STATUS between compileShader and linkProgram, so a shader whose
//! source is part of a cached program (it compiled on this driver before) is not compiled at
//! compileShader: it reports success with an empty log, and is compiled for real only when a link
//! needs it (no cached binary for that program, or the driver rejected the binary). A rejected
//! binary costs one glProgramBinary call on top of the normal compile and link.
//!
//! File: "PBOATGL1", u32 driver string length, driver string; then one record per stored program:
//! "PRG1", key u128, shader count u32, shader hashes u128 each, binary format u32, length u32,
//! binary, FNV-1a 64 of the binary. Records are appended as programs link (one write each); a
//! torn tail is cut off at load, a later record for a key wins, a damaged binary is a miss, and
//! a file over 32 MB starts over. Hashes are FNV-1a (stable across Rust versions).
//! POWERBOAT_GL_PROGRAM_CACHE=0 turns it off, =reset starts the file over (a cold-boot test); POWERBOAT_CACHE_DEBUG prints
//! each store and reject.
//!
//! WebGL 1 only: the runtime has no transformFeedbackVaryings op, so no program here has captured
//! varyings. If one is ever added, its programs must skip this cache (key() -> None): Godot 3's own
//! cache broke on transform feedback programs.

use glow::HasContext;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::num::NonZeroU32;
use std::path::Path;
use std::time::Instant;

const MAGIC: &[u8; 8] = b"PBOATGL1";
const REC: &[u8; 4] = b"PRG1";
const MAX_FILE: u64 = 32 << 20;

fn fnv128(parts: &[&[u8]]) -> u128 {
    let mut h: u128 = 0x6c62272e07bb014262b821756295c58d;
    for p in parts {
        for &b in p.iter().chain((p.len() as u32).to_le_bytes().iter()) {
            h ^= b as u128;
            h = h.wrapping_mul(0x0000000001000000000000000000013B);
        }
    }
    h
}
fn fnv64(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

struct ShaderRec {
    ty: u32,
    /// Hash of type + source; 0 until shaderSource.
    hash: u128,
    /// compileShader was skipped (source known good); compiled for real only if a link needs it.
    deferred: bool,
    /// deleteShader was called while the shader was attached: the record goes with its last program.
    deleted: bool,
}

struct Entry {
    off: u64,
    len: u32,
    format: u32,
    sum: u64,
}

#[derive(Default)]
pub struct Stats {
    pub links: u32,
    pub hits: u32,
    pub misses: u32,
    pub rejects: u32,
    pub stored: u32,
    pub skipped_compiles: u32,
    pub late_compiles: u32,
    /// Time inside the driver's compile/link/status calls.
    pub driver_ms: f64,
    /// Time reading and checking cached binaries.
    pub read_ms: f64,
    /// When the first and the last link ended, in s since the process started (boot timeline).
    pub first_s: f64,
    pub last_s: f64,
}

pub struct ProgCache {
    on: bool,
    file: Option<File>,
    index: HashMap<u128, Entry>,
    known: HashSet<u128>,
    shaders: HashMap<u32, ShaderRec>,
    attached: HashMap<u32, Vec<u32>>,
    binds: HashMap<u32, BTreeMap<String, u32>>,
    debug: bool,
    start: Option<Instant>,
    pub stats: Stats,
}

impl Default for ProgCache {
    fn default() -> Self {
        ProgCache {
            on: false,
            file: None,
            index: HashMap::new(),
            known: HashSet::new(),
            shaders: HashMap::new(),
            attached: HashMap::new(),
            binds: HashMap::new(),
            debug: false,
            start: None,
            stats: Stats::default(),
        }
    }
}

fn shader(id: u32) -> Option<glow::NativeShader> {
    NonZeroU32::new(id).map(glow::NativeShader)
}
fn program(id: u32) -> Option<glow::NativeProgram> {
    NonZeroU32::new(id).map(glow::NativeProgram)
}

impl ProgCache {
    /// Opens (or starts) <dir>/glprog.bin for the current context. Off on a GLES 2 context, when
    /// the driver offers no binary format, or with POWERBOAT_GL_PROGRAM_CACHE=0.
    pub fn open(gl: &glow::Context, dir: Option<&Path>, start: Instant) -> ProgCache {
        let mut pc = ProgCache { debug: std::env::var_os("POWERBOAT_CACHE_DEBUG").is_some(), start: Some(start), ..Default::default() };
        if std::env::var("POWERBOAT_GL_PROGRAM_CACHE").is_ok_and(|v| v == "0") {
            return pc;
        }
        let Some(dir) = dir else { return pc };
        let v = gl.version();
        if !v.is_embedded || v.major < 3 {
            return pc;
        }
        let formats = unsafe { gl.get_parameter_i32(glow::NUM_PROGRAM_BINARY_FORMATS) };
        if formats <= 0 {
            if pc.debug {
                eprintln!("[powerboat] gl program cache off: the driver offers no program binary format");
            }
            return pc;
        }
        let driver = unsafe {
            format!(
                "{}|{}|{}|{}",
                gl.get_parameter_string(glow::VENDOR),
                gl.get_parameter_string(glow::RENDERER),
                gl.get_parameter_string(glow::VERSION),
                gl.get_parameter_string(glow::SHADING_LANGUAGE_VERSION)
            )
        };
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("[powerboat] gl program cache off: {}: {e}", dir.display());
            return pc;
        }
        let path = dir.join("glprog.bin");
        let t = Instant::now();
        match pc.load(&path, &driver) {
            Ok(f) => {
                pc.file = Some(f);
                pc.on = true;
                if pc.debug {
                    eprintln!("[powerboat] gl program cache: {} programs in {} ({:.1} ms)", pc.index.len(), path.display(), t.elapsed().as_secs_f64() * 1e3);
                }
            }
            Err(e) => eprintln!("[powerboat] gl program cache off: {}: {e}", path.display()),
        }
        pc
    }

    fn load(&mut self, path: &Path, driver: &str) -> std::io::Result<File> {
        let mut f = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
        let size = f.metadata()?.len();
        let mut header = Vec::with_capacity(12 + driver.len());
        header.extend_from_slice(MAGIC);
        header.extend_from_slice(&(driver.len() as u32).to_le_bytes());
        header.extend_from_slice(driver.as_bytes());
        let reset = std::env::var("POWERBOAT_GL_PROGRAM_CACHE").is_ok_and(|v| v == "reset");
        let mut start_over = reset || size > MAX_FILE || size < header.len() as u64;
        if !start_over {
            let mut have = vec![0u8; header.len()];
            f.read_exact(&mut have)?;
            start_over = have != header;
        }
        if start_over {
            if size > 0 && self.debug {
                eprintln!("[powerboat] gl program cache: new file (other driver, damaged or over 32 MB)");
            }
            f.set_len(0)?;
            f.seek(SeekFrom::Start(0))?;
            f.write_all(&header)?;
            return Ok(f);
        }
        // Records: index the binaries (read on a hit), remember which shader sources compiled.
        let mut data = Vec::new();
        f.read_to_end(&mut data)?;
        let base = header.len() as u64;
        let mut pos = 0usize;
        let rd32 = |d: &[u8], at: usize| u32::from_le_bytes(d[at..at + 4].try_into().unwrap());
        let rd128 = |d: &[u8], at: usize| u128::from_le_bytes(d[at..at + 16].try_into().unwrap());
        loop {
            let rest = data.len() - pos;
            if rest == 0 {
                break;
            }
            // REC, key, count
            let ok_head = rest >= 24 && &data[pos..pos + 4] == REC;
            let n = if ok_head { rd32(&data, pos + 20) as usize } else { 0 };
            let fixed = 24 + n * 16 + 8;
            if !ok_head || n > 16 || rest < fixed {
                break;
            }
            let format = rd32(&data, pos + 24 + n * 16);
            let len = rd32(&data, pos + 28 + n * 16) as usize;
            if rest < fixed + len + 8 {
                break;
            }
            let key = rd128(&data, pos + 4);
            let hashes: Vec<u128> = (0..n).map(|i| rd128(&data, pos + 24 + i * 16)).collect();
            let off = base + (pos + fixed) as u64;
            let sum = u64::from_le_bytes(data[pos + fixed + len..pos + fixed + len + 8].try_into().unwrap());
            self.index.insert(key, Entry { off, len: len as u32, format, sum });
            self.known.extend(hashes);
            pos += fixed + len + 8;
        }
        if pos < data.len() {
            // A torn or damaged tail (power cut mid-write): cut it so appends start clean.
            if self.debug {
                eprintln!("[powerboat] gl program cache: cut {} damaged bytes at the end", data.len() - pos);
            }
            f.set_len(base + pos as u64)?;
        }
        Ok(f)
    }

    pub fn create_shader(&mut self, id: u32, ty: u32) {
        if id != 0 {
            self.shaders.insert(id, ShaderRec { ty, hash: 0, deferred: false, deleted: false });
        }
    }

    fn is_attached(&self, s: u32) -> bool {
        self.attached.values().any(|v| v.contains(&s))
    }

    pub fn delete_shader(&mut self, id: u32) {
        if self.is_attached(id) {
            if let Some(r) = self.shaders.get_mut(&id) {
                r.deleted = true;
            }
        } else {
            self.shaders.remove(&id);
        }
    }

    fn drop_deleted(&mut self, ids: &[u32]) {
        for s in ids {
            if self.shaders.get(s).is_some_and(|r| r.deleted) && !self.is_attached(*s) {
                self.shaders.remove(s);
            }
        }
    }

    /// Compiles a deferred shader for real (its GL source is still the one it was deferred with).
    fn compile_late(&mut self, gl: &glow::Context, id: u32) {
        if let Some(r) = self.shaders.get_mut(&id) {
            if r.deferred {
                r.deferred = false;
                self.stats.late_compiles += 1;
                if let Some(s) = shader(id) {
                    let t = Instant::now();
                    unsafe { gl.compile_shader(s) };
                    self.stats.driver_ms += t.elapsed().as_secs_f64() * 1e3;
                }
            }
        }
    }

    /// Before GL gets a new source: a shader deferred with its old source is compiled first, so
    /// the GL state stays what WebGL expects (the old compile stands until the next compileShader).
    pub fn shader_source(&mut self, gl: &glow::Context, id: u32, src: &str) {
        self.compile_late(gl, id);
        if let Some(r) = self.shaders.get_mut(&id) {
            r.hash = fnv128(&[&r.ty.to_le_bytes(), src.as_bytes()]);
        }
    }

    /// compileShader: true when the compile was skipped (source compiled on this driver before).
    pub fn compile_shader(&mut self, gl: &glow::Context, id: u32) {
        let skip = self.on && self.shaders.get(&id).is_some_and(|r| r.hash != 0 && self.known.contains(&r.hash));
        if let Some(r) = self.shaders.get_mut(&id) {
            r.deferred = skip;
        }
        if skip {
            self.stats.skipped_compiles += 1;
            return;
        }
        if let Some(s) = shader(id) {
            let t = Instant::now();
            unsafe { gl.compile_shader(s) };
            self.stats.driver_ms += t.elapsed().as_secs_f64() * 1e3;
        }
    }

    pub fn compile_status(&mut self, gl: &glow::Context, id: u32) -> bool {
        if self.shaders.get(&id).is_some_and(|r| r.deferred) {
            return true;
        }
        let Some(s) = shader(id) else { return false };
        let t = Instant::now();
        let ok = unsafe { gl.get_shader_compile_status(s) };
        self.stats.driver_ms += t.elapsed().as_secs_f64() * 1e3;
        ok
    }

    /// None: ask GL. A deferred shader has an empty log (it compiled cleanly before).
    pub fn is_deferred(&self, id: u32) -> bool {
        self.shaders.get(&id).is_some_and(|r| r.deferred)
    }

    pub fn attach(&mut self, p: u32, s: u32) {
        let v = self.attached.entry(p).or_default();
        if !v.contains(&s) {
            v.push(s);
        }
    }
    pub fn detach(&mut self, p: u32, s: u32) {
        if let Some(v) = self.attached.get_mut(&p) {
            v.retain(|&x| x != s);
        }
        self.drop_deleted(&[s]);
    }
    pub fn bind_attrib(&mut self, p: u32, index: u32, name: &str) {
        self.binds.entry(p).or_default().insert(name.to_string(), index);
    }
    pub fn delete_program(&mut self, p: u32) {
        let shaders = self.attached.remove(&p).unwrap_or_default();
        self.binds.remove(&p);
        self.drop_deleted(&shaders);
    }

    /// The program's cache key, or None when it can't be cached (a shader with no known source).
    fn key(&self, p: u32) -> Option<(u128, Vec<u128>)> {
        let ids = self.attached.get(&p)?;
        let mut sh: Vec<(u32, u128)> = Vec::with_capacity(ids.len());
        for id in ids {
            let r = self.shaders.get(id)?;
            if r.hash == 0 {
                return None;
            }
            sh.push((r.ty, r.hash));
        }
        if sh.is_empty() || sh.len() > 16 {
            return None;
        }
        sh.sort();
        let mut bytes = Vec::with_capacity(sh.len() * 20 + 64);
        bytes.push(1u8); // key layout version
        for (ty, h) in &sh {
            bytes.extend_from_slice(&ty.to_le_bytes());
            bytes.extend_from_slice(&h.to_le_bytes());
        }
        if let Some(b) = self.binds.get(&p) {
            for (name, idx) in b {
                bytes.extend_from_slice(name.as_bytes());
                bytes.push(0);
                bytes.extend_from_slice(&idx.to_le_bytes());
            }
        }
        Some((fnv128(&[&bytes]), sh.into_iter().map(|(_, h)| h).collect()))
    }

    fn read_entry(&mut self, key: u128) -> Option<glow::ProgramBinary> {
        let e = self.index.get(&key)?;
        let (off, len, format, sum) = (e.off, e.len as usize, e.format, e.sum);
        let f = self.file.as_mut()?;
        let mut buf = vec![0u8; len];
        let ok = f.seek(SeekFrom::Start(off)).is_ok() && f.read_exact(&mut buf).is_ok() && fnv64(&buf) == sum;
        if !ok {
            if self.debug {
                eprintln!("[powerboat] gl program cache: damaged binary {key:032x}");
            }
            self.index.remove(&key);
            return None;
        }
        Some(glow::ProgramBinary { buffer: buf, format })
    }

    fn store(&mut self, key: u128, hashes: &[u128], bin: &glow::ProgramBinary) {
        let Some(f) = self.file.as_mut() else { return };
        let mut rec = Vec::with_capacity(40 + hashes.len() * 16 + bin.buffer.len());
        rec.extend_from_slice(REC);
        rec.extend_from_slice(&key.to_le_bytes());
        rec.extend_from_slice(&(hashes.len() as u32).to_le_bytes());
        for h in hashes {
            rec.extend_from_slice(&h.to_le_bytes());
        }
        rec.extend_from_slice(&bin.format.to_le_bytes());
        rec.extend_from_slice(&(bin.buffer.len() as u32).to_le_bytes());
        let off_in_rec = rec.len() as u64;
        rec.extend_from_slice(&bin.buffer);
        rec.extend_from_slice(&fnv64(&bin.buffer).to_le_bytes());
        let Ok(end) = f.seek(SeekFrom::End(0)) else { return };
        if end + rec.len() as u64 > MAX_FILE {
            return;
        }
        if f.write_all(&rec).is_err() {
            // A short write leaves a torn tail; the next load cuts it.
            return;
        }
        self.index.insert(key, Entry { off: end + off_in_rec, len: bin.buffer.len() as u32, format: bin.format, sum: fnv64(&bin.buffer) });
        self.known.extend(hashes.iter().copied());
        self.stats.stored += 1;
    }

    pub fn link(&mut self, gl: &glow::Context, id: u32) {
        self.link_inner(gl, id);
        if let Some(t0) = self.start {
            let s = t0.elapsed().as_secs_f64();
            if self.stats.links == 1 {
                self.stats.first_s = s;
            }
            self.stats.last_s = s;
        }
    }

    fn link_inner(&mut self, gl: &glow::Context, id: u32) {
        let Some(p) = program(id) else { return };
        self.stats.links += 1;
        let key = if self.on { self.key(id) } else { None };
        if let Some((k, _)) = &key {
            let t = Instant::now();
            let bin = self.read_entry(*k);
            self.stats.read_ms += t.elapsed().as_secs_f64() * 1e3;
            if let Some(bin) = bin {
                let t = Instant::now();
                let ok = unsafe {
                    gl.program_binary(p, &bin);
                    gl.get_program_link_status(p)
                };
                self.stats.driver_ms += t.elapsed().as_secs_f64() * 1e3;
                if ok {
                    self.stats.hits += 1;
                    return;
                }
                self.stats.rejects += 1;
                self.index.remove(k);
                if self.debug {
                    eprintln!("[powerboat] gl program cache: driver rejected {k:032x}, linking");
                }
            }
        }
        // Link for real: deferred shaders get their compile now.
        for s in self.attached.get(&id).cloned().unwrap_or_default() {
            self.compile_late(gl, s);
        }
        self.stats.misses += 1;
        let t = Instant::now();
        let ok = unsafe {
            if key.is_some() {
                gl.program_binary_retrievable_hint(p, true);
            }
            gl.link_program(p);
            gl.get_program_link_status(p)
        };
        self.stats.driver_ms += t.elapsed().as_secs_f64() * 1e3;
        if let (true, Some((k, hashes))) = (ok, key) {
            if let Some(bin) = unsafe { gl.get_program_binary(p) } {
                if !bin.buffer.is_empty() {
                    self.store(k, &hashes, &bin);
                    if self.debug {
                        eprintln!("[powerboat] gl program cache: stored {k:032x} ({} KB)", bin.buffer.len() >> 10);
                    }
                }
            }
        }
    }

    /// One line for the exit log (nothing when no program was linked).
    pub fn report(&self) -> Option<String> {
        let s = &self.stats;
        if s.links == 0 {
            return None;
        }
        let when = format!("links at {:.2}-{:.2} s", s.first_s, s.last_s);
        Some(if self.on {
            format!(
                "[powerboat] gl programs: {} links, {} from cache, {} linked ({} stored), {} rejected; {} compiles skipped, {} late; driver {:.0} ms, cache read {:.0} ms; {when}",
                s.links, s.hits, s.misses, s.stored, s.rejects, s.skipped_compiles, s.late_compiles, s.driver_ms, s.read_ms
            )
        } else {
            format!("[powerboat] gl programs: {} links, driver {:.0} ms (program cache off); {when}", s.links, s.driver_ms)
        })
    }
}
