//! Embeds every SVG under `assets/icons` as `icons/jl/<name>.svg`.

use std::{env, fs, path::PathBuf};

fn main() {
    // ScreenCaptureKit's Swift shims link against the OS Swift runtime.
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    let dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("assets/icons");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".svg"))
        .collect();
    names.sort();
    let mut out = String::from("pub const ICONS: &[(&str, &[u8])] = &[\n");
    for name in names {
        out.push_str(&format!(
            "    (\"icons/jl/{name}\", include_bytes!(\"{}\")),\n",
            dir.join(&name).display()
        ));
    }
    out.push_str("];\n");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("icons.rs"), out).unwrap();
}
