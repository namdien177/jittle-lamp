//! Secret masking for free-text log lines. The value rule and sensitive names mirror
//! `packages/shared/src/archive-compaction.ts`; `jl-core::timeline::mask_secrets` can replace this
//! once it lands.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::{Captures, Regex};

const MASK: &str = "****";
// Shorter values are masked whole: keeping 4 + 4 characters would reveal most of them.
const MIN_PARTIAL_MASK_LEN: usize = 12;

/// Keeps the first and last 4 characters so two values can still be told apart.
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

const SENSITIVE_FRAGMENTS: &[&str] = &[
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
    "session",
    "cookie",
];
const SENSITIVE_EXACT: &[&str] = &["auth", "pwd", "otp", "jwt", "pin", "ssn"];

pub fn is_sensitive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SENSITIVE_EXACT.contains(&lower.as_str())
        || SENSITIVE_FRAGMENTS.iter().any(|f| lower.contains(f))
}

static URL_USERINFO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b([a-z][a-z0-9+.\-]*://)([^/\s:@]+)(?::([^/\s@]*))?@").unwrap()
});
static AUTH_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(bearer|basic|digest)\s+([A-Za-z0-9\-._~+/]+=*)").unwrap());
static COOKIE_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(set-cookie|cookie)(\s*[:=]\s*)([^\r\n]+)").unwrap());
static JSON_PAIR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"("([^"\\]*)"\s*:\s*")((?:[^"\\]|\\.)*)(")"#).unwrap());
static KEY_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b([A-Za-z0-9_.\-]*(?:token|secret|passw(?:or)?d|pwd|api[_\-]?key|signature|credential|authorization|session|auth|otp|jwt|pin|ssn)[A-Za-z0-9_.\-]*)(\s*[:=]\s*)(["']?)([^\s"'&,;)\]}]+)"#).unwrap()
});
static JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\beyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]*").unwrap()
});
static KNOWN_KEYS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:sk-[A-Za-z0-9_\-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{30,})").unwrap()
});

/// Masks credentials in a log line: `Bearer …` tokens, cookie headers, URL user info,
/// `password=…` / `"apiKey": "…"` pairs, JWTs and well-known key formats.
pub fn mask_secrets(line: &str) -> Cow<'_, str> {
    let mut out = Cow::Borrowed(line);
    replace(&mut out, &URL_USERINFO, |c| {
        let password = c
            .get(3)
            .map(|p| format!(":{}", mask_secret_value(p.as_str())))
            .unwrap_or_default();
        format!("{}{}{}@", &c[1], mask_secret_value(&c[2]), password)
    });
    replace(&mut out, &COOKIE_HEADER, |c| {
        let value = if c[1].eq_ignore_ascii_case("set-cookie") {
            mask_set_cookie(&c[3])
        } else {
            mask_cookie_pairs(&c[3])
        };
        format!("{}{}{}", &c[1], &c[2], value)
    });
    replace(&mut out, &AUTH_SCHEME, |c| {
        format!("{} {}", &c[1], mask_secret_value(&c[2]))
    });
    replace(&mut out, &JSON_PAIR, |c| {
        if is_sensitive_name(&c[2]) {
            format!("{}{}{}", &c[1], mask_secret_value(&c[3]), &c[4])
        } else {
            c[0].to_owned()
        }
    });
    replace(&mut out, &KEY_VALUE, |c| {
        let value = &c[4];
        // `Authorization: Bearer x` keeps its scheme; AUTH_SCHEME already masked the credential.
        let is_scheme = ["bearer", "basic", "digest"]
            .iter()
            .any(|s| value.eq_ignore_ascii_case(s));
        if is_scheme || value.contains(MASK) || !is_sensitive_name(&c[1]) {
            c[0].to_owned()
        } else {
            format!("{}{}{}{}", &c[1], &c[2], &c[3], mask_secret_value(value))
        }
    });
    replace(&mut out, &JWT, |c| mask_secret_value(&c[0]));
    replace(&mut out, &KNOWN_KEYS, |c| mask_secret_value(&c[0]));
    out
}

fn replace(text: &mut Cow<'_, str>, pattern: &Regex, f: impl Fn(&Captures) -> String) {
    if let Cow::Owned(next) = pattern.replace_all(text, |c: &Captures| f(c)) {
        *text = Cow::Owned(next);
    }
}

// `a=1; b=2` keeps the cookie names; every value is masked because any of them may be a session.
fn mask_cookie_pairs(value: &str) -> String {
    value
        .split(';')
        .map(|part| match part.find('=') {
            Some(i) => format!("{}={}", &part[..i], mask_secret_value(part[i + 1..].trim())),
            None => part.to_owned(),
        })
        .collect::<Vec<_>>()
        .join(";")
}

// `sid=abc; Path=/; HttpOnly` keeps the attributes; only the value is masked.
fn mask_set_cookie(value: &str) -> String {
    let (pair, attributes) = value.split_at(value.find(';').unwrap_or(value.len()));
    match pair.find('=') {
        Some(i) => format!(
            "{}={}{}",
            &pair[..i],
            mask_secret_value(&pair[i + 1..]),
            attributes
        ),
        None => value.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_rule_matches_shared_fixture() {
        // jl-core/tests/fixtures/mask-secret-value.json
        let cases = [
            ("", ""),
            ("short", "****"),
            ("exactly12chr", "exac****2chr"),
            ("eyJhbGciOiJIUzI1NiJ9.payload.sig", "eyJh****.sig"),
            ("ab****cd", "ab****cd"),
        ];
        for (input, expected) in cases {
            assert_eq!(mask_secret_value(input), expected, "{input}");
        }
    }

    #[test]
    fn masks_bearer_and_authorization() {
        let line = "GET /v1 Authorization: Bearer abcdef0123456789xyz";
        assert_eq!(
            mask_secrets(line),
            "GET /v1 Authorization: Bearer abcd****9xyz"
        );
        assert_eq!(
            mask_secrets("auth basic dXNlcjpwYXNzd29yZA=="),
            "auth basic dXNl****ZA=="
        );
    }

    #[test]
    fn masks_cookies() {
        assert_eq!(
            mask_secrets("Cookie: sid=0123456789abcdef; theme=dark"),
            "Cookie: sid=0123****cdef; theme=****"
        );
        assert_eq!(
            mask_secrets("set-cookie: sid=0123456789abcdef; Path=/; HttpOnly"),
            "set-cookie: sid=0123****cdef; Path=/; HttpOnly"
        );
    }

    #[test]
    fn masks_key_value_and_json_pairs() {
        assert_eq!(
            mask_secrets("login password=hunter2 user=bob"),
            "login password=**** user=bob"
        );
        assert_eq!(
            mask_secrets("api_key: 'AbCdEf0123456789'"),
            "api_key: 'AbCd****6789'"
        );
        assert_eq!(
            mask_secrets(r#"{"user":"bob","accessToken":"tok_0123456789abcdef"}"#),
            r#"{"user":"bob","accessToken":"tok_****cdef"}"#
        );
        assert_eq!(
            mask_secrets("https://x.test/cb?code=1&token=abcdef0123456789"),
            "https://x.test/cb?code=1&token=abcd****6789"
        );
    }

    #[test]
    fn masks_url_userinfo_jwts_and_known_keys() {
        assert_eq!(
            mask_secrets("connect postgres://admin:s3cretpass@db:5432"),
            "connect postgres://****:****@db:5432"
        );
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
        assert_eq!(
            mask_secrets(&format!("got {jwt} ok")),
            "got eyJh****dXJl ok"
        );
        assert_eq!(
            mask_secrets("key AKIAIOSFODNN7EXAMPLE used"),
            "key AKIA****MPLE used"
        );
        assert_eq!(
            mask_secrets("using sk-proj-abcdefghijklmnop1234"),
            "using sk-p****1234"
        );
    }

    #[test]
    fn leaves_ordinary_lines_alone() {
        let line = "Loaded 42 items in 13ms from cache (subsystem=com.example.app)";
        assert!(matches!(mask_secrets(line), Cow::Borrowed(_)));
        assert_eq!(mask_secrets("Session started"), "Session started");
    }
}
