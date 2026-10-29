//! Node's `path.resolve` semantics: absolute and lexically normalised, symlinks untouched.

use std::path::{Component, Path, PathBuf};

use anyhow::{Result, bail};

pub fn resolve(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `/^[A-Za-z0-9._-]+$/`, the session ids the companion accepts.
pub fn is_valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `candidate === root || candidate.startsWith(root + sep)`.
pub fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/// Strictly inside `root` (never `root` itself), as `deleteSession` requires.
pub fn is_strictly_within(root: &Path, candidate: &Path) -> bool {
    candidate != root && candidate.starts_with(root)
}

/// Resolves `<output_dir>/<session_id>` and rejects anything that escapes the output folder.
pub fn session_folder(output_dir: &Path, session_id: &str) -> Result<PathBuf> {
    let root = resolve(output_dir);
    let folder = resolve(root.join(session_id));
    if !is_within(&root, &folder) {
        bail!("Invalid sessionId: path traversal detected.");
    }
    Ok(folder)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_normalises_lexically() {
        assert_eq!(resolve("/a/b/../c/./d"), PathBuf::from("/a/c/d"));
        assert_eq!(resolve("/.."), PathBuf::from("/"));
    }

    #[test]
    fn session_folder_rejects_traversal() {
        let root = Path::new("/tmp/out");
        assert_eq!(
            session_folder(root, "jl_1").unwrap(),
            PathBuf::from("/tmp/out/jl_1")
        );
        assert!(session_folder(root, "../etc").is_err());
        assert!(session_folder(root, "/etc").is_err());
        assert!(session_folder(root, "a/../../x").is_err());
        assert!(!is_valid_session_id("a/b"));
        assert!(is_valid_session_id(".."));
        // `starts_with` compares whole components, unlike a string prefix.
        assert!(!is_within(Path::new("/tmp/out"), Path::new("/tmp/outside")));
    }
}
