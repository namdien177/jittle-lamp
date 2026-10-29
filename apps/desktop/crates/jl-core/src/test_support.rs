use std::path::Path;

use crate::archive::parse_archive;

/// A fixture from `tests/fixtures`, written by the TS session code (`tests/fixtures/generate.ts`).
pub fn fixture(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Writes `<out>/<id>/` with the fixture archive (session id rewritten) and an optional recording.
pub fn write_session(out: &Path, id: &str, fixture_name: &str, video: Option<&str>) {
    let folder = out.join(id);
    std::fs::create_dir_all(&folder).unwrap();
    let mut archive = parse_archive(fixture(fixture_name).as_bytes()).unwrap();
    archive.session_id = id.to_owned();
    std::fs::write(
        folder.join(crate::SESSION_ARCHIVE_FILE),
        crate::to_pretty_json(&archive),
    )
    .unwrap();
    if let Some(video) = video {
        std::fs::write(folder.join(video), [0x1a, 0x45, 0xdf, 0xa3]).unwrap();
    }
}
