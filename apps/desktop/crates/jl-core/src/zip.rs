//! Session ZIP bundles: `session.archive.json` and the recording at the root, the layout the
//! Electron app, the web viewer and `upload_evidence_zip` exchange.

use std::fs::File;
use std::io::{self, Cursor, Read, Seek, Write};
use std::path::{Path, PathBuf};

use ::zip::write::SimpleFileOptions;
use ::zip::{CompressionMethod, ZipArchive, ZipWriter};
use anyhow::{Context, Result, bail};

use crate::archive::{ArtifactKind, parse_archive};
use crate::library::{LoadedSession, SessionSource, find_video};

/// Where imported bundles are unpacked: `$TMPDIR/jittle-lamp-temp/<tempId>/`.
pub fn temp_root() -> PathBuf {
    std::env::temp_dir().join("jittle-lamp-temp")
}

/// `buildSessionZip`, in memory.
pub fn build_session_zip(folder: &Path) -> Result<Vec<u8>> {
    let mut buffer = Cursor::new(Vec::new());
    write_zip(folder, &mut buffer)?;
    Ok(buffer.into_inner())
}

/// Streams the bundle to `dest` (via a temp file, so a failed export leaves nothing behind).
pub fn write_session_zip(folder: &Path, dest: &Path) -> Result<()> {
    let partial = dest.with_extension("zip.part");
    let result = File::create(&partial)
        .with_context(|| format!("Creating {}", partial.display()))
        .and_then(|mut file| write_zip(folder, &mut file))
        .and_then(|()| {
            std::fs::rename(&partial, dest).with_context(|| format!("Writing {}", dest.display()))
        });
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

fn write_zip<W: Write + Seek>(folder: &Path, writer: W) -> Result<()> {
    let archive_path = folder.join(crate::SESSION_ARCHIVE_FILE);
    let archive_bytes = std::fs::read(&archive_path)
        .with_context(|| format!("Reading {}", archive_path.display()))?;
    let Some((video_path, video_kind)) = find_video(folder) else {
        bail!("{} has no recording", folder.display());
    };
    let mut video =
        File::open(&video_path).with_context(|| format!("Reading {}", video_path.display()))?;
    let video_len = video.metadata()?.len();

    let mut zip = ZipWriter::new(writer);
    zip.start_file(
        crate::SESSION_ARCHIVE_FILE,
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
    )?;
    zip.write_all(&archive_bytes)?;
    // Video is already compressed; storing it keeps exports fast.
    let video_options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(video_len > u64::from(u32::MAX));
    zip.start_file(video_kind.file_name(), video_options)?;
    io::copy(&mut video, &mut zip)?;
    zip.finish()?;
    Ok(())
}

pub fn import_zip_file(path: &Path) -> Result<LoadedSession> {
    let file = File::open(path).with_context(|| format!("Opening {}", path.display()))?;
    import_zip_into(file, &temp_root())
}

pub fn import_zip_bytes(bytes: &[u8]) -> Result<LoadedSession> {
    import_zip_into(Cursor::new(bytes), &temp_root())
}

/// Unpacks a bundle into a fresh temp session folder under `root`. Entries are matched by file
/// name at any depth, like `ZipBytesDesktopSessionStrategy`.
pub fn import_zip_into<R: Read + Seek>(reader: R, root: &Path) -> Result<LoadedSession> {
    let mut zip = ZipArchive::new(reader).context("Not a ZIP file")?;
    let mut archive_index = None;
    let mut video: Option<(usize, ArtifactKind)> = None;
    for index in 0..zip.len() {
        let entry = zip.by_index_raw(index)?;
        if entry.is_dir() {
            continue;
        }
        match entry.name().rsplit('/').next() {
            Some(crate::SESSION_ARCHIVE_FILE) => archive_index = Some(index),
            Some(crate::RECORDING_WEBM_FILE) => video = Some((index, ArtifactKind::RecordingWebm)),
            Some(crate::RECORDING_MP4_FILE)
                if video.is_none_or(|(_, kind)| kind != ArtifactKind::RecordingWebm) =>
            {
                video = Some((index, ArtifactKind::RecordingMp4));
            }
            _ => {}
        }
    }
    let Some(archive_index) = archive_index else {
        bail!("ZIP is missing {}", crate::SESSION_ARCHIVE_FILE)
    };
    let Some((video_index, video_kind)) = video else {
        bail!("ZIP is missing {}", crate::RECORDING_WEBM_FILE)
    };

    let mut archive_bytes = Vec::new();
    zip.by_index(archive_index)?
        .read_to_end(&mut archive_bytes)?;
    let archive = parse_archive(&archive_bytes).context("Invalid session bundle")?;

    let temp_id = uuid::Uuid::new_v4().to_string();
    let folder = root.join(&temp_id);
    std::fs::create_dir_all(&folder).with_context(|| format!("Creating {}", folder.display()))?;
    let mut unpack = || -> Result<PathBuf> {
        std::fs::write(folder.join(crate::SESSION_ARCHIVE_FILE), &archive_bytes)?;
        let video_path = folder.join(video_kind.file_name());
        io::copy(
            &mut zip.by_index(video_index)?,
            &mut File::create(&video_path)?,
        )?;
        Ok(video_path)
    };
    let video_path = match unpack() {
        Ok(path) => path,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&folder);
            return Err(error.context("Unpacking session bundle"));
        }
    };

    Ok(LoadedSession {
        archive,
        folder,
        video_path,
        video_mime: video_kind.mime_type(),
        notes: String::new(),
        source: SessionSource::Zip { temp_id },
    })
}

pub fn remove_temp_session(temp_id: &str) -> Result<()> {
    if !crate::paths::is_valid_session_id(temp_id) || temp_id.starts_with('.') {
        bail!("Invalid temp session id: {temp_id}");
    }
    remove_dir_if_exists(&temp_root().join(temp_id))
}

/// Removes every unpacked bundle; call when the app quits.
pub fn clear_temp_sessions() -> Result<()> {
    remove_dir_if_exists(&temp_root())
}

fn remove_dir_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            Err(error).with_context(|| format!("Removing {}", path.display()))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{fixture, write_session};

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn export_then_import_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        write_session(
            dir.path(),
            "jl_zip_session",
            "extension-v5.json",
            Some("recording.mp4"),
        );
        let folder = dir.path().join("jl_zip_session");

        let dest = dir.path().join("bundle.zip");
        write_session_zip(&folder, &dest).unwrap();
        let mut zip = ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        let names: Vec<_> = zip.file_names().map(str::to_owned).collect();
        assert_eq!(names, ["session.archive.json", "recording.mp4"]);
        let mut archive_text = String::new();
        zip.by_name("session.archive.json")
            .unwrap()
            .read_to_string(&mut archive_text)
            .unwrap();
        assert_eq!(
            archive_text,
            std::fs::read_to_string(folder.join("session.archive.json")).unwrap()
        );

        let root = dir.path().join("temp");
        let loaded = import_zip_into(File::open(&dest).unwrap(), &root).unwrap();
        let SessionSource::Zip { temp_id } = &loaded.source else {
            panic!("zip source")
        };
        assert_eq!(loaded.folder, root.join(temp_id));
        assert_eq!(loaded.video_mime, "video/mp4");
        assert_eq!(
            std::fs::read(&loaded.video_path).unwrap(),
            [0x1a, 0x45, 0xdf, 0xa3]
        );
        assert_eq!(loaded.archive.session_id, "jl_zip_session");
        assert_eq!(
            build_session_zip(&folder).unwrap().len(),
            std::fs::metadata(&dest).unwrap().len() as usize
        );
    }

    #[test]
    fn imports_nested_entries_like_the_web_download() {
        let dir = tempfile::tempdir().unwrap();
        let archive = fixture("canonical-medium.json");
        let bytes = zip_of(&[
            ("evidence/session.archive.json", archive.as_bytes()),
            ("evidence/recording.webm", &[1, 2, 3]),
        ]);
        let loaded = import_zip_into(Cursor::new(bytes), dir.path()).unwrap();
        assert_eq!(loaded.video_mime, "video/webm");
        assert_eq!(
            std::fs::read(loaded.folder.join("session.archive.json")).unwrap(),
            archive.as_bytes()
        );
    }

    #[test]
    fn rejects_incomplete_or_invalid_bundles() {
        let dir = tempfile::tempdir().unwrap();
        let archive = fixture("canonical-medium.json");
        let cases: [(Vec<u8>, &str); 4] = [
            (
                zip_of(&[("recording.webm", &[1])]),
                "missing session.archive.json",
            ),
            (
                zip_of(&[("session.archive.json", archive.as_bytes())]),
                "missing recording.webm",
            ),
            (
                zip_of(&[
                    ("session.archive.json", b"{ broken json"),
                    ("recording.webm", &[1]),
                ]),
                "Invalid session bundle",
            ),
            (b"not a zip".to_vec(), "Not a ZIP"),
        ];
        for (bytes, message) in cases {
            let error = import_zip_into(Cursor::new(bytes), dir.path()).unwrap_err();
            assert!(format!("{error:#}").contains(message), "{error:#}");
        }
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "nothing unpacked"
        );
        assert!(remove_temp_session("../x").is_err());
    }
}
