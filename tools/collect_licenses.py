#!/usr/bin/env python3
"""Writes the license files a powerboat release ships (PortMaster: one LICENSE.<component>.txt per
component in a flat licenses/ folder).

- LICENSE.powerboat-crates.txt: every Rust crate linked into the aarch64 binary (cargo metadata,
  normal dependencies only), each distinct license text once with the crates that use it.
- LICENSE.v8.txt, LICENSE.icu.txt, LICENSE.llvm-libcxx.txt, LICENSE.abseil-cpp.txt, ...: V8 and
  each library linked into rusty_v8's prebuilt archive (texts in tools/upstream-licenses/, fetched by
  tools/fetch_upstream_licenses.sh; the v8 crate ships none).
- LICENSE.libvpx.txt, LICENSE.opus.txt: libvpx and libopus, statically linked (build.rs), from the build
  image's Debian copyright files (docker/build.sh's powerboat-cross).
- LICENSE.openh264.txt: Cisco OpenH264, compiled from source by the openh264-sys2 crate.
- LICENSE.rust-std.txt: the Rust standard library, statically linked like every Rust binary.
- The fonts the runtime loads from fonts/ next to itself: fonts/licenses/LICENSE.*.txt, copied.

Dynamic only, the device's own, so not here: glibc, libgcc_s, libSDL2.

Run in WSL:  python3 tools/collect_licenses.py <out dir>
The license of powerboat's own code is not decided yet (see NOTES.md); this script does not
write one.
"""
import glob
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARGO = os.path.expanduser("~/.cache/powerboat/cargo")
LICENSE_GLOBS = ["LICENSE*", "LICENCE*", "COPYING*", "NOTICE*", "UNLICENSE*"]

# LICENSE.<name>.txt, its heading, and the upstream files it joins (tools/upstream-licenses/).
UPSTREAM = [
    ("v8", "V8 JavaScript engine (BSD-3-Clause, with its fdlibm and Strongtalk notices) and rusty_v8 (MIT).",
     ["rusty_v8.LICENSE", "v8.LICENSE", "v8.LICENSE.fdlibm", "v8.LICENSE.strongtalk"]),
    ("icu", "ICU, the International Components for Unicode (Unicode License v3 and the notices it includes).",
     ["icu.LICENSE"]),
    ("llvm-libcxx", "LLVM libc++, libc++abi and LLVM libc math (Apache-2.0 WITH LLVM-exception), as built into V8.",
     ["libcxx.LICENSE", "libcxxabi.LICENSE", "llvm-libc.LICENSE"]),
    ("abseil-cpp", "Abseil C++ (Apache-2.0).", ["abseil-cpp.LICENSE"]),
    ("simdutf", "simdutf (MIT; dual-licensed MIT or Apache-2.0).", ["simdutf.LICENSE"]),
    ("fast_float", "fast_float (MIT; triple-licensed MIT, Apache-2.0 or BSL-1.0).", ["fast_float.LICENSE-MIT"]),
    ("dragonbox", "Dragonbox (Boost Software License 1.0; dual-licensed with Apache-2.0 WITH LLVM-exception).",
     ["dragonbox.LICENSE-Boost"]),
    ("fp16", "FP16 (MIT).", ["fp16.LICENSE"]),
    ("inspector_protocol", "Chromium inspector_protocol / crdtp, used by V8's inspector (BSD-3-Clause).",
     ["inspector_protocol.LICENSE"]),
    ("utf8-decoder", "Bjoern Hoehrmann's UTF-8 DFA decoder, used by V8 (MIT).", ["utf8-decoder.LICENSE"]),
    ("partition_alloc", "PartitionAlloc, Chromium's allocator, linked by the pointer-compression V8 build (BSD-3-Clause, "
     "Chromium's LICENSE, which its sources point to).", ["chromium.LICENSE"]),
    ("siphash", "HalfSipHash by Jean-Philippe Aumasson, in V8's third_party/siphash (CC0 1.0).", ["siphash.LICENSE"]),
    ("rapidhash", "rapidhash by Nicolas De Carli, in V8's third_party/rapidhash-v8 (BSD-2-Clause).", ["rapidhash.LICENSE"]),
]
# Licenses inside a crate's package but not at its top (the crate script only looks at the top).
CRATE_INNER = {"openh264-sys2": ["upstream/LICENSE"]}
DEBIAN_COPYRIGHT = [("libvpx", "libvpx-dev"), ("opus", "libopus-dev")]
IMAGE = "powerboat-cross"


def cargo_metadata():
    env = dict(os.environ, CARGO_HOME=CARGO, RUSTUP_HOME=CARGO, PATH=CARGO + "/bin:" + os.environ["PATH"])
    out = subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--filter-platform", "aarch64-unknown-linux-gnu"],
        cwd=os.path.join(REPO, "powerboat"), env=env, check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def linked_packages(meta):
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = meta["resolve"]["root"]
    seen, stack = set(), [root]
    while stack:
        i = stack.pop()
        if i in seen:
            continue
        seen.add(i)
        for d in nodes[i]["deps"]:
            if any(k["kind"] is None for k in d["dep_kinds"]):
                stack.append(d["pkg"])
    pkgs = {p["id"]: p for p in meta["packages"]}
    return sorted((pkgs[i] for i in seen if i != root), key=lambda p: (p["name"], p["version"]))


# Crates whose package carries no license file: their repository's text (tools/upstream-licenses/).
CRATE_TEXTS = {
    "deno_core": ["deno_core.LICENSE"], "deno_ops": ["deno_core.LICENSE"], "serde_v8": ["deno_core.LICENSE"],
    "deno_error_macro": ["deno_error.LICENSE"], "deno_v8": ["deno.LICENSE"], "v8": ["rusty_v8.LICENSE"],
    "sdl2-sys": ["rust-sdl2.LICENSE", "sdl2.LICENSE"],
    "base64-simd": ["nugine-simd.LICENSE"], "vsimd": ["nugine-simd.LICENSE"],
}
MIT_TEMPLATE = """MIT License

Copyright (c) {who}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE."""
BSD2_TEMPLATE = """BSD 2-Clause License

Copyright (c) {who}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE."""


def license_texts(pkg):
    d = os.path.dirname(pkg["manifest_path"])
    files = sorted({f for g in LICENSE_GLOBS for f in glob.glob(os.path.join(d, g)) if os.path.isfile(f)})
    texts = [(os.path.basename(f), open(f, encoding="utf-8", errors="replace").read().strip()) for f in files]
    top = bool(texts)
    for rel in CRATE_INNER.get(pkg["name"], []):
        path = os.path.join(d, rel)
        if os.path.isfile(path):
            texts.append((rel, open(path, encoding="utf-8", errors="replace").read().strip()))
    # openh264 and openh264-sys2: the repository has no license file; its README says the wrapper code is
    # BSD-2-Clause, Ralf Biedert (the sys crate's upstream/LICENSE covers only Cisco's library).
    if not top and (pkg.get("license") or "").strip() == "BSD-2-Clause":
        texts.append(("BSD-2-Clause text, crate declares BSD-2-Clause without a file", BSD2_TEMPLATE.format(who=authors_of(pkg))))
    if texts:
        return texts
    up = os.path.join(REPO, "tools", "upstream-licenses")
    for fname in CRATE_TEXTS.get(pkg["name"], []):
        path = os.path.join(up, fname)
        if os.path.isfile(path) and os.path.getsize(path):
            texts.append(("upstream " + fname, open(path, encoding="utf-8", errors="replace").read().strip()))
    if not texts and (pkg.get("license") or "").strip() == "MIT":
        texts.append(("MIT text, crate declares MIT without a file", MIT_TEMPLATE.format(who=authors_of(pkg))))
    return texts


def authors_of(pkg):
    return ", ".join(a.split(" <")[0] for a in pkg.get("authors") or []) or "the {} authors ({})".format(
        pkg["name"], pkg.get("repository") or "crates.io")


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "licenses")
    os.makedirs(out, exist_ok=True)
    meta = cargo_metadata()
    pkgs = linked_packages(meta)
    by_text = {}
    missing = []
    for p in pkgs:
        texts = license_texts(p)
        if not texts:
            missing.append(p)
        for name, text in texts:
            by_text.setdefault(text, []).append(f"{p['name']} {p['version']} ({name})")
    lines = [
        "Third-party Rust crates statically linked into powerboat.",
        f"{len(pkgs)} crates; each distinct license text appears once, after the crates it covers.",
        "",
        "Crate list (name, version, license expression, source):",
    ]
    for p in pkgs:
        src = p.get("repository") or "https://crates.io/crates/" + p["name"]
        lines.append(f"  {p['name']} {p['version']}  [{p.get('license') or p.get('license_file') or 'unspecified'}]  {src}")
    if missing:
        lines += ["", "Crates without a license file in their package (license by expression above):"]
        lines += [f"  {p['name']} {p['version']}  [{p.get('license')}]" for p in missing]
    for text, users in sorted(by_text.items(), key=lambda kv: kv[1][0]):
        lines += ["", "=" * 78, "Used by: " + ", ".join(users), "=" * 78, "", text]
    with open(os.path.join(out, "LICENSE.powerboat-crates.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print(f"crates: {len(pkgs)}, distinct texts: {len(by_text)}, without file: {len(missing)}")

    # What rusty_v8's prebuilt librusty_v8.a links in: texts fetched by fetch_upstream_licenses.sh
    # (pinned to V8 15.0.245.2's DEPS), one LICENSE.<component>.txt each.
    up = os.path.join(REPO, "tools", "upstream-licenses")
    v8ver = next((p["version"] for p in pkgs if p["name"] == "v8"), "?")
    for name, title, files in UPSTREAM:
        parts = []
        for fname in files:
            path = os.path.join(up, fname)
            if not os.path.isfile(path) or os.path.getsize(path) == 0:
                sys.exit(f"missing {path}: run tools/fetch_upstream_licenses.sh")
            parts.append(open(path, encoding="utf-8", errors="replace").read().strip())
        head = f"{title}\nStatically linked into powerboat through rusty_v8 (crate v8 {v8ver}, V8 15.0.245.2).\n"
        sep = "\n\n" + "=" * 78 + "\n\n"
        with open(os.path.join(out, f"LICENSE.{name}.txt"), "w", encoding="utf-8", newline="\n") as f:
            f.write(head + "\n" + sep.join(parts) + "\n")
        print(f"{name}: {', '.join(files)}")

    # Static C libraries from the build image (build.rs links libvpx.a and libopus.a from it).
    for name, deb in DEBIAN_COPYRIGHT:
        r = subprocess.run(
            ["sg", "docker", "-c", f"docker run --rm {IMAGE} sh -c 'dpkg-query -W {deb}:arm64; cat /usr/share/doc/{deb}/copyright'"],
            capture_output=True, text=True)
        first, _, text = r.stdout.partition("\n")
        ver = first.split("\t")[-1].strip()
        if r.returncode != 0 or not text.strip():
            sys.exit(f"{name}: could not read /usr/share/doc/{deb}/copyright from the {IMAGE} image")
        head = f"{name}, statically linked into powerboat (Ubuntu 22.04 {deb}:arm64 {ver}). Debian copyright file:\n\n"
        with open(os.path.join(out, f"LICENSE.{name}.txt"), "w", encoding="utf-8", newline="\n") as f:
            f.write(head + text)
        print(f"{name}: Debian copyright file of {deb}:arm64 {ver}")

    h264 = next((p for p in pkgs if p["name"] == "openh264-sys2"), None)
    if h264:
        path = os.path.join(os.path.dirname(h264["manifest_path"]), "upstream", "LICENSE")
        with open(os.path.join(out, "LICENSE.openh264.txt"), "w", encoding="utf-8", newline="\n") as f:
            f.write(f"Cisco OpenH264 (BSD-2-Clause), compiled from source into powerboat by openh264-sys2 "
                    f"{h264['version']}.\n\n" + open(path, encoding="utf-8").read().strip() + "\n")
        print(f"openh264: {path}")

    # The Rust standard library (std, core, alloc and what they vendor, such as hashbrown, gimli, addr2line and
    # miniz_oxide) is linked statically. Texts from the toolchain's share/doc/rust/licenses.
    docs = sorted(glob.glob(os.path.join(CARGO, "toolchains", "*", "share", "doc", "rust", "licenses", "MIT.txt")))
    if not docs:
        sys.exit("no toolchain share/doc/rust/licenses/MIT.txt under " + CARGO)
    lic = os.path.dirname(docs[-1])
    parts = [open(os.path.join(lic, n), encoding="utf-8").read().strip() for n in ("MIT.txt", "Apache-2.0.txt")]
    with open(os.path.join(out, "LICENSE.rust-std.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("The Rust standard library (std, core, alloc and the crates they include), statically linked into "
                "powerboat.\nLicensed MIT OR Apache-2.0; copyright the Rust Project Developers and the authors "
                "listed in\nthe toolchain's share/doc/rust/COPYRIGHT-library.html.\n\n"
                + ("\n\n" + "=" * 78 + "\n\n").join(parts) + "\n")
    print(f"rust-std: {lic}")

    # Fonts the runtime loads from fonts/ next to itself (main.rs): each has its own file there.
    for path in sorted(glob.glob(os.path.join(REPO, "fonts", "licenses", "LICENSE.*.txt"))):
        with open(path, encoding="utf-8") as src, open(os.path.join(out, os.path.basename(path)), "w", encoding="utf-8", newline="\n") as dst:
            dst.write(src.read())
        print("font: " + os.path.basename(path))


if __name__ == "__main__":
    main()
