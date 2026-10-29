//! Compiles `swift/main.swift` into `$OUT_DIR/jl-intelligence-helper` and exposes its path as
//! `JL_INTELLIGENCE_HELPER`.
//!
//! The helper targets macOS 15 and weak-links FoundationModels, so it runs there and reports
//! Apple Intelligence as unavailable. With an SDK older than macOS 26 it is built without
//! FoundationModels and always reports unavailable. `JL_INTELLIGENCE_SKIP_HELPER=1` skips the
//! build (the crate then always uses the heuristic).
//!
//! A copy goes to `target/<profile>/jl-intelligence-helper`, beside the app binary.

use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = "swift/main.swift";
const HELPER: &str = "jl-intelligence-helper";

fn main() {
    println!("cargo:rerun-if-changed={SOURCE}");
    println!("cargo:rerun-if-env-changed=JL_INTELLIGENCE_SKIP_HELPER");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");

    let skip = std::env::var_os("JL_INTELLIGENCE_SKIP_HELPER").is_some_and(|value| value != "0");
    let macos = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos");
    if skip || !macos {
        println!("cargo:rustc-env=JL_INTELLIGENCE_HELPER=");
        return;
    }

    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let output = out_dir.join(HELPER);
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x86_64",
        _ => "arm64",
    };
    let sdk = sdk_path();

    let mut swiftc = Command::new("xcrun");
    swiftc
        .args(["--sdk", "macosx", "swiftc", "-O", "-target"])
        .arg(format!("{arch}-apple-macos15.0"))
        .arg("-module-cache-path")
        .arg(out_dir.join("swift-module-cache"))
        // The deployment target is in `-target`; an inherited one would override it.
        .env_remove("MACOSX_DEPLOYMENT_TARGET");
    if sdk.as_deref().is_some_and(has_foundation_models) {
        swiftc.args([
            "-Xlinker",
            "-weak_framework",
            "-Xlinker",
            "FoundationModels",
        ]);
    } else {
        println!(
            "cargo:warning=the macOS SDK has no FoundationModels; the helper will report Apple \
             Intelligence as unavailable"
        );
    }
    swiftc.arg(SOURCE).arg("-o").arg(&output);

    let status = swiftc
        .status()
        .unwrap_or_else(|error| panic!("failed to run `xcrun swiftc`: {error}"));
    assert!(
        status.success(),
        "swiftc failed to build {SOURCE} ({status}); install the Xcode command line tools or set \
         JL_INTELLIGENCE_SKIP_HELPER=1"
    );
    println!(
        "cargo:rustc-env=JL_INTELLIGENCE_HELPER={}",
        output.display()
    );

    // Also place it next to the binaries (`target/<profile>/`), where `helper_path` finds it
    // during `cargo run` and `scripts/bundle.sh` copies it from.
    if let Some(profile_dir) = profile_dir(&out_dir) {
        let _ = std::fs::copy(&output, profile_dir.join(HELPER));
    }
}

/// `target/<profile>` from `target/<profile>/build/<package>-<hash>/out`.
fn profile_dir(out_dir: &Path) -> Option<PathBuf> {
    let build = out_dir.parent()?.parent()?;
    (build.file_name()? == "build").then(|| build.parent().map(Path::to_path_buf))?
}

fn sdk_path() -> Option<PathBuf> {
    let output = Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-path"])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
}

fn has_foundation_models(sdk: &Path) -> bool {
    sdk.join("System/Library/Frameworks/FoundationModels.framework")
        .exists()
}
