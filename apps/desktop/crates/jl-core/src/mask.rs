//! Secret masking for plain log lines, using the rules `archive-compaction.ts` applies to headers
//! and bodies: bearer/basic credentials, cookies, API keys, passwords, tokens and URL userinfo.

use std::sync::LazyLock;

use regex::{Captures, Regex};

const MASK: &str = "****";
const MIN_PARTIAL_MASK_LEN: usize = 12;

/// `maskSecretValue`: keeps the first and last 4 characters of long values. Idempotent.
pub fn mask_secret_value(value: &str) -> String {
    if value.is_empty() || value.contains(MASK) {
        return value.to_owned();
    }
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < MIN_PARTIAL_MASK_LEN {
        return MASK.to_owned();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}{MASK}{tail}")
}

/// The compaction rules' sensitive names, minus `session`, which in app logs mostly names ids.
const NAME_FRAGMENTS: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "signature",
    "credential",
    "apikey",
    "api_key",
    "api-key",
    "authorization",
];
const EXACT_NAMES: &[&str] = &["auth", "pwd", "otp", "jwt", "pin", "ssn"];

fn is_sensitive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    EXACT_NAMES.contains(&lower.as_str())
        || NAME_FRAGMENTS
            .iter()
            .any(|fragment| lower.contains(fragment))
}

/// `a=1; b=2` keeps the cookie names and masks every value.
fn mask_cookie_header(value: &str) -> String {
    value
        .split(';')
        .map(|part| match part.split_once('=') {
            Some((name, secret)) => format!("{name}={}", mask_secret_value(secret.trim())),
            None => part.to_owned(),
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// `sid=abc; Path=/; HttpOnly` keeps the attributes and masks the value.
fn mask_set_cookie(value: &str) -> String {
    let (pair, attributes) = value
        .find(';')
        .map_or((value, ""), |index| value.split_at(index));
    match pair.split_once('=') {
        Some((name, secret)) => format!("{name}={}{attributes}", mask_secret_value(secret)),
        None => value.to_owned(),
    }
}

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid mask pattern")
}

static URL_USERINFO: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?i)\b([a-z][a-z0-9+.-]*://)([^\s/@:]+)(?::([^\s/@]*))?@"));
static AUTHORIZATION: LazyLock<Regex> = LazyLock::new(|| {
    regex(r#"(?i)\b((?:proxy-)?authorization)(\s*[:=]\s*)(?:([A-Za-z][\w-]*)\s+)?([^\s,;"']+)"#)
});
static SCHEME_CREDENTIAL: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?i)\b(bearer|basic)\s+([A-Za-z0-9._~+/=-]{8,})"));
static COOKIE_HEADER: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?i)\b(set-cookie|cookie)(\s*:\s*)([^\r\n]+)"));
static JSON_PAIR: LazyLock<Regex> =
    LazyLock::new(|| regex(r#"("([^"\\]*)"\s*:\s*")((?:[^"\\]|\\.)*)(")"#));
static KEY_VALUE: LazyLock<Regex> =
    LazyLock::new(|| regex(r#"\b([A-Za-z_][A-Za-z0-9_.-]*)(\s*[=:]\s*)("?)([^\s"'&;,]+)"#));
static JWT: LazyLock<Regex> =
    LazyLock::new(|| regex(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*"));

/// Masks secrets in one log line. Safe to run more than once.
pub fn mask_secrets(line: &str) -> String {
    let line = URL_USERINFO.replace_all(line, |c: &Captures| {
        let password = c
            .get(3)
            .map(|p| format!(":{}", mask_secret_value(p.as_str())))
            .unwrap_or_default();
        format!("{}{}{password}@", &c[1], mask_secret_value(&c[2]))
    });
    let line = AUTHORIZATION.replace_all(&line, |c: &Captures| {
        let scheme = c
            .get(3)
            .map(|s| format!("{} ", s.as_str()))
            .unwrap_or_default();
        format!("{}{}{scheme}{}", &c[1], &c[2], mask_secret_value(&c[4]))
    });
    let line = SCHEME_CREDENTIAL.replace_all(&line, |c: &Captures| {
        format!("{} {}", &c[1], mask_secret_value(&c[2]))
    });
    let line = COOKIE_HEADER.replace_all(&line, |c: &Captures| {
        let value = if c[1].eq_ignore_ascii_case("set-cookie") {
            mask_set_cookie(&c[3])
        } else {
            mask_cookie_header(&c[3])
        };
        format!("{}{}{value}", &c[1], &c[2])
    });
    let line = JSON_PAIR.replace_all(&line, |c: &Captures| {
        if is_sensitive_name(&c[2]) {
            format!("{}{}{}", &c[1], mask_secret_value(&c[3]), &c[4])
        } else {
            c[0].to_owned()
        }
    });
    let line = KEY_VALUE.replace_all(&line, |c: &Captures| {
        let name = &c[1];
        let value = &c[4];
        let handled = matches!(
            name.to_ascii_lowercase().as_str(),
            "authorization" | "proxy-authorization" | "cookie" | "set-cookie"
        );
        // After `:` the word may be prose ("token: expired"); only mask values that look generated.
        let looks_secret = c[2].contains('=') || value.chars().any(|ch| !ch.is_alphabetic());
        if handled || !is_sensitive_name(name) || !looks_secret {
            return c[0].to_owned();
        }
        format!("{name}{}{}{}", &c[2], &c[3], mask_secret_value(value))
    });
    let line = JWT.replace_all(&line, |c: &Captures| mask_secret_value(&c[0]));
    line.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_values_match_ts() {
        let cases: Vec<(String, String)> =
            serde_json::from_str(&crate::test_support::fixture("mask-secret-value.json")).unwrap();
        for (input, expected) in cases {
            assert_eq!(mask_secret_value(&input), expected, "{input:?}");
        }
    }

    #[test]
    fn masks_log_lines() {
        let cases = [
            (
                "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
                "Authorization: Bearer eyJh****.sig",
            ),
            (
                "sending bearer abcdefghijklmnopqrstuvwxyz",
                "sending bearer abcd****wxyz",
            ),
            (
                "Cookie: sid=0123456789abcdef; theme=dark",
                "Cookie: sid=0123****cdef; theme=****",
            ),
            (
                "Set-Cookie: sid=0123456789abcdef; Path=/; HttpOnly",
                "Set-Cookie: sid=0123****cdef; Path=/; HttpOnly",
            ),
            (
                r#"body {"email":"a@b.c","password":"hunter22"}"#,
                r#"body {"email":"a@b.c","password":"****"}"#,
            ),
            (
                "GET /cb?code=1&access_token=abcdef0123456789 200",
                "GET /cb?code=1&access_token=abcd****6789 200",
            ),
            ("x-api-key: sk_live_0123456789", "x-api-key: sk_l****6789"),
            ("password=hunter2 user=lan", "password=**** user=lan"),
            (
                "connecting to postgres://admin:s3cretpass@db:5432/app",
                "connecting to postgres://****:****@db:5432/app",
            ),
            (
                "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl",
                "jwt eyJh****dXJl",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(mask_secrets(input), expected, "{input}");
            assert_eq!(mask_secrets(expected), expected, "idempotent: {expected}");
        }
    }

    #[test]
    fn leaves_ordinary_lines_alone() {
        for line in [
            "Failed to refresh token: network error",
            "sessionId=jl_abc123 loaded 12 entries",
            "key=value pin count",
            "GET https://example.com/api/items?page=2 200 87ms",
        ] {
            assert_eq!(mask_secrets(line), line);
        }
    }
}
