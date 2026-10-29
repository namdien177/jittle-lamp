// Backend and web origins. Mirrors apps/desktop/src/api-origin.ts: fixed at build time from
// JITTLE_LAMP_API_ORIGIN / JITTLE_LAMP_WEB_ORIGIN, with a runtime environment override for local
// testing, and trailing slashes trimmed.

pub const DEFAULT_API_ORIGIN: &str = "http://127.0.0.1:3001";
pub const DEFAULT_WEB_ORIGIN: &str = "http://127.0.0.1:4173";

const BUILD_API_ORIGIN: Option<&str> = option_env!("JITTLE_LAMP_API_ORIGIN");
const BUILD_WEB_ORIGIN: Option<&str> = option_env!("JITTLE_LAMP_WEB_ORIGIN");

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiConfig {
    pub api_origin: String,
    pub web_origin: String,
}

impl ApiConfig {
    pub fn new(api_origin: &str, web_origin: &str) -> Self {
        Self {
            api_origin: normalize_origin(api_origin),
            web_origin: normalize_origin(web_origin),
        }
    }

    /// Runtime environment first, then the values baked in at build time, then the local defaults.
    pub fn from_env() -> Self {
        let api = std::env::var("JITTLE_LAMP_API_ORIGIN").ok();
        let web = std::env::var("JITTLE_LAMP_WEB_ORIGIN").ok();
        Self::new(
            pick_origin(&[api.as_deref(), BUILD_API_ORIGIN], DEFAULT_API_ORIGIN),
            pick_origin(&[web.as_deref(), BUILD_WEB_ORIGIN], DEFAULT_WEB_ORIGIN),
        )
    }

    /// `path` must start with `/`; query strings are passed through untouched.
    pub fn api_url(&self, path: &str) -> String {
        format!("{}{}", self.api_origin, path)
    }

    /// The web viewer link for a share slug (as built by cloud-page.tsx and library-page.tsx).
    pub fn share_url(&self, slug: &str) -> String {
        format!(
            "{}/share/{}",
            self.web_origin,
            crate::http::encode_component(slug)
        )
    }
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self::from_env()
    }
}

fn pick_origin<'a>(candidates: &[Option<&'a str>], fallback: &'a str) -> &'a str {
    candidates
        .iter()
        .flatten()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .unwrap_or(fallback)
}

fn normalize_origin(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_whitespace_and_trailing_slashes() {
        let config = ApiConfig::new(" https://api.example.com/// ", "https://app.example.com/");
        assert_eq!(config.api_origin, "https://api.example.com");
        assert_eq!(config.web_origin, "https://app.example.com");
        assert_eq!(config.api_url("/orgs"), "https://api.example.com/orgs");
    }

    #[test]
    fn empty_candidates_fall_back() {
        assert_eq!(
            pick_origin(&[Some("  "), None], DEFAULT_API_ORIGIN),
            DEFAULT_API_ORIGIN
        );
        assert_eq!(
            pick_origin(&[None, Some("http://x:1")], DEFAULT_API_ORIGIN),
            "http://x:1"
        );
        assert_eq!(
            pick_origin(&[Some("http://a"), Some("http://b")], DEFAULT_API_ORIGIN),
            "http://a"
        );
    }

    #[test]
    fn share_url_encodes_slug() {
        let config = ApiConfig::new("http://api", "https://app.example.com/");
        assert_eq!(
            config.share_url("ab c/d"),
            "https://app.example.com/share/ab%20c%2Fd"
        );
    }
}
