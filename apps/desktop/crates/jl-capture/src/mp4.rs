//! Reads the movie duration from a finalized MP4's `moov/mvhd` box. `SCRecordingOutput`'s
//! `recordedDuration` is rounded, and the archive's `videoDurationMs` should match the file.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub fn duration_ms(path: &Path) -> Option<f64> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let (start, end) = find_box(&mut file, 0, len, b"moov")?;
    let (start, _) = find_box(&mut file, start, end, b"mvhd")?;
    let mut header = [0u8; 32];
    file.seek(SeekFrom::Start(start)).ok()?;
    file.read_exact(&mut header).ok()?;
    parse_mvhd(&header)
}

/// `mvhd` payload: version, flags, then timescale and duration (32-bit in v0, 64-bit in v1).
fn parse_mvhd(payload: &[u8]) -> Option<f64> {
    let be32 = |at: usize| {
        payload
            .get(at..at + 4)
            .map(|b| u32::from_be_bytes(b.try_into().unwrap()) as u64)
    };
    let be64 = |at: usize| {
        payload
            .get(at..at + 8)
            .map(|b| u64::from_be_bytes(b.try_into().unwrap()))
    };
    let (timescale, duration) = match payload.first()? {
        0 => (be32(12)?, be32(16)?),
        1 => (be32(20)?, be64(24)?),
        _ => return None,
    };
    (timescale > 0).then(|| duration as f64 * 1000.0 / timescale as f64)
}

/// Payload range of the first `kind` box between `start` and `end`.
fn find_box(file: &mut std::fs::File, mut at: u64, end: u64, kind: &[u8; 4]) -> Option<(u64, u64)> {
    while at + 8 <= end {
        let mut header = [0u8; 16];
        file.seek(SeekFrom::Start(at)).ok()?;
        file.read_exact(&mut header[..8]).ok()?;
        let mut size = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
        let mut header_len = 8;
        if size == 1 {
            file.read_exact(&mut header[8..16]).ok()?;
            size = u64::from_be_bytes(header[8..16].try_into().unwrap());
            header_len = 16;
        } else if size == 0 {
            size = end - at;
        }
        if size < header_len {
            return None;
        }
        if &header[4..8] == kind {
            return Some((at + header_len, at + size));
        }
        at += size;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn reads_v0_and_v1_movie_headers() {
        let mut v0 = vec![0u8; 100];
        v0[12..16].copy_from_slice(&600u32.to_be_bytes());
        v0[16..20].copy_from_slice(&3014u32.to_be_bytes());
        let mut v1 = vec![0u8; 112];
        v1[0] = 1;
        v1[20..24].copy_from_slice(&1000u32.to_be_bytes());
        v1[24..32].copy_from_slice(&5023u64.to_be_bytes());
        for (payload, expected) in [(v0, 3014.0 * 1000.0 / 600.0), (v1, 5023.0)] {
            let mut file = tempfile::NamedTempFile::new().unwrap();
            file.write_all(&mp4_box(b"ftyp", b"isom\0\0\0\0")).unwrap();
            file.write_all(&mp4_box(b"mdat", &[0u8; 64])).unwrap();
            let moov = mp4_box(b"moov", &mp4_box(b"mvhd", &payload));
            file.write_all(&moov).unwrap();
            assert_eq!(duration_ms(file.path()), Some(expected));
        }
    }

    #[test]
    fn rejects_files_without_a_movie_header() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&mp4_box(b"ftyp", b"isom")).unwrap();
        assert_eq!(duration_ms(file.path()), None);
    }
}
