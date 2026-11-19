//! Per-cell cropping of decoded images (an idea from pmjs's asset preparation): an MV sprite sheet
//! is a grid of cells (character frames, animation cells) with wide transparent borders. Each
//! cell is cut to its visible pixels plus a small transparent halo, empty cells are dropped,
//! identical cells are kept once, and the rest is packed into one smaller "page". The GPU texture
//! and the Canvas 2D copy are made from the page; JS (60_node.js) maps PIXI texture frames onto it,
//! and Canvas 2D drawImage maps source rects cell by cell, so the game sees the original image.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

/// How JS says the game slices an image: `cols` x `rows` cells, or cells of `cell_w` x `cell_h`.
/// All zero: no cropping.
#[derive(Clone, Copy, Default, Debug)]
pub struct Hint {
    pub cols: u32,
    pub rows: u32,
    pub cell_w: u32,
    pub cell_h: u32,
}

impl Hint {
    pub fn none(&self) -> bool {
        self.cols == 0 && self.cell_w == 0
    }
}

#[derive(Clone, Debug)]
pub struct Cell {
    /// The cell's visible part (plus halo) in original-image pixels; w == 0 when it is empty.
    pub crop: [u32; 4],
    /// Where that part sits on the page.
    pub at: [u32; 2],
}

#[derive(Clone, Debug)]
pub struct Layout {
    pub page_w: u32,
    pub page_h: u32,
    pub cols: u32,
    pub rows: u32,
    pub cell_w: u32,
    pub cell_h: u32,
    /// Row-major, cols x rows.
    pub cells: Vec<Cell>,
}

const HALO: u32 = 2;
const GAP: u32 = 2;
/// A layout is used only when the page is at most this share of the original's pixels.
const KEEP_AT_MOST: f64 = 0.8;

fn bbox(rgba: &[u8], w: u32, x0: u32, y0: u32, cw: u32, ch: u32) -> Option<[u32; 4]> {
    let (mut minx, mut miny, mut maxx, mut maxy) = (u32::MAX, u32::MAX, 0, 0);
    for y in y0..y0 + ch {
        let row = &rgba[((y * w + x0) * 4) as usize..((y * w + x0 + cw) * 4) as usize];
        let mut first = None;
        let mut last = 0;
        for (i, px) in row.chunks_exact(4).enumerate() {
            if px[3] != 0 {
                if first.is_none() {
                    first = Some(i as u32);
                }
                last = i as u32;
            }
        }
        if let Some(f) = first {
            minx = minx.min(x0 + f);
            maxx = maxx.max(x0 + last + 1);
            miny = miny.min(y);
            maxy = y + 1;
        }
    }
    if minx == u32::MAX {
        return None;
    }
    Some([minx, miny, maxx - minx, maxy - miny])
}

fn same(rgba: &[u8], w: u32, a: [u32; 4], b: [u32; 4]) -> bool {
    if a[2] != b[2] || a[3] != b[3] {
        return false;
    }
    (0..a[3]).all(|r| {
        let ra = (((a[1] + r) * w + a[0]) * 4) as usize;
        let rb = (((b[1] + r) * w + b[0]) * 4) as usize;
        let n = (a[2] * 4) as usize;
        rgba[ra..ra + n] == rgba[rb..rb + n]
    })
}

/// Plans the cells of a `w` x `h` straight-RGBA image. None: not worth it (or a bad hint).
pub fn plan(rgba: &[u8], w: u32, h: u32, hint: Hint) -> Option<Layout> {
    if hint.none() || w == 0 || h == 0 || rgba.len() != (w * h * 4) as usize {
        return None;
    }
    let (mut cols, mut rows) = if hint.cell_w > 0 && hint.cell_h > 0 {
        (w / hint.cell_w, h / hint.cell_h)
    } else {
        (hint.cols, hint.rows)
    };
    // A sheet that does not divide evenly is cropped as one cell.
    if cols == 0 || rows == 0 || w % cols != 0 || h % rows != 0 || cols * rows > 4096 {
        cols = 1;
        rows = 1;
    }
    let (cw, ch) = (w / cols, h / rows);
    let mut cells = Vec::with_capacity((cols * rows) as usize);
    // Unique crops, found by (size, pixel hash) and then compared pixel by pixel.
    let mut by_hash: HashMap<(u32, u32, u64), Vec<usize>> = HashMap::new();
    let mut uniq: Vec<[u32; 4]> = Vec::new();
    let mut uniq_of_cell: Vec<Option<usize>> = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            let (x0, y0) = (c * cw, r * ch);
            let Some(b) = bbox(rgba, w, x0, y0, cw, ch) else {
                cells.push(Cell { crop: [x0, y0, 0, 0], at: [0, 0] });
                uniq_of_cell.push(None);
                continue;
            };
            let bx = b[0].saturating_sub(HALO).max(x0);
            let by = b[1].saturating_sub(HALO).max(y0);
            let bx1 = (b[0] + b[2] + HALO).min(x0 + cw);
            let by1 = (b[1] + b[3] + HALO).min(y0 + ch);
            let crop = [bx, by, bx1 - bx, by1 - by];
            let mut hs = std::collections::hash_map::DefaultHasher::new();
            for yy in crop[1]..crop[1] + crop[3] {
                let i = ((yy * w + crop[0]) * 4) as usize;
                rgba[i..i + (crop[2] * 4) as usize].hash(&mut hs);
            }
            let key = (crop[2], crop[3], hs.finish());
            let found = by_hash.get(&key).and_then(|v| v.iter().copied().find(|&u| same(rgba, w, uniq[u], crop)));
            let u = match found {
                Some(u) => u,
                None => {
                    uniq.push(crop);
                    by_hash.entry(key).or_default().push(uniq.len() - 1);
                    uniq.len() - 1
                }
            };
            cells.push(Cell { crop, at: [0, 0] });
            uniq_of_cell.push(Some(u));
        }
    }
    // Shelf packing, tallest first, no wider than the original.
    let mut order: Vec<usize> = (0..uniq.len()).collect();
    order.sort_by(|&a, &b| uniq[b][3].cmp(&uniq[a][3]).then(uniq[b][2].cmp(&uniq[a][2])));
    let mut at = vec![[0u32; 2]; uniq.len()];
    let (mut x, mut y, mut shelf, mut page_w) = (0u32, 0u32, 0u32, 1u32);
    for &u in &order {
        let [_, _, uw, uh] = uniq[u];
        if x > 0 && x + uw > w {
            x = 0;
            y += shelf + GAP;
            shelf = 0;
        }
        at[u] = [x, y];
        page_w = page_w.max(x + uw);
        x += uw + GAP;
        shelf = shelf.max(uh);
    }
    let page_h = (y + shelf).max(1);
    if page_w > w || page_h > h || (page_w as f64 * page_h as f64) > KEEP_AT_MOST * (w as f64 * h as f64) {
        return None;
    }
    for (cell, u) in cells.iter_mut().zip(&uniq_of_cell) {
        if let Some(u) = u {
            cell.at = at[*u];
        }
    }
    Some(Layout { page_w, page_h, cols, rows, cell_w: cw, cell_h: ch, cells })
}

impl Layout {
    /// The page's straight RGBA pixels, cut from the full image.
    pub fn extract(&self, full: &[u8], w: u32) -> Vec<u8> {
        let mut page = vec![0u8; (self.page_w * self.page_h * 4) as usize];
        for c in &self.cells {
            let [x, y, cw, ch] = c.crop;
            for r in 0..ch {
                let s = (((y + r) * w + x) * 4) as usize;
                let d = (((c.at[1] + r) * self.page_w + c.at[0]) * 4) as usize;
                page[d..d + (cw * 4) as usize].copy_from_slice(&full[s..s + (cw * 4) as usize]);
            }
        }
        page
    }
    /// The full image again (transparent outside the crops), from the page.
    pub fn expand(&self, page: &[u8], w: u32, h: u32) -> Vec<u8> {
        let mut full = vec![0u8; (w * h * 4) as usize];
        for c in &self.cells {
            let [x, y, cw, ch] = c.crop;
            for r in 0..ch {
                let d = (((y + r) * w + x) * 4) as usize;
                let s = (((c.at[1] + r) * self.page_w + c.at[0]) * 4) as usize;
                full[d..d + (cw * 4) as usize].copy_from_slice(&page[s..s + (cw * 4) as usize]);
            }
        }
        full
    }
    /// For JS: [page_w, page_h, cols, rows, cell_w, cell_h, then per cell x, y, w, h, at_x, at_y].
    pub fn to_js(&self) -> Vec<u32> {
        let mut v = vec![self.page_w, self.page_h, self.cols, self.rows, self.cell_w, self.cell_h];
        for c in &self.cells {
            v.extend_from_slice(&[c.crop[0], c.crop[1], c.crop[2], c.crop[3], c.at[0], c.at[1]]);
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crops_dedupes_and_round_trips() {
        // 4x2 cells of 8x8; two identical dots, one two-dot cell, the rest empty.
        let (w, h) = (32u32, 16u32);
        let mut img = vec![0u8; (w * h * 4) as usize];
        let mut put = |x: u32, y: u32, v: u8| {
            let i = ((y * w + x) * 4) as usize;
            img[i..i + 4].copy_from_slice(&[v, v, v, 255]);
        };
        put(3, 3, 9);
        put(8 + 3, 3, 9);
        put(16 + 1, 2, 7);
        put(16 + 6, 5, 8);
        let l = plan(&img, w, h, Hint { cols: 4, rows: 2, ..Default::default() }).expect("layout");
        assert_eq!(l.cells.len(), 8);
        assert_eq!(l.cells[0].crop, [1, 1, 5, 5]);
        assert_eq!(l.cells[0].at, l.cells[1].at, "identical cells share their page spot");
        assert_eq!(l.cells[3].crop[2], 0, "empty cell");
        let page = l.extract(&img, w);
        assert_eq!(l.expand(&page, w, h), img);
    }
}
