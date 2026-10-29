//! Prints a title and description for a session archive.
//!
//!   cargo run -p jl-intelligence --example suggest -- <session.archive.json> [frame.png] [--input] [--heuristic]
//!
//! `--input` also prints what the model is given; `--heuristic` skips Apple Intelligence.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

fn main() -> Result<()> {
    let mut paths = Vec::new();
    let (mut show_input, mut heuristic) = (false, false);
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--input" => show_input = true,
            "--heuristic" => heuristic = true,
            _ => paths.push(PathBuf::from(arg)),
        }
    }
    let archive_path = paths
        .first()
        .context("usage: suggest <session.archive.json> [frame.png] [--input] [--heuristic]")?;
    let frame = paths.get(1);

    let bytes = std::fs::read(archive_path)
        .with_context(|| format!("reading {}", archive_path.display()))?;
    let archive = jl_core::parse_archive(&bytes)?;
    let input = jl_intelligence::input_from_archive(&archive);
    if show_input {
        println!("{}", serde_json::to_string_pretty(&input)?);
    }

    let started = Instant::now();
    let suggestion = if heuristic {
        jl_intelligence::heuristic_suggestion(&input)
    } else {
        println!("availability: {:?}", jl_intelligence::availability());
        jl_intelligence::suggest(&input, frame.map(PathBuf::as_path), Duration::from_secs(20))?
    };
    println!("source:      {:?}", suggestion.source);
    if let Some(reason) = &suggestion.fallback_reason {
        println!("fallback:    {reason}");
    }
    println!("title:       {}", suggestion.title);
    println!("description: {}", suggestion.description);
    println!("elapsed:     {} ms", started.elapsed().as_millis());
    Ok(())
}
