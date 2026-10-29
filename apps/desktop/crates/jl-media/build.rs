//! Links libvpx.
//!
//! Lookup order for the directory holding `libvpx.a` (or `libvpx.dylib`):
//! 1. `JL_LIBVPX_DIR` (e.g. a static build made by `scripts/build-libvpx.sh` for macOS 15),
//! 2. `$(brew --prefix libvpx)/lib`,
//! 3. `/opt/homebrew/opt/libvpx/lib`, `/usr/local/opt/libvpx/lib`.
//!
//! The static archive is preferred so the app bundle needs no extra dylib. Set
//! `JL_LIBVPX_DYLIB=1` to force dynamic linking (the dylib must then be bundled into
//! `Contents/Frameworks` and its install name rewritten).

use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=JL_LIBVPX_DIR");
    println!("cargo:rerun-if-env-changed=JL_LIBVPX_DYLIB");

    let dir = libvpx_dir().unwrap_or_else(|| {
        panic!(
            "libvpx not found. Install it with `brew install libvpx` or set JL_LIBVPX_DIR to a \
             directory containing libvpx.a"
        )
    });
    println!("cargo:rerun-if-changed={}", dir.display());
    println!("cargo:rustc-link-search=native={}", dir.display());

    let force_dylib = std::env::var_os("JL_LIBVPX_DYLIB").is_some_and(|value| value != "0");
    if !force_dylib && dir.join("libvpx.a").exists() {
        println!("cargo:rustc-link-lib=static=vpx");
    } else {
        println!(
            "cargo:warning=linking libvpx dynamically from {}",
            dir.display()
        );
        println!("cargo:rustc-link-lib=dylib=vpx");
    }
}

fn libvpx_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("JL_LIBVPX_DIR") {
        return Some(PathBuf::from(dir));
    }
    let has_lib =
        |dir: &PathBuf| dir.join("libvpx.a").exists() || dir.join("libvpx.dylib").exists();
    if let Ok(output) = Command::new("brew").args(["--prefix", "libvpx"]).output()
        && output.status.success()
    {
        let dir = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()).join("lib");
        if has_lib(&dir) {
            return Some(dir);
        }
    }
    ["/opt/homebrew/opt/libvpx/lib", "/usr/local/opt/libvpx/lib"]
        .into_iter()
        .map(PathBuf::from)
        .find(has_lib)
}
