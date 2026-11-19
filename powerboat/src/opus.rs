//! Opus decoding through libopus (linked statically, build.rs): Construct 3 exports most sounds
//! as WebM/Opus, and symphonia has no Opus decoder. Symphonia's mkv demuxer hands over the
//! packets and the OpusHead (CodecPrivate); this turns them into 48 kHz planar f32.
use std::os::raw::{c_int, c_void};

#[allow(non_camel_case_types)]
type OpusDecoder = c_void;

extern "C" {
    fn opus_decoder_create(fs: i32, channels: c_int, error: *mut c_int) -> *mut OpusDecoder;
    fn opus_decode_float(st: *mut OpusDecoder, data: *const u8, len: i32, pcm: *mut f32, frame_size: c_int, decode_fec: c_int) -> c_int;
    fn opus_decoder_destroy(st: *mut OpusDecoder);
}

pub const RATE: u32 = 48000;
/// Longest Opus frame: 120 ms at 48 kHz.
const MAX_FRAME: usize = 5760;

pub struct Decoder {
    st: *mut OpusDecoder,
    channels: usize,
    /// Samples per channel still to drop from the start (OpusHead pre-skip).
    skip: usize,
    pcm: Vec<f32>,
}

impl Decoder {
    /// `head` is the OpusHead block (mkv CodecPrivate); without one: stereo, no pre-skip.
    pub fn new(head: Option<&[u8]>, channels_hint: usize) -> Result<Decoder, String> {
        let (channels, skip) = match head {
            Some(h) if h.len() >= 19 && &h[..8] == b"OpusHead" => {
                if h[18] != 0 && h[9] > 2 {
                    return Err(format!("opus: channel mapping family {} with {} channels not supported", h[18], h[9]));
                }
                (h[9].max(1) as usize, u16::from_le_bytes([h[10], h[11]]) as usize)
            }
            _ => (channels_hint.clamp(1, 2), 0),
        };
        let mut err: c_int = 0;
        let st = unsafe { opus_decoder_create(RATE as i32, channels as c_int, &mut err) };
        if st.is_null() || err != 0 {
            return Err(format!("opus_decoder_create failed ({err})"));
        }
        Ok(Decoder { st, channels, skip, pcm: vec![0.0; MAX_FRAME * channels] })
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Decodes one packet and appends its samples to `out` (one Vec per channel).
    pub fn decode_into(&mut self, packet: &[u8], out: &mut [Vec<i16>]) -> Result<(), String> {
        let n = unsafe { opus_decode_float(self.st, packet.as_ptr(), packet.len() as i32, self.pcm.as_mut_ptr(), MAX_FRAME as c_int, 0) };
        if n < 0 {
            return Err(format!("opus_decode_float failed ({n})"));
        }
        let n = n as usize;
        let drop = self.skip.min(n);
        self.skip -= drop;
        for f in drop..n {
            for (c, ch) in out.iter_mut().enumerate().take(self.channels) {
                ch.push(crate::audio::to_i16(self.pcm[f * self.channels + c]));
            }
        }
        Ok(())
    }
}

impl Decoder {
    /// After a seek: the pre-skip only applies at the stream start.
    pub fn without_preskip(mut self) -> Decoder {
        self.skip = 0;
        self
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe { opus_decoder_destroy(self.st) }
    }
}

// The decoder state is only touched by the thread that owns the Decoder.
unsafe impl Send for Decoder {}
