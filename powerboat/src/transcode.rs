//! `--transcode-videos <dir>`: converts a game's H.264 MP4 videos once (at install) into VP9 WebM
//! copies, `<name>.mp4.powerboat.webm` next to each, which op_video_open then plays instead. On the RG
//! Cube XX OpenH264 decodes BOD EFSANESI's 1080p cutscenes at ~104 ms a frame; VP9 at 720p takes ~10.
//! Decoding is video.rs's (OpenH264 / libvpx), scaling is bilinear here, encoding is libvpx VP9 in
//! realtime mode and libopus for the soundtrack (src/enc_shim.c), muxing is a minimal WebM writer.
//! Options: --max-size WxH (default 1280x720, fitted with the aspect kept), --kbps N (video target,
//! default 600; realtime rate control overshoots about 2x: BOD's 720p came out ~1.3 Mbps, 39 dB PSNR),
//! --cpu-used N (libvpx speed 5-9, default 7; on the Cube the H.264 decode sets the pace either way),
//! --force (convert again), --max-fps N (default 30: frames closer together are dropped).
//! WebM videos are converted too when they exceed the size or the frame rate (`<name>.webm.powerboat.webm`):
//! Moonstone Island's intro is VP9 2560x1440 at 60 fps, 6.3 s of decoding per shown frame on the Smart Pro.
//! WebM files without a video track (sounds) and small ones are left alone.

use std::ffi::{c_char, c_int, c_ulong, c_void, CStr};
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::vpx::Picture;

extern "C" {
    fn powerboat_vp9enc_new(w: c_int, h: c_int, tb_den: c_int, kbps: c_int, threads: c_int, cpu_used: c_int, kf_max: c_int, cq: c_int, good: c_int, err: *mut c_char, errlen: c_int) -> *mut c_void;
    fn powerboat_vp9enc_encode(e: *mut c_void, y: *const u8, sy: c_int, u: *const u8, su: c_int, v: *const u8, sv: c_int, pts: i64, dur: c_ulong, force_key: c_int) -> c_int;
    fn powerboat_vp9enc_next(e: *mut c_void, data: *mut *const u8, size: *mut usize, pts: *mut i64, key: *mut c_int) -> c_int;
    fn powerboat_vp9enc_error(e: *mut c_void) -> *const c_char;
    fn powerboat_vp9enc_free(e: *mut c_void);
    fn powerboat_opusenc_new(channels: c_int, kbps: c_int, lookahead: *mut c_int) -> *mut c_void;
    fn powerboat_opusenc_encode(o: *mut c_void, pcm: *const f32, frame: c_int, out: *mut u8, max: c_int) -> c_int;
    fn powerboat_opusenc_free(o: *mut c_void);
}

pub struct Options {
    pub max_w: u32,
    pub max_h: u32,
    pub kbps: u32,
    pub cpu_used: i32,
    /// Constant quality level (0 = target bitrate instead).
    pub cq: i32,
    /// libvpx's "good" deadline instead of realtime.
    pub good: bool,
    pub force: bool,
    /// Highest frame rate kept; frames closer together than 1/max_fps are dropped.
    pub max_fps: f64,
}

/// One encoded block: track 1 video / 2 audio, time in ms, keyframe flag.
struct Block {
    track: u8,
    ms: i64,
    key: bool,
    data: Vec<u8>,
}

struct Vp9 {
    e: *mut c_void,
}

impl Vp9 {
    fn new(w: u32, h: u32, kbps: u32, cpu_used: i32, cq: i32, good: bool) -> Result<Self, String> {
        let mut err = [0 as c_char; 256];
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get().min(8)) as c_int;
        // A keyframe at least every 5 s (seeking back restarts from the first one anyway).
        let e = unsafe { powerboat_vp9enc_new(w as c_int, h as c_int, 1000, kbps as c_int, threads, cpu_used, 150, cq, good as c_int, err.as_mut_ptr(), err.len() as c_int) };
        if e.is_null() {
            return Err(unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy().into_owned());
        }
        Ok(Self { e })
    }
    /// Encodes one frame (None flushes) and appends the packets that came out.
    fn encode(&mut self, frame: Option<(&[Vec<u8>; 3], &[usize; 3])>, ms: i64, dur: u64, out: &mut Vec<Block>) -> Result<(), String> {
        let r = unsafe {
            match frame {
                Some((p, s)) => powerboat_vp9enc_encode(self.e, p[0].as_ptr(), s[0] as c_int, p[1].as_ptr(), s[1] as c_int, p[2].as_ptr(), s[2] as c_int, ms, dur as c_ulong, 0),
                None => powerboat_vp9enc_encode(self.e, std::ptr::null(), 0, std::ptr::null(), 0, std::ptr::null(), 0, ms, dur as c_ulong, 0),
            }
        };
        if r != 0 {
            return Err(unsafe { CStr::from_ptr(powerboat_vp9enc_error(self.e)) }.to_string_lossy().into_owned());
        }
        let (mut data, mut size, mut pts, mut key) = (std::ptr::null(), 0usize, 0i64, 0 as c_int);
        while unsafe { powerboat_vp9enc_next(self.e, &mut data, &mut size, &mut pts, &mut key) } == 1 {
            out.push(Block { track: 1, ms: pts, key: key != 0, data: unsafe { std::slice::from_raw_parts(data, size) }.to_vec() });
        }
        Ok(())
    }
}

impl Drop for Vp9 {
    fn drop(&mut self) {
        unsafe { powerboat_vp9enc_free(self.e) }
    }
}

/// Bilinear scale of one 8-bit plane (16.16 fixed point, pixel centers aligned).
fn scale_plane(src: &[u8], sstride: usize, sw: usize, sh: usize, dst: &mut [u8], dw: usize, dh: usize) {
    if sw == dw && sh == dh {
        for y in 0..dh {
            dst[y * dw..(y + 1) * dw].copy_from_slice(&src[y * sstride..y * sstride + sw]);
        }
        return;
    }
    let fx = ((sw as u64) << 16) / dw as u64;
    let fy = ((sh as u64) << 16) / dh as u64;
    let xs: Vec<(usize, u32)> = (0..dw)
        .map(|x| {
            let p = ((x as u64 * fx + fx / 2) as i64 - 0x8000).max(0) as u64;
            let i = ((p >> 16) as usize).min(sw - 1);
            (i, (p & 0xffff) as u32 >> 8)
        })
        .collect();
    for y in 0..dh {
        let p = ((y as u64 * fy + fy / 2) as i64 - 0x8000).max(0) as u64;
        let y0 = ((p >> 16) as usize).min(sh - 1);
        let y1 = (y0 + 1).min(sh - 1);
        let wy = (p & 0xffff) as u32 >> 8;
        let (r0, r1) = (&src[y0 * sstride..], &src[y1 * sstride..]);
        let o = &mut dst[y * dw..(y + 1) * dw];
        for (x, &(i, wx)) in xs.iter().enumerate() {
            let j = (i + 1).min(sw - 1);
            let top = r0[i] as u32 * (256 - wx) + r0[j] as u32 * wx;
            let bot = r1[i] as u32 * (256 - wx) + r1[j] as u32 * wx;
            o[x] = ((top * (256 - wy) + bot * wy + 32768) >> 16) as u8;
        }
    }
}

/// The output size: the source fitted into max_w x max_h (never upscaled), even dimensions.
fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let k = (max_w as f64 / w as f64).min(max_h as f64 / h as f64).min(1.0);
    let even = |v: f64| ((v.round() as u32) & !1).max(2);
    (even(w as f64 * k), even(h as f64 * k))
}

/// The soundtrack as Opus blocks (20 ms each, 48 kHz). Returns the blocks, channels and pre-skip.
fn encode_audio(rate: u32, channels: &[Vec<f32>]) -> Result<(Vec<Block>, usize, u32), String> {
    let ch = channels.len().clamp(1, 2);
    let n = channels[0].len();
    // Linear resampling to 48 kHz, interleaved.
    let out_n = (n as u64 * 48000 / rate.max(1) as u64) as usize;
    let mut pcm = vec![0f32; (out_n + 960) * ch];
    for i in 0..out_n {
        let p = i as f64 * rate as f64 / 48000.0;
        let j = p as usize;
        let f = (p - j as f64) as f32;
        for c in 0..ch {
            let s = &channels[c.min(channels.len() - 1)];
            let a = s[j.min(n - 1)];
            let b = s[(j + 1).min(n - 1)];
            pcm[i * ch + c] = a + (b - a) * f;
        }
    }
    let mut lookahead: c_int = 0;
    let o = unsafe { powerboat_opusenc_new(ch as c_int, if ch == 2 { 128 } else { 64 }, &mut lookahead) };
    if o.is_null() {
        return Err("opus encoder init failed".into());
    }
    let mut blocks = Vec::new();
    let mut buf = vec![0u8; 4000];
    let frames = out_n.div_ceil(960);
    for k in 0..frames {
        let len = unsafe { powerboat_opusenc_encode(o, pcm[k * 960 * ch..].as_ptr(), 960, buf.as_mut_ptr(), buf.len() as c_int) };
        if len < 0 {
            unsafe { powerboat_opusenc_free(o) };
            return Err(format!("opus encode: {len}"));
        }
        blocks.push(Block { track: 2, ms: (k as i64 * 20), key: true, data: buf[..len as usize].to_vec() });
    }
    unsafe { powerboat_opusenc_free(o) };
    Ok((blocks, ch, lookahead as u32))
}

// ---- WebM (Matroska) writing ------------------------------------------------------------------

fn id_bytes(id: u32, out: &mut Vec<u8>) {
    let n = if id > 0xff_ffff { 4 } else if id > 0xffff { 3 } else if id > 0xff { 2 } else { 1 };
    out.extend_from_slice(&id.to_be_bytes()[4 - n..]);
}
fn size_vint(len: u64, out: &mut Vec<u8>) {
    let mut n = 1;
    while n < 8 && len >= (1u64 << (7 * n)) - 1 {
        n += 1;
    }
    let v = len | (1u64 << (7 * n));
    out.extend_from_slice(&v.to_be_bytes()[8 - n..]);
}
fn el(id: u32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 12);
    id_bytes(id, &mut out);
    size_vint(body.len() as u64, &mut out);
    out.extend_from_slice(body);
    out
}
fn uint(id: u32, v: u64) -> Vec<u8> {
    let b = v.to_be_bytes();
    let skip = b.iter().take(7).take_while(|&&x| x == 0).count();
    el(id, &b[skip..])
}
fn float(id: u32, v: f64) -> Vec<u8> {
    el(id, &v.to_be_bytes())
}
fn string(id: u32, s: &str) -> Vec<u8> {
    el(id, s.as_bytes())
}
fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.concat()
}

fn write_webm(path: &Path, w: u32, h: u32, duration_ms: f64, mut blocks: Vec<Block>, audio: Option<(usize, u32)>) -> std::io::Result<()> {
    let ebml = el(0x1A45DFA3, &cat(&[uint(0x4286, 1), uint(0x42F7, 1), uint(0x42F2, 4), uint(0x42F3, 8), string(0x4282, "webm"), uint(0x4287, 4), uint(0x4285, 2)]));
    let app = "powerboat --transcode-videos";
    let info = el(0x1549A966, &cat(&[uint(0x2AD7B1, 1_000_000), float(0x4489, duration_ms), string(0x4D80, app), string(0x5741, app)]));
    let video = el(0xAE, &cat(&[uint(0xD7, 1), uint(0x73C5, 1), uint(0x83, 1), uint(0x9C, 0), string(0x86, "V_VP9"), el(0xE0, &cat(&[uint(0xB0, w as u64), uint(0xBA, h as u64)]))]));
    let mut tracks = video;
    if let Some((ch, preskip)) = audio {
        // OpusHead: version 1, channels, pre-skip, input rate, gain 0, mapping family 0.
        let mut head = b"OpusHead".to_vec();
        head.push(1);
        head.push(ch as u8);
        head.extend_from_slice(&(preskip as u16).to_le_bytes());
        head.extend_from_slice(&48000u32.to_le_bytes());
        head.extend_from_slice(&0i16.to_le_bytes());
        head.push(0);
        let delay_ns = preskip as u64 * 1_000_000_000 / 48000;
        tracks.extend(el(0xAE, &cat(&[
            uint(0xD7, 2), uint(0x73C5, 2), uint(0x83, 2), uint(0x9C, 0), string(0x86, "A_OPUS"), el(0x63A2, &head),
            uint(0x56AA, delay_ns), uint(0x56BB, 80_000_000),
            el(0xE1, &cat(&[float(0xB5, 48000.0), uint(0x9F, ch as u64)])),
        ])));
    }
    let tracks = el(0x1654AE6B, &tracks);
    // Blocks in time order (video first at equal times); a cluster at each video keyframe, and at
    // least every 30 s (SimpleBlock times are i16 ms relative to the cluster).
    blocks.sort_by_key(|b| (b.ms, b.track));
    let mut clusters = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let mut base = i64::MIN;
    for b in &blocks {
        if base == i64::MIN || (b.track == 1 && b.key) || b.ms - base > 30_000 {
            if base != i64::MIN {
                clusters.extend(el(0x1F43B675, &cur));
            }
            base = b.ms;
            cur = uint(0xE7, base.max(0) as u64);
        }
        let mut sb = vec![0x80 | b.track];
        sb.extend_from_slice(&((b.ms - base) as i16).to_be_bytes());
        sb.push(if b.key { 0x80 } else { 0 });
        sb.extend_from_slice(&b.data);
        cur.extend(el(0xA3, &sb));
    }
    if base != i64::MIN {
        clusters.extend(el(0x1F43B675, &cur));
    }
    let segment = el(0x18538067, &cat(&[info, tracks, clusters]));
    let tmp = path.with_extension("webm.tmp");
    std::fs::write(&tmp, cat(&[ebml, segment]))?;
    std::fs::rename(&tmp, path)
}

// ---- driver -----------------------------------------------------------------------------------

/// Converts one file. Prints progress; returns the output size in bytes.
fn convert(src: &Path, dst: &Path, o: &Options) -> Result<u64, String> {
    let data = std::fs::read(src).map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    let mut enc: Option<Vp9> = None;
    let mut out_size = (0u32, 0u32);
    let mut blocks = Vec::new();
    let mut planes: [Vec<u8>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    let mut frames = 0usize;
    let mut last_ms = 0i64;
    let mut last_report = Instant::now();
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // Frame dropping above max_fps: a frame is kept when its time reaches the next slot (2 ms slack for
    // rounded timestamps); slots are 1/max_fps apart, restarting from a kept frame that came late.
    let step = if o.max_fps > 0.0 { 1.0 / o.max_fps } else { 0.0 };
    let mut next_slot = f64::NEG_INFINITY;
    let dur = if o.max_fps > 0.0 { (1000.0 / o.max_fps).round().max(1.0) as u64 } else { 33 };
    let (sw, sh, duration, audio) = crate::video::decode_frames(data, |pic: &Picture, t: f64| {
        if t + 0.002 < next_slot {
            return Ok(());
        }
        next_slot = if next_slot.is_finite() && t < next_slot + step { next_slot + step } else { t + step };
        if enc.is_none() {
            let (w, h) = fit(pic.width as u32, pic.height as u32, o.max_w, o.max_h);
            out_size = (w, h);
            planes = [vec![0; (w * h) as usize], vec![0; (w * h / 4) as usize], vec![0; (w * h / 4) as usize]];
            enc = Some(Vp9::new(w, h, o.kbps, o.cpu_used, o.cq, o.good)?);
        }
        let (w, h) = (out_size.0 as usize, out_size.1 as usize);
        let (cw, ch) = (pic.width.div_ceil(2), pic.height.div_ceil(2));
        scale_plane(pic.planes[0], pic.strides[0], pic.width, pic.height, &mut planes[0], w, h);
        scale_plane(pic.planes[1], pic.strides[1], cw, ch, &mut planes[1], w / 2, h / 2);
        scale_plane(pic.planes[2], pic.strides[2], cw, ch, &mut planes[2], w / 2, h / 2);
        let ms = (t * 1000.0).round() as i64;
        let ms = ms.max(last_ms + if frames == 0 { 0 } else { 1 });
        enc.as_mut().unwrap().encode(Some((&planes, &[w, w / 2, w / 2])), ms, dur, &mut blocks)?;
        frames += 1;
        last_ms = ms;
        if last_report.elapsed().as_secs_f64() >= 5.0 {
            last_report = Instant::now();
            println!("transcode: {name}: {frames} frames ({:.0} s of video), {:.1} fps", t, frames as f64 / t0.elapsed().as_secs_f64());
        }
        Ok(())
    })?;
    let Some(mut e) = enc else { return Err("no frames decoded".into()) };
    e.encode(None, last_ms + dur as i64, dur, &mut blocks)?;
    drop(e);
    let audio_info = match audio {
        Some((rate, ch)) if !ch.is_empty() && !ch[0].is_empty() => {
            let (ab, chn, preskip) = encode_audio(rate, &ch)?;
            blocks.extend(ab);
            Some((chn, preskip))
        }
        _ => None,
    };
    write_webm(dst, out_size.0, out_size.1, duration * 1000.0, blocks, audio_info).map_err(|e| format!("{}: {e}", dst.display()))?;
    let size = std::fs::metadata(dst).map(|m| m.len()).unwrap_or(0);
    println!(
        "transcode: {name}: {sw}x{sh} -> {}x{} VP9{}, {frames} frames in {:.1} s ({:.1} fps), {:.1} MB",
        out_size.0,
        out_size.1,
        if audio_info.is_some() { " + Opus" } else { "" },
        t0.elapsed().as_secs_f64(),
        frames as f64 / t0.elapsed().as_secs_f64(),
        size as f64 / 1_048_576.0
    );
    Ok(size)
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            collect(&p, out);
        } else if p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("mp4") || e.eq_ignore_ascii_case("m4v") || e.eq_ignore_ascii_case("webm"))
            && !p.to_string_lossy().ends_with(".powerboat.webm")
        {
            out.push(p);
        }
    }
}

/// Whether a WebM file is a video above the size or frame-rate limit (MP4s are always converted).
fn webm_needs_converting(p: &Path, o: &Options) -> bool {
    let Ok(data) = std::fs::read(p) else { return false };
    match crate::video::probe(data) {
        Some((w, h, fps)) => w > o.max_w || h > o.max_h || (o.max_fps > 0.0 && fps > o.max_fps + 0.5),
        None => false,
    }
}

/// The --transcode-videos entry point: every .mp4/.m4v under dir, and every .webm video above the size
/// or frame-rate limit. Exit code 0 when all converted (or already were), 1 if any failed.
pub fn run(dir: &Path, o: &Options) -> i32 {
    let mut files = Vec::new();
    collect(dir, &mut files);
    files.retain(|p| !p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("webm")) || webm_needs_converting(p, o));
    if files.is_empty() {
        println!("transcode: no videos to convert under {}", dir.display());
        return 0;
    }
    let t0 = Instant::now();
    let mut failed = 0;
    for (i, src) in files.iter().enumerate() {
        let mut dst = src.as_os_str().to_owned();
        dst.push(".powerboat.webm");
        let dst = PathBuf::from(dst);
        let newer = |a: &Path, b: &Path| -> bool {
            match (std::fs::metadata(a).and_then(|m| m.modified()), std::fs::metadata(b).and_then(|m| m.modified())) {
                (Ok(x), Ok(y)) => x >= y,
                _ => false,
            }
        };
        if !o.force && newer(&dst, src) {
            println!("transcode: [{}/{}] {} already converted", i + 1, files.len(), src.display());
            continue;
        }
        println!("transcode: [{}/{}] {}", i + 1, files.len(), src.display());
        if let Err(e) = convert(src, &dst, o) {
            eprintln!("transcode: {}: {e}", src.display());
            let _ = std::fs::remove_file(dst.with_extension("webm.tmp"));
            failed += 1;
        }
    }
    println!("transcode: done, {} file(s), {} failed, {:.0} s", files.len(), failed, t0.elapsed().as_secs_f64());
    if failed > 0 { 1 } else { 0 }
}
