use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Recorder {
    #[serde(rename = "browser-extension")]
    BrowserExtension { extension: ExtensionRecorderInfo },
    #[serde(rename = "e2e-runner")]
    E2eRunner {
        runner: RunnerInfo,
        #[serde(rename = "testRun", default, skip_serializing_if = "Option::is_none")]
        test_run: Option<TestRunRef>,
    },
    #[serde(rename = "desktop-recorder")]
    Desktop { recorder: DesktopRecorderInfo },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RecorderKind {
    BrowserExtension,
    E2eRunner,
    Desktop,
}

impl RecorderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BrowserExtension => "browser-extension",
            Self::E2eRunner => "e2e-runner",
            Self::Desktop => "desktop-recorder",
        }
    }
}

impl Recorder {
    pub fn kind(&self) -> RecorderKind {
        match self {
            Self::BrowserExtension { .. } => RecorderKind::BrowserExtension,
            Self::E2eRunner { .. } => RecorderKind::E2eRunner,
            Self::Desktop { .. } => RecorderKind::Desktop,
        }
    }
}

/// `defaultArchiveRecorderInfo`: what archives without a recorder were written by.
impl Default for Recorder {
    fn default() -> Self {
        Self::BrowserExtension {
            extension: ExtensionRecorderInfo {
                kind: "browser-extension".into(),
                name: "jittle-lamp".into(),
                version: "unknown".into(),
                extension_id: None,
                manifest_version: None,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRecorderInfo {
    pub kind: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_version: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunnerInfo {
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<NameVersion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<RunnerBrowser>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<super::Size>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NameVersion {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunnerBrowser {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headless: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_case_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_case_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopRecorderInfo {
    /// `jittle-lamp-desktop`.
    pub name: String,
    pub version: String,
    pub os: String,
    pub source: CaptureSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    #[serde(rename = "type")]
    pub kind: CaptureSourceKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureSourceKind {
    Display,
    Window,
    Application,
}
