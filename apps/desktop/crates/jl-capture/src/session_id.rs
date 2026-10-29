//! Session ids in the extension's format (`jl_<epoch ms in base 36>`), checked against the
//! companion's rule `^[A-Za-z0-9._-]+$`, 8–128 characters.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MIN_LEN: usize = 8;
pub const MAX_LEN: usize = 128;

pub fn is_valid_session_id(id: &str) -> bool {
    (MIN_LEN..=MAX_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `jl_` + milliseconds since the epoch in base 36, as `createSessionId` in `packages/shared`.
pub fn session_id_at(epoch_ms: u64) -> String {
    format!("jl_{}", to_base36(epoch_ms))
}

pub fn new_session_id() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    session_id_at(ms)
}

/// A fresh id whose folder does not exist yet under `output_dir`. Two recordings started in the
/// same millisecond get `-2`, `-3`, … suffixes.
pub fn unused_session_id(output_dir: &Path) -> String {
    let base = new_session_id();
    if !output_dir.join(&base).exists() {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|id| !output_dir.join(id).exists())
        .expect("unbounded range")
}

fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_extension_format() {
        // `(1761700000000).toString(36)` in JS.
        assert_eq!(session_id_at(1_761_700_000_000), "jl_mhbaozr4");
        assert!(is_valid_session_id(&new_session_id()));
    }

    #[test]
    fn validates_charset_and_length() {
        assert!(is_valid_session_id("jl_abc12345"));
        assert!(is_valid_session_id("a.b-c_d1"));
        assert!(!is_valid_session_id("short"));
        assert!(!is_valid_session_id("jl_abc/../x"));
        assert!(!is_valid_session_id("jl abc 1234"));
        assert!(!is_valid_session_id(&"a".repeat(129)));
        assert!(is_valid_session_id(&"a".repeat(128)));
    }

    #[test]
    fn unused_id_skips_existing_folders() {
        let dir = tempfile::tempdir().unwrap();
        let first = unused_session_id(dir.path());
        std::fs::create_dir(dir.path().join(&first)).unwrap();
        let second = unused_session_id(dir.path());
        assert_ne!(first, second);
        assert!(is_valid_session_id(&second));
    }
}
