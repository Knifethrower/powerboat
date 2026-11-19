//! Fonts for Canvas 2D text: TrueType/OpenType faces registered by family (from MV's
//! fonts/gamefont.css @font-face rules, plus runtime fallbacks), glyph outlines as tiny-skia paths
//! (so fillText and strokeText share one rasterizer and outlines are exact), simple
//! left-to-right layout with kerning. No shaping: MV text is Latin/CJK, drawn glyph by glyph.

use std::collections::HashMap;

use tiny_skia::{FillRule, Mask, Path, PathBuilder, PathStroker, Stroke, Transform};
use ttf_parser::{Face, GlyphId};

pub struct FontFace {
    pub family: String,
    pub bold: bool,
    pub italic: bool,
    data: Vec<u8>,
    pub units_per_em: f32,
    pub ascender: f32,
    pub descender: f32,
    glyphs: HashMap<u16, Option<Path>>,
    advances: HashMap<u16, f32>,
    chars: HashMap<char, u16>,
    /// Kerning by glyph pair; `kern` false when the face has no usable kern table.
    kerns: HashMap<(u16, u16), f32>,
    kern: bool,
}

impl FontFace {
    fn face(&self) -> Face<'_> {
        Face::parse(&self.data, 0).expect("font parsed at load")
    }
    fn glyph_index(&mut self, c: char) -> u16 {
        if let Some(&g) = self.chars.get(&c) {
            return g;
        }
        let g = self.face().glyph_index(c).map(|g| g.0).unwrap_or(0);
        self.chars.insert(c, g);
        g
    }
    /// Advance in font units.
    fn advance(&mut self, g: u16) -> f32 {
        if let Some(&a) = self.advances.get(&g) {
            return a;
        }
        let a = self.face().glyph_hor_advance(GlyphId(g)).unwrap_or(0) as f32;
        self.advances.insert(g, a);
        a
    }
    /// Cached: parsing the face for every pair was most of measureText's time (19 us a call on the
    /// RG-34XXSP, 514 runs of 100 a second).
    fn kerning(&mut self, left: u16, right: u16) -> f32 {
        if !self.kern {
            return 0.0;
        }
        if let Some(&k) = self.kerns.get(&(left, right)) {
            return k;
        }
        let k = self.kerning_uncached(left, right);
        if self.kerns.len() > 65536 {
            self.kerns.clear();
        }
        self.kerns.insert((left, right), k);
        k
    }
    fn kerning_uncached(&self, left: u16, right: u16) -> f32 {
        let face = self.face();
        let Some(kern) = face.tables().kern else { return 0.0 };
        for sub in kern.subtables {
            if !sub.horizontal || sub.variable {
                continue;
            }
            if let Some(k) = sub.glyphs_kerning(GlyphId(left), GlyphId(right)) {
                return k as f32;
            }
        }
        0.0
    }
    /// Outline in font units, y up; None for empty glyphs (spaces).
    pub fn glyph_path(&mut self, g: u16) -> Option<&Path> {
        if !self.glyphs.contains_key(&g) {
            let mut b = Builder(PathBuilder::new());
            let path = self.face().outline_glyph(GlyphId(g), &mut b).and_then(|_| b.0.finish());
            self.glyphs.insert(g, path);
        }
        self.glyphs.get(&g).and_then(|p| p.as_ref())
    }
}

struct Builder(PathBuilder);
impl ttf_parser::OutlineBuilder for Builder {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, y);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.0.quad_to(x1, y1, x, y);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.0.cubic_to(x1, y1, x2, y2, x, y);
    }
    fn close(&mut self) {
        self.0.close();
    }
}

/// A parsed CSS `font` shorthand.
#[derive(Clone, Debug)]
pub struct FontSpec {
    pub size: f32,
    pub bold: bool,
    pub italic: bool,
    pub families: Vec<String>,
}

impl Default for FontSpec {
    fn default() -> Self {
        FontSpec { size: 10.0, bold: false, italic: false, families: vec!["sans-serif".into()] }
    }
}

impl FontSpec {
    /// "bold 28px GameFont, sans-serif", "italic 20px 'Some Font'". Unparseable -> None (the
    /// canvas keeps its previous font, as browsers do).
    pub fn parse(s: &str) -> Option<FontSpec> {
        let mut spec = FontSpec::default();
        let mut rest = s.trim();
        let mut size_found = false;
        while !rest.is_empty() {
            let (tok, after) = match rest.find(|c: char| c.is_whitespace()) {
                Some(i) => (&rest[..i], rest[i..].trim_start()),
                None => (rest, ""),
            };
            let lower = tok.to_ascii_lowercase();
            match lower.as_str() {
                "normal" | "small-caps" | "lighter" | "ultra-condensed" | "extra-condensed" | "condensed"
                | "semi-condensed" | "semi-expanded" | "expanded" | "extra-expanded" | "ultra-expanded" => {}
                "bold" | "bolder" => spec.bold = true,
                "italic" | "oblique" => spec.italic = true,
                _ => {
                    if let Ok(w) = lower.parse::<u32>() {
                        spec.bold = w >= 600;
                    } else if let Some(size) = parse_size(&lower) {
                        spec.size = size;
                        size_found = true;
                        // Everything after the size is the family list.
                        spec.families = after
                            .split(',')
                            .map(|f| f.trim().trim_matches('"').trim_matches('\'').to_string())
                            .filter(|f| !f.is_empty())
                            .collect();
                        if spec.families.is_empty() {
                            spec.families = vec!["sans-serif".into()];
                        }
                        break;
                    } else {
                        return None;
                    }
                }
            }
            rest = after;
        }
        size_found.then_some(spec)
    }
}

fn parse_size(tok: &str) -> Option<f32> {
    // "28px", "28px/32px", "12pt", "1.5em" (em = 16px)
    let tok = tok.split('/').next()?;
    let (num, unit) = tok.split_at(tok.find(|c: char| c.is_ascii_alphabetic() || c == '%')?);
    let v: f32 = num.parse().ok()?;
    Some(match unit {
        "px" => v,
        "pt" => v * 4.0 / 3.0,
        "em" | "rem" => v * 16.0,
        "%" => v / 100.0 * 16.0,
        _ => return None,
    })
}

pub struct Glyph {
    pub face: usize,
    pub glyph: u16,
    /// Pen x in pixels at the start of this glyph.
    pub x: f32,
}

/// Free stand-ins for fonts that games name but do not ship (Windows system fonts, CSS generic
/// families), metric-compatible where one exists so text wraps where the game expects. Used only
/// when no loaded face has the requested family. Construct 2 Text objects ask for "Arial" etc.
const SUBSTITUTES: &[(&str, &str)] = &[
    ("arial", "Liberation Sans"),
    ("arialmt", "Liberation Sans"),
    ("helvetica", "Liberation Sans"),
    ("helvetica neue", "Liberation Sans"),
    ("verdana", "Liberation Sans"),
    ("tahoma", "Liberation Sans"),
    ("segoe ui", "Liberation Sans"),
    ("trebuchet ms", "Liberation Sans"),
    ("sans-serif", "Liberation Sans"),
    ("system-ui", "Liberation Sans"),
    ("times new roman", "Liberation Serif"),
    ("times", "Liberation Serif"),
    ("georgia", "Liberation Serif"),
    ("serif", "Liberation Serif"),
    ("courier new", "Liberation Mono"),
    ("courier", "Liberation Mono"),
    ("consolas", "Liberation Mono"),
    ("lucida console", "Liberation Mono"),
    ("monospace", "Liberation Mono"),
    ("cambria", "Caladea"),
    ("calibri", "Carlito"),
];
/// Browsers' default when no named family is available.
const DEFAULT_FAMILY: &str = "Liberation Sans";

fn substitute(family: &str) -> Option<&'static str> {
    let f = family.to_ascii_lowercase();
    SUBSTITUTES.iter().find(|(k, _)| *k == f).map(|(_, v)| *v)
}

/// A bundled font file not read yet (Fonts::register_dir).
struct Pending {
    family: String,
    path: std::path::PathBuf,
    bold: bool,
    italic: bool,
}

#[derive(Default)]
pub struct Fonts {
    faces: Vec<FontFace>,
    pending: Vec<Pending>,
    /// Rasterized glyphs (see GlyphMask); None: the glyph has no ink.
    masks: HashMap<MaskKey, Option<GlyphMask>>,
    mask_bytes: usize,
}

/// A glyph's coverage, rasterized once per face, size, stroke and sub-pixel offset (MaskKey), then blended
/// for every later fillText / strokeText. Filling each glyph's outline every time was the cost of
/// canvas text: 100 lines of fillText took 86 ms a frame on the RG-34XXSP (quixjs: 25).
pub struct GlyphMask {
    /// Top-left of `data` relative to the glyph origin's whole pixel.
    pub left: i32,
    pub top: i32,
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>,
}

/// Glyph scale in pixels per font unit (x, y) as f32 bits; `qx` the origin's horizontal offset in quarter
/// pixels (0..=3, as Skia positions glyphs), `fy` its vertical offset (0..1) as f32 bits, exact: a line
/// keeps one baseline, and rounding it moved horizontal stems by a whole supersample row (83 levels);
/// `stroke` the stroke width in font units as f32 bits, 0 for a fill.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct MaskKey {
    pub face: usize,
    pub glyph: u16,
    pub sx: u32,
    pub sy: u32,
    pub qx: u8,
    pub fy: u32,
    pub stroke: u32,
    pub join: u8,
    pub miter: u32,
}

/// Cached glyph coverage beyond this is dropped and rebuilt as text is drawn again.
const MASK_CACHE_BYTES: usize = 8 << 20;

pub enum MaskLookup<'a> {
    Ink(&'a GlyphMask),
    /// Nothing to draw (a space).
    Empty,
    /// Too large to cache: draw the outline.
    Path,
}

fn rasterize(path: &Path, sx: f32, sy: f32, fx: f32, fy: f32, stroke: Option<&Stroke>) -> Result<Option<GlyphMask>, ()> {
    // Font units, y up -> pixels, y down, at the sub-pixel offset.
    let ts = Transform::from_row(sx, 0.0, 0.0, -sy, fx, fy);
    let stroked;
    let p = match stroke {
        Some(s) => match path.stroke(s, PathStroker::compute_resolution_scale(&ts)) {
            Some(v) => {
                stroked = v;
                &stroked
            }
            None => return Ok(None),
        },
        None => path,
    };
    let Some(b) = p.clone().transform(ts).map(|q| q.bounds()) else { return Ok(None) };
    let (left, top) = (b.left().floor() as i32 - 1, b.top().floor() as i32 - 1);
    let (right, bottom) = (b.right().ceil() as i32 + 1, b.bottom().ceil() as i32 + 1);
    let (w, h) = ((right - left).max(0) as u32, (bottom - top).max(0) as u32);
    if w > 512 || h > 512 {
        return Err(());
    }
    let Some(mut m) = Mask::new(w.max(1), h.max(1)) else { return Ok(None) };
    m.fill_path(p, FillRule::Winding, true, ts.post_translate(-left as f32, -top as f32));
    let data = m.data().to_vec();
    if data.iter().all(|&c| c == 0) {
        return Ok(None);
    }
    Ok(Some(GlyphMask { left, top, w: w as usize, h: h as usize, data }))
}

impl Fonts {
    /// The glyph's coverage for `key` (stroked with `stroke` when key.stroke is not 0), rasterized on
    /// first use.
    pub fn glyph_mask(&mut self, key: MaskKey, stroke: Option<&Stroke>) -> MaskLookup<'_> {
        if !self.masks.contains_key(&key) {
            let Some(path) = self.faces[key.face].glyph_path(key.glyph) else { return MaskLookup::Empty };
            let (fx, fy) = (key.qx as f32 * 0.25, f32::from_bits(key.fy));
            match rasterize(path, f32::from_bits(key.sx), f32::from_bits(key.sy), fx, fy, stroke) {
                Ok(m) => {
                    if self.mask_bytes > MASK_CACHE_BYTES {
                        self.masks.clear();
                        self.mask_bytes = 0;
                    }
                    self.mask_bytes += 64 + m.as_ref().map_or(0, |m| m.data.len());
                    self.masks.insert(key, m);
                }
                Err(()) => return MaskLookup::Path,
            }
        }
        match self.masks.get(&key) {
            Some(Some(m)) => MaskLookup::Ink(m),
            _ => MaskLookup::Empty,
        }
    }
    /// Registers the runtime's own fonts (`fonts/` next to the binary, or POWERBOAT_FONT_DIR): file
    /// names like `LiberationSans-BoldItalic.ttf` give family "Liberation Sans", bold, italic.
    /// They are read on first use, only as substitutes (see SUBSTITUTES). Returns how many.
    pub fn register_dir(&mut self, dir: &std::path::Path) -> usize {
        let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
        let mut n = 0;
        for e in rd.flatten() {
            let path = e.path();
            let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
            if ext != "ttf" && ext != "otf" {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            let (name, style) = stem.split_once('-').unwrap_or((stem, "Regular"));
            // "LiberationSans" -> "Liberation Sans"
            let mut family = String::new();
            for (i, c) in name.chars().enumerate() {
                if i > 0 && c.is_ascii_uppercase() && !family.ends_with(' ') {
                    family.push(' ');
                }
                family.push(c);
            }
            let style = style.to_ascii_lowercase();
            self.pending.push(Pending { family, path, bold: style.contains("bold"), italic: style.contains("italic") });
            n += 1;
        }
        n
    }
    /// Reads the bundled files a spec will need: substitutes for families no face has.
    fn prepare(&mut self, spec: &FontSpec) {
        if self.pending.is_empty() {
            return;
        }
        let have = |faces: &[FontFace], fam: &str| faces.iter().any(|f| f.family.eq_ignore_ascii_case(fam));
        let mut want: Vec<&'static str> = Vec::new();
        let mut any = false;
        for fam in &spec.families {
            if have(&self.faces, fam) {
                any = true;
                break;
            }
            if let Some(s) = substitute(fam) {
                want.push(s);
                any = true;
                break;
            }
        }
        if !any {
            want.push(DEFAULT_FAMILY);
        }
        for fam in want {
            if have(&self.faces, fam) {
                continue;
            }
            let files: Vec<Pending> = {
                let (take, keep): (Vec<Pending>, Vec<Pending>) = std::mem::take(&mut self.pending).into_iter().partition(|p| p.family.eq_ignore_ascii_case(fam));
                self.pending = keep;
                take
            };
            for p in files {
                match std::fs::read(&p.path) {
                    Ok(data) => {
                        if let Err(e) = self.load(&p.family, data, p.bold, p.italic) {
                            eprintln!("[powerboat] font {}: {e}", p.path.display());
                        }
                    }
                    Err(e) => eprintln!("[powerboat] font {}: {e}", p.path.display()),
                }
            }
        }
    }
    pub fn load(&mut self, family: &str, data: Vec<u8>, bold: bool, italic: bool) -> Result<usize, String> {
        let (units_per_em, ascender, descender, kern) = {
            let face = Face::parse(&data, 0).map_err(|e| format!("{family}: {e}"))?;
            let kern = face.tables().kern.is_some_and(|k| k.subtables.into_iter().any(|s| s.horizontal && !s.variable));
            (face.units_per_em() as f32, face.ascender() as f32, face.descender() as f32, kern)
        };
        self.faces.push(FontFace {
            family: family.to_string(),
            bold,
            italic,
            data,
            units_per_em,
            ascender,
            descender,
            glyphs: HashMap::new(),
            advances: HashMap::new(),
            chars: HashMap::new(),
            kerns: HashMap::new(),
            kern,
        });
        Ok(self.faces.len() - 1)
    }
    pub fn is_empty(&self) -> bool {
        self.faces.is_empty() && self.pending.is_empty()
    }
    pub fn face(&mut self, i: usize) -> &mut FontFace {
        &mut self.faces[i]
    }
    /// Candidate faces for a font spec, best first: requested families (closest style), then
    /// every other face as fallback for missing glyphs.
    fn candidates(&self, spec: &FontSpec) -> Vec<usize> {
        let mut out = Vec::new();
        // A family no face has stands for its substitute (bundled fonts); none at all: the default.
        let mut fams: Vec<&str> = Vec::new();
        for fam in &spec.families {
            if self.faces.iter().any(|f| f.family.eq_ignore_ascii_case(fam)) {
                fams.push(fam);
            } else if let Some(s) = substitute(fam) {
                fams.push(s);
            }
        }
        if fams.is_empty() {
            fams.push(DEFAULT_FAMILY);
        }
        for fam in fams {
            let mut matching: Vec<usize> = (0..self.faces.len())
                .filter(|&i| self.faces[i].family.eq_ignore_ascii_case(fam))
                .collect();
            matching.sort_by_key(|&i| {
                let f = &self.faces[i];
                (f.bold != spec.bold) as u8 + (f.italic != spec.italic) as u8
            });
            for i in matching {
                if !out.contains(&i) {
                    out.push(i);
                }
            }
        }
        for i in 0..self.faces.len() {
            if !out.contains(&i) {
                out.push(i);
            }
        }
        out
    }
    /// Lays text out left to right. Returns the glyphs and the total advance in pixels.
    pub fn layout(&mut self, spec: &FontSpec, text: &str) -> (Vec<Glyph>, f32) {
        self.prepare(spec);
        let cands = self.candidates(spec);
        let mut glyphs = Vec::new();
        let mut x = 0.0f32;
        let mut prev: Option<(usize, u16)> = None;
        for c in text.chars() {
            // As canvas text does: ASCII whitespace (tab, LF, FF, CR) is a space; other control and
            // format characters (zero-width space, BOM, ...) take no room. Fonts often lack them, and
            // their .notdef glyph showed as a thin bar (CRLF text in Construct 2 games).
            let c = match c {
                '\t' | '\n' | '\x0c' | '\r' => ' ',
                c if c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{feff}') => continue,
                c => c,
            };
            let mut pick = None;
            for &fi in &cands {
                let g = self.faces[fi].glyph_index(c);
                if g != 0 {
                    pick = Some((fi, g));
                    break;
                }
            }
            // Space characters a font lacks (no-break space, thin space, ...) use its plain space.
            if pick.is_none() && c.is_whitespace() {
                for &fi in &cands {
                    let g = self.faces[fi].glyph_index(' ');
                    if g != 0 {
                        pick = Some((fi, g));
                        break;
                    }
                }
            }
            let (fi, g) = match pick {
                Some(p) => p,
                None => match cands.first() {
                    Some(&fi) => (fi, 0),
                    None => continue,
                },
            };
            let scale = spec.size / self.faces[fi].units_per_em;
            if let Some((pf, pg)) = prev {
                if pf == fi {
                    x += self.faces[fi].kerning(pg, g) * scale;
                }
            }
            glyphs.push(Glyph { face: fi, glyph: g, x });
            x += self.faces[fi].advance(g) * scale;
            prev = Some((fi, g));
        }
        (glyphs, x)
    }
    /// Ink box of the text for canvas measureText, in pixels from the origin: [left, right, ascent,
    /// descent] (left and descent positive toward the left and below the baseline).
    pub fn ink_box(&mut self, spec: &FontSpec, text: &str) -> [f32; 4] {
        let (glyphs, _) = self.layout(spec, text);
        let mut b: Option<[f32; 4]> = None;
        for g in glyphs {
            let scale = spec.size / self.faces[g.face].units_per_em;
            let Some(r) = self.faces[g.face].glyph_path(g.glyph).map(|p| p.bounds()) else { continue };
            let i = [-(g.x + r.left() * scale), g.x + r.right() * scale, r.bottom() * scale, -r.top() * scale];
            b = Some(b.map_or(i, |o| [o[0].max(i[0]), o[1].max(i[1]), o[2].max(i[2]), o[3].max(i[3])]));
        }
        b.unwrap_or_default()
    }
    /// Ascent and descent in pixels for the first candidate face (baseline placement).
    pub fn metrics(&self, spec: &FontSpec) -> (f32, f32) {
        match self.candidates(spec).first() {
            Some(&i) => {
                let f = &self.faces[i];
                let s = spec.size / f.units_per_em;
                (f.ascender * s, -f.descender * s)
            }
            None => (spec.size * 0.8, spec.size * 0.2),
        }
    }
}
