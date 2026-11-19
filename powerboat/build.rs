//! Links libvpx statically (WebM video, src/vpx.rs): the devices need no libvpx of their own.
//! The Docker image has libvpx-dev:arm64 (jammy, 1.11); host builds use the host's libvpx-dev.
//! POWERBOAT_VPX_LIB_DIR overrides where libvpx.a is looked for. src/enc_shim.c (VP9 + Opus encoders for
//! --transcode-videos) compiles against the same libraries' headers.
fn main() {
    let mut shim = cc::Build::new();
    // Cross builds use a sysroot without the image's headers: POWERBOAT_ENC_INCLUDE holds vpx/ and opus/.
    if let Ok(dir) = std::env::var("POWERBOAT_ENC_INCLUDE") {
        shim.include(dir);
    }
    shim.file("src/enc_shim.c").warnings(false).compile("powerboat_enc_shim");
    println!("cargo:rerun-if-env-changed=POWERBOAT_ENC_INCLUDE");
    println!("cargo:rerun-if-changed=src/enc_shim.c");
    let target = std::env::var("TARGET").unwrap_or_default();
    match std::env::var("POWERBOAT_VPX_LIB_DIR") {
        Ok(dir) => println!("cargo:rustc-link-search=native={dir}"),
        Err(_) if target == "aarch64-unknown-linux-gnu" => println!("cargo:rustc-link-search=native=/usr/lib/aarch64-linux-gnu"),
        Err(_) if target == "x86_64-unknown-linux-gnu" => println!("cargo:rustc-link-search=native=/usr/lib/x86_64-linux-gnu"),
        Err(_) => {}
    }
    println!("cargo:rustc-link-lib=static=vpx");
    println!("cargo:rustc-link-lib=static=opus");
    println!("cargo:rerun-if-env-changed=POWERBOAT_VPX_LIB_DIR");
    println!("cargo:rerun-if-changed=build.rs");
}
