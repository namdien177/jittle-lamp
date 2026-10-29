//! Parsing of shortcut strings such as `"alt+shift+r"` into macOS virtual key codes and
//! modifier flags. Pure Rust so it can be unit-tested off the main thread.

use std::fmt;

use anyhow::{Result, bail};

/// Modifier keys of a shortcut.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Modifiers {
    pub command: bool,
    pub control: bool,
    pub option: bool,
    pub shift: bool,
}

impl Modifiers {
    pub fn is_empty(self) -> bool {
        !(self.command || self.control || self.option || self.shift)
    }

    /// Carbon `EventModifiers` mask (`cmdKey`, `shiftKey`, `optionKey`, `controlKey`).
    pub fn carbon_mask(self) -> u32 {
        let mut mask = 0;
        if self.command {
            mask |= 1 << 8;
        }
        if self.shift {
            mask |= 1 << 9;
        }
        if self.option {
            mask |= 1 << 11;
        }
        if self.control {
            mask |= 1 << 12;
        }
        mask
    }

    /// Symbols in Apple's canonical order: ⌃⌥⇧⌘.
    pub fn symbols(self) -> String {
        let mut out = String::new();
        if self.control {
            out.push('⌃');
        }
        if self.option {
            out.push('⌥');
        }
        if self.shift {
            out.push('⇧');
        }
        if self.command {
            out.push('⌘');
        }
        out
    }
}

/// A parsed shortcut: a physical key (ANSI virtual key code) plus modifiers.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Shortcut {
    pub key_code: u32,
    pub modifiers: Modifiers,
    /// Canonical lowercase key name, e.g. `"r"`, `"f5"`, `"space"`.
    pub key: String,
}

impl Shortcut {
    /// Parses `"alt+shift+r"`, `"cmd+shift+m"`, `"⌥⇧R"`, `"ctrl+option+space"`, `"f5"`.
    ///
    /// Modifiers: `cmd|command|super|meta|⌘`, `ctrl|control|⌃`, `alt|opt|option|⌥`,
    /// `shift|⇧`. Separators are `+`, `-` or nothing (for symbol form). A shortcut without
    /// modifiers is only accepted for function keys, since a bare letter would swallow typing
    /// system-wide.
    pub fn parse(input: &str) -> Result<Shortcut> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            bail!("empty shortcut");
        }

        let mut modifiers = Modifiers::default();
        let mut rest = trimmed;
        // Leading modifier symbols: "⌥⇧R".
        loop {
            let mut chars = rest.chars();
            let Some(first) = chars.next() else { break };
            let flag = match first {
                '⌘' => &mut modifiers.command,
                '⌃' => &mut modifiers.control,
                '⌥' => &mut modifiers.option,
                '⇧' => &mut modifiers.shift,
                _ => break,
            };
            *flag = true;
            rest = chars.as_str();
        }

        let tokens: Vec<&str> = split_tokens(rest);
        let Some((key_token, modifier_tokens)) = tokens.split_last() else {
            bail!("shortcut {input:?} has no key");
        };
        for token in modifier_tokens {
            let flag = match token.to_ascii_lowercase().as_str() {
                "cmd" | "command" | "super" | "meta" => &mut modifiers.command,
                "ctrl" | "control" => &mut modifiers.control,
                "alt" | "opt" | "option" => &mut modifiers.option,
                "shift" => &mut modifiers.shift,
                other => bail!("unknown modifier {other:?} in shortcut {input:?}"),
            };
            if *flag {
                bail!("modifier {token:?} repeated in shortcut {input:?}");
            }
            *flag = true;
        }

        let key = key_token.to_ascii_lowercase();
        let Some(key_code) = key_code(&key) else {
            bail!("unknown key {key_token:?} in shortcut {input:?}");
        };
        let is_function_key =
            key.starts_with('f') && key.len() > 1 && key[1..].parse::<u8>().is_ok();
        if modifiers.is_empty() && !is_function_key {
            bail!("shortcut {input:?} needs at least one modifier");
        }
        Ok(Shortcut {
            key_code,
            modifiers,
            key: canonical_key(&key).to_string(),
        })
    }

    /// The string AppKit expects for `NSMenuItem.keyEquivalent` (lowercase; shift is carried by
    /// the modifier mask). `None` for keys that have no menu representation here.
    pub fn menu_key_equivalent(&self) -> Option<String> {
        let key = self.key.as_str();
        if key.chars().count() == 1 {
            return Some(key.to_string());
        }
        let ch = match key {
            "space" => ' ',
            "return" => '\r',
            "tab" => '\t',
            "escape" => '\u{1b}',
            "delete" => '\u{8}',
            "forwarddelete" => '\u{7f}',
            // NSUpArrowFunctionKey and friends.
            "up" => '\u{F700}',
            "down" => '\u{F701}',
            "left" => '\u{F702}',
            "right" => '\u{F703}',
            _ => {
                let n: u32 = key.strip_prefix('f')?.parse().ok()?;
                // NSF1FunctionKey = 0xF704.
                char::from_u32(0xF704 + n - 1)?
            }
        };
        Some(ch.to_string())
    }
}

impl fmt::Display for Shortcut {
    /// `⌥⇧R`, `⌘⇧M`, `⌃Space`, `F5`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let key = match self.key.as_str() {
            "space" => "Space".to_string(),
            "return" => "↩".to_string(),
            "tab" => "⇥".to_string(),
            "escape" => "⎋".to_string(),
            "delete" => "⌫".to_string(),
            "forwarddelete" => "⌦".to_string(),
            "up" => "↑".to_string(),
            "down" => "↓".to_string(),
            "left" => "←".to_string(),
            "right" => "→".to_string(),
            other => other.to_uppercase(),
        };
        write!(f, "{}{}", self.modifiers.symbols(), key)
    }
}

fn split_tokens(rest: &str) -> Vec<&str> {
    // "+" alone (or "cmd++") means the plus key; keep it as the key token.
    if rest == "+" {
        return vec!["+"];
    }
    if let Some(head) = rest.strip_suffix("++") {
        let mut tokens: Vec<&str> = head.split('+').filter(|t| !t.is_empty()).collect();
        tokens.push("+");
        return tokens;
    }
    let separator = if rest.contains('+') { '+' } else { '-' };
    if rest.len() > 1 && rest.contains(separator) {
        rest.split(separator)
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .collect()
    } else {
        vec![rest.trim()]
    }
}

fn canonical_key(key: &str) -> &str {
    match key {
        "enter" => "return",
        "esc" => "escape",
        "backspace" => "delete",
        "del" => "forwarddelete",
        "arrowup" => "up",
        "arrowdown" => "down",
        "arrowleft" => "left",
        "arrowright" => "right",
        "plus" => "=",
        other => other,
    }
}

/// ANSI virtual key codes from `HIToolbox/Events.h` (`kVK_*`).
fn key_code(key: &str) -> Option<u32> {
    let code = match canonical_key(key) {
        "a" => 0x00,
        "s" => 0x01,
        "d" => 0x02,
        "f" => 0x03,
        "h" => 0x04,
        "g" => 0x05,
        "z" => 0x06,
        "x" => 0x07,
        "c" => 0x08,
        "v" => 0x09,
        "b" => 0x0B,
        "q" => 0x0C,
        "w" => 0x0D,
        "e" => 0x0E,
        "r" => 0x0F,
        "y" => 0x10,
        "t" => 0x11,
        "1" => 0x12,
        "2" => 0x13,
        "3" => 0x14,
        "4" => 0x15,
        "6" => 0x16,
        "5" => 0x17,
        "=" | "+" => 0x18,
        "9" => 0x19,
        "7" => 0x1A,
        "-" => 0x1B,
        "8" => 0x1C,
        "0" => 0x1D,
        "]" => 0x1E,
        "o" => 0x1F,
        "u" => 0x20,
        "[" => 0x21,
        "i" => 0x22,
        "p" => 0x23,
        "return" => 0x24,
        "l" => 0x25,
        "j" => 0x26,
        "'" => 0x27,
        "k" => 0x28,
        ";" => 0x29,
        "\\" => 0x2A,
        "," => 0x2B,
        "/" => 0x2C,
        "n" => 0x2D,
        "m" => 0x2E,
        "." => 0x2F,
        "tab" => 0x30,
        "space" => 0x31,
        "`" => 0x32,
        "delete" => 0x33,
        "escape" => 0x35,
        "forwarddelete" => 0x75,
        "left" => 0x7B,
        "right" => 0x7C,
        "down" => 0x7D,
        "up" => 0x7E,
        "f1" => 0x7A,
        "f2" => 0x78,
        "f3" => 0x63,
        "f4" => 0x76,
        "f5" => 0x60,
        "f6" => 0x61,
        "f7" => 0x62,
        "f8" => 0x64,
        "f9" => 0x65,
        "f10" => 0x6D,
        "f11" => 0x67,
        "f12" => 0x6F,
        "f13" => 0x69,
        "f14" => 0x6B,
        "f15" => 0x71,
        "f16" => 0x6A,
        "f17" => 0x40,
        "f18" => 0x4F,
        "f19" => 0x50,
        "f20" => 0x5A,
        _ => return None,
    };
    Some(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_word_form() {
        let s = Shortcut::parse("alt+shift+r").unwrap();
        assert_eq!(s.key_code, 0x0F);
        assert_eq!(
            s.modifiers,
            Modifiers {
                option: true,
                shift: true,
                ..Default::default()
            }
        );
        assert_eq!(s.modifiers.carbon_mask(), 2048 | 512);
        assert_eq!(s.to_string(), "⌥⇧R");
        assert_eq!(s.menu_key_equivalent().as_deref(), Some("r"));
    }

    #[test]
    fn parses_aliases_case_and_order() {
        let a = Shortcut::parse("Shift+Cmd+M").unwrap();
        let b = Shortcut::parse("command + shift + m").unwrap();
        let c = Shortcut::parse("⌘⇧M").unwrap();
        let d = Shortcut::parse("super-shift-m").unwrap();
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_eq!(a, d);
        assert_eq!(a.to_string(), "⇧⌘M");
        assert_eq!(a.modifiers.carbon_mask(), 256 | 512);
    }

    #[test]
    fn parses_named_and_function_keys() {
        assert_eq!(Shortcut::parse("ctrl+option+space").unwrap().key_code, 0x31);
        assert_eq!(Shortcut::parse("cmd+enter").unwrap().key, "return");
        assert_eq!(Shortcut::parse("ctrl+esc").unwrap().to_string(), "⌃⎋");
        let f5 = Shortcut::parse("f5").unwrap();
        assert!(f5.modifiers.is_empty());
        assert_eq!(f5.key_code, 0x60);
        assert_eq!(f5.menu_key_equivalent().as_deref(), Some("\u{F708}"));
        assert_eq!(Shortcut::parse("cmd++").unwrap().key_code, 0x18);
        assert_eq!(Shortcut::parse("cmd+up").unwrap().to_string(), "⌘↑");
    }

    #[test]
    fn rejects_bad_input() {
        for bad in [
            "",
            "r",
            "alt+shift",
            "hyper+r",
            "alt+alt+r",
            "alt+shift+nope",
            "cmd+f99",
        ] {
            assert!(Shortcut::parse(bad).is_err(), "{bad:?} should fail");
        }
    }
}
