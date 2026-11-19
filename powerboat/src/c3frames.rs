//! Construct 3's data.json without its animation frames, for frames built on first use (js/80_construct.js
//! patchLazyFrames).
//!
//! C3 turns every animation frame of every object type into objects at startup, and most frames are never used:
//! Moonstone Island has 83,218 frames (29 MB of its 39 MB data.json, ~100 MB of heap) and shows 217 of them at its
//! title screen. This pass rewrites the project text before JSON.parse: each animation's frames array
//! (project[3][type][7][animation][7]) becomes
//!
//! ```text
//! [-1, <file offset>, <byte length>, <frame count>, "<sheet url>", <sheet size>, ...]
//! ```
//!
//! with the animation's distinct image sheets (C3 registers those with its asset manager at startup) and nothing
//! else. The frames stay in the file; op_powerboat_read_range reads one animation's text when it is first needed.
//!
//! The scanner only skips values and never validates them: JSON.parse still sees everything it keeps, and a frame's
//! text reaches JSON.parse when it is read back. Anything of an unexpected shape makes the whole pass give up
//! (None), and the game loads its project the usual way.

/// The rewritten text and what was taken out of it.
pub struct Stripped {
    pub text: Vec<u8>,
    pub frames: u32,
    pub animations: u32,
}

struct Scan<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Scan<'a> {
    fn ws(&mut self) {
        while let Some(c) = self.b.get(self.i) {
            if !matches!(c, b' ' | b'\n' | b'\r' | b'\t') {
                break;
            }
            self.i += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.ws();
        self.b.get(self.i).copied()
    }

    fn expect(&mut self, c: u8) -> Option<()> {
        if self.peek()? == c {
            self.i += 1;
            Some(())
        } else {
            None
        }
    }

    /// At an opening quote: past the closing one.
    fn string(&mut self) -> Option<()> {
        self.i += 1;
        loop {
            match *self.b.get(self.i)? {
                b'"' => {
                    self.i += 1;
                    return Some(());
                }
                b'\\' => self.i += 2,
                _ => self.i += 1,
            }
        }
    }

    /// Any value: past its end.
    fn value(&mut self) -> Option<()> {
        match self.peek()? {
            b'"' => self.string(),
            b'[' | b'{' => {
                let mut depth = 0usize;
                loop {
                    match *self.b.get(self.i)? {
                        b'"' => {
                            self.string()?;
                            continue;
                        }
                        b'[' | b'{' => depth += 1,
                        b']' | b'}' => {
                            depth -= 1;
                            if depth == 0 {
                                self.i += 1;
                                return Some(());
                            }
                        }
                        _ => {}
                    }
                    self.i += 1;
                }
            }
            _ => {
                // Number, true, false or null.
                while let Some(c) = self.b.get(self.i) {
                    if matches!(c, b',' | b']' | b'}' | b' ' | b'\n' | b'\r' | b'\t') {
                        break;
                    }
                    self.i += 1;
                }
                Some(())
            }
        }
    }

    /// After an array element: true when another one follows, false past the closing bracket.
    fn more(&mut self) -> Option<bool> {
        match self.peek()? {
            b',' => {
                self.i += 1;
                Some(true)
            }
            b']' => {
                self.i += 1;
                Some(false)
            }
            _ => None,
        }
    }

    /// At an opening bracket: past it, and whether the array has an element.
    fn open(&mut self) -> Option<bool> {
        self.expect(b'[')?;
        if self.peek()? == b']' {
            self.i += 1;
            return Some(false);
        }
        Some(true)
    }

    /// Runs `at` on element `index` of the array here and skips the others; past the closing bracket afterwards.
    /// Fails when the array has no such element.
    fn element(&mut self, index: usize, at: &mut dyn FnMut(&mut Self) -> Option<()>) -> Option<()> {
        if !self.open()? {
            return None;
        }
        let mut n = 0;
        let mut seen = false;
        loop {
            if n == index {
                at(self)?;
                seen = true;
            } else {
                self.value()?;
            }
            n += 1;
            if !self.more()? {
                return seen.then_some(());
            }
        }
    }

    /// One animation's frames array: rewritten into `out` when it has frames.
    fn frames(&mut self, out: &mut Out<'a>) -> Option<()> {
        self.ws();
        let start = self.i;
        if !self.open()? {
            return Some(()); // An empty animation stays as it is.
        }
        let mut count = 0u32;
        let mut sheets: Vec<(&'a [u8], &'a [u8])> = Vec::new();
        loop {
            // One frame: [url, size, x, y, w, h, rotated, duration, originX, originY, image points, poly, tag]
            if !self.open()? || self.peek()? != b'"' {
                return None;
            }
            let u = self.i;
            self.string()?;
            let url = &self.b[u..self.i];
            if !self.more()? {
                return None;
            }
            self.ws();
            let s = self.i;
            if !self.peek()?.is_ascii_digit() {
                return None;
            }
            self.value()?;
            let size = &self.b[s..self.i];
            if !sheets.iter().any(|x| x.0 == url) {
                sheets.push((url, size));
            }
            let mut fields = 2;
            while self.more()? {
                self.value()?;
                fields += 1;
            }
            // Twelve or more fields: the array C3's ImageInfo.LoadData and AnimationFrameInfo read.
            if fields < 12 {
                return None;
            }
            count += 1;
            if !self.more()? {
                break;
            }
        }
        out.rewrite(start, self.i, count, &sheets);
        Some(())
    }
}

struct Out<'a> {
    b: &'a [u8],
    text: Vec<u8>,
    copied: usize,
    frames: u32,
    animations: u32,
}

impl Out<'_> {
    fn rewrite(&mut self, start: usize, end: usize, count: u32, sheets: &[(&[u8], &[u8])]) {
        self.text.extend_from_slice(&self.b[self.copied..start]);
        self.text.extend_from_slice(format!("[-1,{start},{},{count}", end - start).as_bytes());
        for (url, size) in sheets {
            self.text.push(b',');
            self.text.extend_from_slice(url);
            self.text.push(b',');
            self.text.extend_from_slice(size);
        }
        self.text.push(b']');
        self.copied = end;
        self.frames += count;
        self.animations += 1;
    }
}

/// The project's object types, element 3 of the project array.
fn types<'a>(s: &mut Scan<'a>, out: &mut Out<'a>) -> Option<()> {
    if !s.open()? {
        return None;
    }
    loop {
        // One object type; element 7 is its animations, or null.
        s.element(7, &mut |s| {
            if s.peek()? != b'[' {
                return s.value();
            }
            if !s.open()? {
                return Some(());
            }
            loop {
                s.element(7, &mut |s| s.frames(out))?;
                if !s.more()? {
                    return Some(());
                }
            }
        })?;
        if !s.more()? {
            return Some(());
        }
    }
}

pub fn strip(b: &[u8]) -> Option<Stripped> {
    let mut s = Scan { b, i: 0 };
    let mut out = Out { b, text: Vec::with_capacity(b.len() / 2), copied: 0, frames: 0, animations: 0 };
    s.expect(b'{')?;
    loop {
        if s.peek()? != b'"' {
            return None;
        }
        let k = s.i;
        s.string()?;
        let key = &b[k..s.i];
        s.expect(b':')?;
        if key == b"\"project\"" {
            s.element(3, &mut |s| types(s, &mut out))?;
        } else {
            s.value()?;
        }
        match s.peek()? {
            b',' => s.i += 1,
            b'}' => break,
            _ => return None,
        }
    }
    if out.animations == 0 {
        return None;
    }
    out.text.extend_from_slice(&b[out.copied..]);
    Some(Stripped { text: out.text, frames: out.frames, animations: out.animations })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME_A: &str = r#"["images/a.png",10,0,0,8,8,false,1,0.5,0.5,[],[0,0,1,1,1,0],""]"#;
    const FRAME_B: &str = r#"["images/b\"x.png",20,8,0,8,8,false,1,0.5,0.5,[["p",0,0]],[],"t]"]"#;

    fn project(frames: &str) -> String {
        let anim = format!(r#"["run",5,1,0,0,0,123,{frames}]"#);
        let sprite = format!(r#"["Sprite",1,2,3,4,5,null,[{anim},{anim}],8]"#);
        format!(r#"{{"project":["name",1,[],[["Text",1,2,3,4,5,null,null,8],{sprite}],"after"]}}"#)
    }

    #[test]
    fn frames_become_placeholders_that_point_back() {
        let frames = format!("[{FRAME_A},{FRAME_A},{FRAME_B}]");
        let text = project(&frames);
        let r = strip(text.as_bytes()).unwrap();
        assert_eq!((r.frames, r.animations), (6, 2));
        let out = String::from_utf8(r.text).unwrap();
        let off = text.find(&frames).unwrap();
        let want = format!(r#"[-1,{off},{},3,"images/a.png",10,"images/b\"x.png",20]"#, frames.len());
        assert!(out.contains(&want), "{out}");
        assert!(out.ends_with(r#"8]],"after"]}"#), "{out}");
        assert_eq!(&text[off..off + frames.len()], frames);
    }

    #[test]
    fn empty_animations_stay() {
        let text = project("[]");
        assert!(strip(text.as_bytes()).is_none());
    }

    #[test]
    fn other_shapes_give_up() {
        assert!(strip(br#"{"other":[1,2,3]}"#).is_none());
        assert!(strip(br#"{"project":["a"]}"#).is_none());
        assert!(strip(project(r#"[["images/a.png",10]]"#).as_bytes()).is_none());
        assert!(strip(project(r#"[[1,2,3,4,5,6,7,8,9,10,11,12,13]]"#).as_bytes()).is_none());
        assert!(strip(b"[").is_none());
    }
}
