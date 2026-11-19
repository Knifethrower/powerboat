//! Case-insensitive fallback for paths under the game folder.
//!
//! Games are made on Windows and can ask for `Languages/` when the folder is `languages/`. NTFS and exFAT
//! answer anyway; a case-sensitive card or an ext4 copy says ENOENT and the game stays black (OMORI).
//!
//! File ops run on the exact path first and come here only when it is missing, so a path that exists costs
//! nothing extra, and on exFAT a wrong-case path never gets here at all. A miss walks the path one component
//! at a time against folder listings, kept until something writes there: repeated misses cost a hash lookup.
//!
//! Only paths below the game folder take part. Everything else (/proc, the data and cache folders) stays
//! exact, and no folder above the game gets listed.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// A folder's entries by lowercase name. On a case-sensitive disk several real names can share a key.
type Listing = HashMap<String, Vec<OsString>>;

struct CaseIndex {
    root: PathBuf,
    dirs: HashMap<PathBuf, Listing>,
}

fn fold(name: &OsStr) -> String {
    name.to_string_lossy().to_lowercase()
}

fn list(dir: &Path) -> Listing {
    let mut listing = Listing::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name();
        listing.entry(fold(&name)).or_default().push(name);
    }
    for names in listing.values_mut() {
        names.sort(); // read_dir's order is arbitrary: the same request must find the same file every run
    }
    listing
}

impl CaseIndex {
    fn new(root: &Path) -> CaseIndex {
        CaseIndex { root: root.to_path_buf(), dirs: HashMap::new() }
    }

    /// The real name in `dir` for `name`: the exact spelling if present, else the first that differs only by case.
    fn lookup(&mut self, dir: &Path, name: &OsStr) -> Option<OsString> {
        if !self.dirs.contains_key(dir) {
            self.dirs.insert(dir.to_path_buf(), list(dir));
        }
        let names = self.dirs[dir].get(&fold(name))?;
        Some(names.iter().find(|n| n.as_os_str() == name).unwrap_or(&names[0]).clone())
    }

    /// The real path as far as `path` exists, plus the components past that. None: not below the game folder.
    fn walk<'a>(&mut self, path: &'a Path) -> Option<(PathBuf, Vec<Component<'a>>)> {
        let mut parts = path.strip_prefix(&self.root).ok()?.components();
        let mut real = self.root.clone();
        while let Some(part) = parts.next() {
            match part {
                Component::CurDir => {}
                Component::ParentDir => {
                    if real == self.root {
                        return None;
                    }
                    real.pop();
                }
                Component::Normal(name) => match self.lookup(&real, name) {
                    Some(found) => real.push(found),
                    None => return Some((real, std::iter::once(part).chain(parts).collect())),
                },
                _ => return None,
            }
        }
        Some((real, Vec::new()))
    }

    /// The file or folder `path` names when case is ignored, if there is one.
    fn resolve(&mut self, path: &Path) -> Option<PathBuf> {
        self.walk(path).filter(|(_, rest)| rest.is_empty()).map(|(real, _)| real)
    }

    /// Where a write to `path` belongs: existing folders and files keep their real names, new parts stay as asked.
    fn resolve_write(&mut self, path: &Path) -> Option<PathBuf> {
        let (mut real, rest) = self.walk(path)?;
        real.extend(rest);
        Some(real)
    }

    /// Drops the listings a change at `path` can make stale: its own, those below it, those above it.
    fn forget(&mut self, path: &Path) {
        self.dirs.retain(|dir, _| !dir.starts_with(path) && !path.starts_with(dir));
    }
}

static INDEX: OnceLock<Mutex<CaseIndex>> = OnceLock::new();
static LOGGED: AtomicBool = AtomicBool::new(false);

/// Names the game folder. Until this runs (and for tools that never call it) every path stays exact.
pub fn init(root: &Path) {
    let _ = INDEX.set(Mutex::new(CaseIndex::new(root)));
}

fn with_index<R>(f: impl FnOnce(&mut CaseIndex) -> Option<R>) -> Option<R> {
    f(&mut *INDEX.get()?.lock().ok()?)
}

/// A real path that differs from the one asked for, as a string. Names that are not UTF-8 cannot come from JS.
fn differing(asked: &str, real: Option<PathBuf>) -> Option<String> {
    real.filter(|r| r != Path::new(asked)).and_then(|r| r.into_os_string().into_string().ok())
}

/// The real name of a path that was just found missing; None when no name differs from it only by case.
fn real_name(path: &str) -> Option<String> {
    let real = differing(path, with_index(|index| index.resolve(Path::new(path))));
    if let Some(r) = &real {
        // Once per run, with an example: it tells a port's author why the game runs on this card at all.
        if !LOGGED.swap(true, Ordering::Relaxed) {
            eprintln!("[powerboat] case-insensitive path fallback in use: {path} -> {r}");
        }
    }
    real
}

/// Runs a file op on `path`, and when that says not found, once more on the real name if it has one.
pub fn retry<T>(path: &str, op: impl Fn(&str) -> io::Result<T>) -> io::Result<T> {
    let first = op(path);
    if !matches!(&first, Err(e) if e.kind() == io::ErrorKind::NotFound) {
        return first;
    }
    match real_name(path) {
        Some(real) => op(&real),
        None => first,
    }
}

/// `path` if it exists, else its real name if it has one, else `path` unchanged. One stat when it exists, so this
/// is for rare ops that need the name itself rather than a retry (video open, remove, rename).
pub fn existing(path: String) -> String {
    if std::fs::symlink_metadata(&path).is_ok() {
        return path;
    }
    real_name(&path).unwrap_or(path)
}

/// The path a write should use, as a case-insensitive disk would pick it: `Save/x` goes into an existing `save/`,
/// and `save/X` replaces an existing `save/x` rather than landing next to it. Call `forget` after the write.
pub fn for_write(path: String) -> String {
    if std::fs::symlink_metadata(&path).is_ok() {
        return path;
    }
    differing(&path, with_index(|index| index.resolve_write(Path::new(&path)))).unwrap_or(path)
}

/// After a write, rename or remove at this real path: the next miss lists those folders again.
pub fn forget(path: &str) {
    with_index(|index| {
        index.forget(Path::new(path));
        Some(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::fs;
    use std::sync::atomic::AtomicU32;

    /// A new folder with the given files (parents made as needed), removed again when the test ends.
    struct Tree(PathBuf);
    impl Tree {
        fn new(files: &[&str]) -> Tree {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let root = std::env::temp_dir().join(format!("powerboat-casepath-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            for file in files {
                let path = root.join(file);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, file).unwrap();
            }
            fs::create_dir_all(&root).unwrap();
            Tree(root)
        }
        fn path(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }
        fn index(&self) -> CaseIndex {
            CaseIndex::new(&self.0)
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn every_component_resolves() {
        let t = Tree::new(&["languages/en/Foo.yaml"]);
        let mut index = t.index();
        assert_eq!(index.resolve(&t.path("Languages/EN/foo.YAML")), Some(t.path("languages/en/Foo.yaml")));
        assert_eq!(index.resolve(&t.path("LANGUAGES")), Some(t.path("languages")));
        assert_eq!(index.resolve(&t.path("./Languages/./en/../EN/Foo.yaml")), Some(t.path("languages/en/Foo.yaml")));
    }

    #[test]
    fn a_path_that_is_really_missing_stays_missing() {
        let t = Tree::new(&["languages/en/foo.yaml"]);
        let mut index = t.index();
        assert_eq!(index.resolve(&t.path("Languages/en/bar.yaml")), None);
        assert_eq!(index.resolve(&t.path("Languages/fr/foo.yaml")), None);
        assert_eq!(index.resolve(&t.path("languages/en/foo.yaml/inside")), None);
    }

    #[test]
    fn nothing_outside_the_game_folder_takes_part() {
        let t = Tree::new(&["www/img/a.png", "secret.txt"]);
        let mut index = CaseIndex::new(&t.path("www"));
        assert_eq!(index.resolve(&t.path("www/IMG/A.png")), Some(t.path("www/img/a.png")));
        assert_eq!(index.resolve(&t.path("SECRET.txt")), None);
        assert_eq!(index.resolve(&t.path("www/../SECRET.txt")), None);
        assert_eq!(index.resolve(Path::new("/PROC/meminfo")), None);
        assert_eq!(index.resolve_write(&t.path("SECRET.txt")), None);
        assert_eq!(index.dirs.keys().filter(|d| !d.starts_with(t.path("www"))).count(), 0, "listed a folder above the game");
    }

    /// Two names that differ only by case can both exist on a case-sensitive disk.
    #[test]
    fn the_exact_spelling_wins_and_the_choice_is_stable() {
        let t = Tree::new(&["img/a.png", "img/A.png"]);
        if fs::read_dir(t.path("img")).unwrap().count() != 2 {
            return; // this temp folder ignores case, so the two names are one file
        }
        let mut index = t.index();
        assert_eq!(index.lookup(&t.path("img"), OsStr::new("a.png")), Some("a.png".into()));
        assert_eq!(index.lookup(&t.path("img"), OsStr::new("A.png")), Some("A.png".into()));
        assert_eq!(index.lookup(&t.path("img"), OsStr::new("A.PNG")), Some("A.png".into()), "sorted first");
    }

    /// The listing is what makes misses cheap: it is not read again until `forget`.
    #[test]
    fn listings_stay_cached_until_forgotten() {
        let t = Tree::new(&["save/one.txt"]);
        let mut index = t.index();
        assert_eq!(index.resolve(&t.path("Save/ONE.txt")), Some(t.path("save/one.txt")));
        assert_eq!(index.dirs.len(), 2);

        fs::write(t.path("save/two.txt"), "new").unwrap();
        assert_eq!(index.resolve(&t.path("Save/TWO.txt")), None, "still the cached listing");
        index.forget(&t.path("save/two.txt"));
        assert_eq!(index.resolve(&t.path("Save/TWO.txt")), Some(t.path("save/two.txt")));

        // A removed folder takes the listings below it along.
        index.resolve(&t.path("Save/one.txt"));
        fs::remove_dir_all(t.path("save")).unwrap();
        index.forget(&t.path("save"));
        assert_eq!(index.resolve(&t.path("Save/one.txt")), None);
    }

    #[test]
    fn writes_use_existing_names_and_keep_new_ones() {
        let t = Tree::new(&["save/file1.rpgsave"]);
        let mut index = t.index();
        assert_eq!(index.resolve_write(&t.path("SAVE/FILE1.rpgsave")), Some(t.path("save/file1.rpgsave")), "replaces it");
        assert_eq!(index.resolve_write(&t.path("Save/Global.rpgsave")), Some(t.path("save/Global.rpgsave")), "new file, real folder");
        assert_eq!(index.resolve_write(&t.path("Save/New/Deep/x.txt")), Some(t.path("save/New/Deep/x.txt")), "new folders as asked");
        assert_eq!(index.resolve_write(&t.path("Other/x.txt")), Some(t.path("Other/x.txt")));
    }

    /// The public functions over the one process-wide index. Only this test may call `init`.
    #[test]
    fn file_ops_try_the_exact_path_first() {
        let t = Tree::new(&["languages/en.yaml", "save/one.txt"]);
        init(&t.0);
        let s = |rel: &str| t.path(rel).to_string_lossy().into_owned();
        let read = |p: &str| fs::read_to_string(p);

        // Hit: one op, and the index is not even consulted.
        let calls = Cell::new(0);
        let counted = |p: &str| {
            calls.set(calls.get() + 1);
            read(p)
        };
        assert_eq!(retry(&s("languages/en.yaml"), counted).unwrap(), "languages/en.yaml");
        assert_eq!(calls.get(), 1);
        assert!(INDEX.get().unwrap().lock().unwrap().dirs.is_empty(), "a hit must not list any folder");

        // Wrong case: a second op on the real name.
        calls.set(0);
        assert_eq!(retry(&s("Languages/EN.yaml"), counted).unwrap(), "languages/en.yaml");
        assert_eq!(calls.get(), 2);

        // Really missing, or outside the game: the first error stands.
        calls.set(0);
        assert_eq!(retry(&s("Languages/fr.yaml"), counted).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(calls.get(), 1);
        assert_eq!(retry("/PROC/meminfo", read).unwrap_err().kind(), io::ErrorKind::NotFound);

        // Errors other than not found do not walk anything.
        calls.set(0);
        let denied = |_: &str| -> io::Result<()> {
            calls.set(calls.get() + 1);
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        };
        assert_eq!(retry(&s("Languages/en.yaml"), denied).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(calls.get(), 1);

        assert_eq!(existing(s("Languages/EN.yaml")), s("languages/en.yaml"));
        assert_eq!(existing(s("languages/en.yaml")), s("languages/en.yaml"));
        assert_eq!(existing(s("Languages/fr.yaml")), s("Languages/fr.yaml"));
        assert_eq!(existing("/no/such/Path".to_string()), "/no/such/Path");

        // A write through the public path, then a wrong-case read of what it wrote.
        let target = for_write(s("Save/Two.txt"));
        assert_eq!(target, s("save/Two.txt"));
        assert!(retry(&s("SAVE/TWO.txt"), read).is_err(), "not written yet");
        fs::write(&target, "two").unwrap();
        forget(&target);
        assert_eq!(retry(&s("SAVE/TWO.txt"), read).unwrap(), "two");
    }
}
