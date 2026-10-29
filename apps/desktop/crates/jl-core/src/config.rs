//! `~/.jittle-lamp/companion.json`, shared with the Electron app (`companion/config.ts`).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::paths::{self, resolve};

pub const COMPANION_PORT: u16 = 48_115;
pub const COMPANION_ORIGIN: &str = "http://127.0.0.1:48115";
pub const DEFAULT_OUTPUT_DIR_NAME: &str = "jittle-lamp-sessions";
pub const OUTPUT_DIR_ENV: &str = "JITTLE_LAMP_OUTPUT_DIR";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionConfig {
    pub auto_sync_to_cloud: bool,
    pub output_dir: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigSource {
    Env,
    File,
    Default,
}

/// What `GET /config` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedConfig {
    pub config_file_path: PathBuf,
    pub auto_sync_to_cloud: bool,
    pub default_output_dir: PathBuf,
    pub env_override_active: bool,
    pub output_dir: PathBuf,
    pub saved_output_dir: Option<PathBuf>,
    pub source: ConfigSource,
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

pub fn config_dir() -> PathBuf {
    home_dir().join(".jittle-lamp")
}

pub fn config_file_path() -> PathBuf {
    config_dir().join("companion.json")
}

pub fn default_db_path() -> PathBuf {
    config_dir().join("sessions.db")
}

pub fn default_output_dir() -> PathBuf {
    resolve(home_dir().join(DEFAULT_OUTPUT_DIR_NAME))
}

pub fn is_trusted_origin(origin: Option<&str>) -> bool {
    origin.is_some_and(|origin| origin.starts_with("chrome-extension://"))
}

pub fn normalize_output_dir(input: &str) -> Result<PathBuf> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        bail!("The output directory cannot be empty.");
    }
    Ok(resolve(trimmed))
}

/// Loads the config the way the Electron app does: env override, then the file, then defaults.
pub fn load() -> ResolvedConfig {
    load_from(
        &config_file_path(),
        std::env::var(OUTPUT_DIR_ENV).ok().as_deref(),
    )
}

pub fn load_from(config_file: &Path, env_output_dir: Option<&str>) -> ResolvedConfig {
    let saved = read_saved(config_file);
    let default_output_dir = default_output_dir();
    let env_output_dir = env_output_dir.map(str::trim).filter(|dir| !dir.is_empty());

    if let Some(env_dir) = env_output_dir {
        return ResolvedConfig {
            config_file_path: config_file.to_path_buf(),
            auto_sync_to_cloud: saved.as_ref().is_none_or(|saved| saved.auto_sync_to_cloud),
            default_output_dir,
            env_override_active: true,
            output_dir: resolve(env_dir),
            saved_output_dir: saved.map(|saved| saved.output_dir),
            source: ConfigSource::Env,
        };
    }

    match saved {
        Some(saved) => ResolvedConfig {
            config_file_path: config_file.to_path_buf(),
            auto_sync_to_cloud: saved.auto_sync_to_cloud,
            default_output_dir,
            env_override_active: false,
            output_dir: saved.output_dir.clone(),
            saved_output_dir: Some(saved.output_dir),
            source: ConfigSource::File,
        },
        None => ResolvedConfig {
            config_file_path: config_file.to_path_buf(),
            auto_sync_to_cloud: true,
            output_dir: default_output_dir.clone(),
            default_output_dir,
            env_override_active: false,
            saved_output_dir: None,
            source: ConfigSource::Default,
        },
    }
}

pub fn save(output_dir: &str, auto_sync_to_cloud: Option<bool>) -> Result<CompanionConfig> {
    save_to(&config_file_path(), output_dir, auto_sync_to_cloud)
}

pub fn save_to(
    config_file: &Path,
    output_dir: &str,
    auto_sync_to_cloud: Option<bool>,
) -> Result<CompanionConfig> {
    let config = CompanionConfig {
        auto_sync_to_cloud: auto_sync_to_cloud.unwrap_or(true),
        output_dir: normalize_output_dir(output_dir)?,
    };
    if let Some(dir) = config_file.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("Creating {}", dir.display()))?;
    }
    let mut text = serde_json::to_string_pretty(&config)?;
    text.push('\n');
    std::fs::write(config_file, text)
        .with_context(|| format!("Writing {}", config_file.display()))?;
    Ok(config)
}

fn read_saved(config_file: &Path) -> Option<CompanionConfig> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Partial {
        auto_sync_to_cloud: Option<bool>,
        output_dir: Option<String>,
    }

    let text = std::fs::read_to_string(config_file).ok()?;
    let parsed: Partial = serde_json::from_str(&text).ok()?;
    let output_dir = match parsed.output_dir {
        Some(dir) => normalize_output_dir(&dir).ok()?,
        None => default_output_dir(),
    };
    Some(CompanionConfig {
        auto_sync_to_cloud: parsed.auto_sync_to_cloud.unwrap_or(true),
        output_dir,
    })
}

/// `resolveArtifactDestinationPath`.
pub fn artifact_destination(
    output_dir: &Path,
    session_id: &str,
    artifact_name: &str,
) -> Result<PathBuf> {
    if !paths::is_valid_session_id(session_id) {
        bail!("Invalid session id: {session_id}");
    }
    let root = resolve(output_dir);
    let candidate = resolve(root.join(session_id).join(artifact_name));
    if !paths::is_within(&root, &candidate) {
        bail!("Resolved artifact path escapes the configured output directory.");
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let config = load_from(&dir.path().join("companion.json"), None);
        assert_eq!(config.source, ConfigSource::Default);
        assert!(config.auto_sync_to_cloud);
        assert_eq!(config.output_dir, default_output_dir());
        assert_eq!(config.saved_output_dir, None);
    }

    #[test]
    fn save_then_load_and_env_override() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("nested/companion.json");
        let out = dir.path().join("out");
        save_to(&file, &format!("  {}/./x/..  ", out.display()), Some(false)).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            format!(
                "{{\n  \"autoSyncToCloud\": false,\n  \"outputDir\": \"{}\"\n}}\n",
                out.display()
            )
        );

        let config = load_from(&file, None);
        assert_eq!(config.source, ConfigSource::File);
        assert_eq!(config.output_dir, out);
        assert!(!config.auto_sync_to_cloud);

        let config = load_from(&file, Some("  /tmp/env-out "));
        assert_eq!(config.source, ConfigSource::Env);
        assert!(config.env_override_active);
        assert_eq!(config.output_dir, PathBuf::from("/tmp/env-out"));
        assert_eq!(config.saved_output_dir, Some(out));
        assert!(!config.auto_sync_to_cloud);

        let json = serde_json::to_value(&config).unwrap();
        assert_eq!(json["source"], "env");
        assert_eq!(json["envOverrideActive"], true);
    }

    #[test]
    fn broken_or_partial_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("companion.json");
        std::fs::write(&file, "{ nope").unwrap();
        assert_eq!(load_from(&file, None).source, ConfigSource::Default);
        std::fs::write(&file, r#"{"outputDir":"   "}"#).unwrap();
        assert_eq!(load_from(&file, None).source, ConfigSource::Default);
        std::fs::write(&file, r#"{"autoSyncToCloud":null}"#).unwrap();
        let config = load_from(&file, None);
        assert_eq!(config.source, ConfigSource::File);
        assert!(config.auto_sync_to_cloud);
        assert_eq!(config.output_dir, default_output_dir());
        assert!(save_to(&file, " ", None).is_err());
    }

    #[test]
    fn artifact_destination_checks() {
        let root = Path::new("/tmp/out");
        assert_eq!(
            artifact_destination(root, "jl_1", "recording.webm").unwrap(),
            PathBuf::from("/tmp/out/jl_1/recording.webm")
        );
        assert!(artifact_destination(root, "../x", "recording.webm").is_err());
        assert!(artifact_destination(root, "..", "recording.webm").is_err());
        assert!(artifact_destination(root, "a%2F", "recording.webm").is_err());
    }
}
