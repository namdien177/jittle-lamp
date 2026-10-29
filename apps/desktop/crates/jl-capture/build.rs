// screencapturekit links a Swift bridge whose runtime (`libswift_Concurrency.dylib`) lives in
// /usr/lib/swift. Its build script's rpath only reaches its own targets, so this crate's examples
// and tests add it here. Binaries that depend on jl-capture (jl-app) need the same link arg.
fn main() {
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
