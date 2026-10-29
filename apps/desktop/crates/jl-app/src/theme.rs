//! Design tokens. The palette is the web workspace's (`apps/evidence-web/src/index.css`): neutral
//! greys, hairline borders and brand green as the only accent, plus the system red for recording.

use std::time::Duration;

use gpui_kit::base::motion::Spring;
use gpui_kit::component::{ActiveTheme as _, Theme, ThemeMode};
use gpui_kit::*;

#[derive(Clone, Copy)]
pub struct Palette {
    pub dark: bool,
    /// Content pane behind everything that isn't the sidebar.
    pub bg: Hsla,
    /// Translucent sidebar material over the blurred window background.
    pub sidebar: Hsla,
    pub card: Hsla,
    pub elevated: Hsla,
    pub border: Hsla,
    pub border_strong: Hsla,
    pub fg: Hsla,
    pub fg_muted: Hsla,
    pub fg_subtle: Hsla,
    pub hover: Hsla,
    pub pressed: Hsla,
    pub selected: Hsla,
    pub primary: Hsla,
    pub primary_hover: Hsla,
    pub primary_pressed: Hsla,
    pub on_primary: Hsla,
    pub primary_soft: Hsla,
    pub record: Hsla,
    pub record_pressed: Hsla,
    pub record_soft: Hsla,
    pub warning: Hsla,
    pub warning_soft: Hsla,
    pub danger: Hsla,
    pub danger_soft: Hsla,
    pub info: Hsla,
    pub info_soft: Hsla,
    pub violet: Hsla,
    /// Video letterbox and dark media chrome, the same in both appearances.
    pub media: Hsla,
    pub scrim: Hsla,
    pub shadow: Hsla,
}

fn hex(c: u32) -> Hsla {
    rgb(c).into()
}

fn hexa(c: u32) -> Hsla {
    rgba(c).into()
}

pub fn dark() -> Palette {
    Palette {
    dark: true,
    bg: hex(0x0f1012),
    sidebar: hexa(0x0b0c0ec7),
    card: hex(0x141518),
    elevated: hex(0x1a1b1f),
    border: hex(0x24252a),
    border_strong: hex(0x303137),
    fg: hex(0xeeeff1),
    fg_muted: hex(0x8b8f98),
    fg_subtle: hex(0x5f636b),
    hover: hexa(0xffffff0d),
    pressed: hexa(0xffffff17),
    selected: hexa(0xffffff14),
    primary: hex(0x22c55e),
    primary_hover: hex(0x3fd273),
    primary_pressed: hex(0x1aa84f),
    on_primary: hex(0x04140a),
    primary_soft: hexa(0x22c55e1f),
    record: hex(0xff453a),
    record_pressed: hex(0xe0362c),
    record_soft: hexa(0xff453a24),
    warning: hex(0xeab308),
    warning_soft: hexa(0xeab3081f),
    danger: hex(0xf0505c),
    danger_soft: hexa(0xf0505c1f),
    info: hex(0x60a5fa),
    info_soft: hexa(0x60a5fa1f),
    violet: hex(0xa78bfa),
    media: hex(0x050506),
    scrim: hexa(0x00000099),
    shadow: hexa(0x00000080),
    }
}

pub fn light() -> Palette {
    Palette {
    dark: false,
    bg: hex(0xffffff),
    sidebar: hexa(0xf3f3f5bf),
    card: hex(0xffffff),
    elevated: hex(0xffffff),
    border: hex(0xe7e7ea),
    border_strong: hex(0xd6d6db),
    fg: hex(0x1c1d21),
    fg_muted: hex(0x6b6f78),
    fg_subtle: hex(0x9a9ca3),
    hover: hexa(0x0000000a),
    pressed: hexa(0x00000014),
    selected: hexa(0x00000010),
    primary: hex(0x178a42),
    primary_hover: hex(0x1a9a4a),
    primary_pressed: hex(0x137538),
    on_primary: hex(0xffffff),
    primary_soft: hexa(0x178a421a),
    record: hex(0xff3b30),
    record_pressed: hex(0xd92d23),
    record_soft: hexa(0xff3b301a),
    warning: hex(0xc27c0e),
    warning_soft: hexa(0xc27c0e1a),
    danger: hex(0xd92d3a),
    danger_soft: hexa(0xd92d3a14),
    info: hex(0x2563eb),
    info_soft: hexa(0x2563eb14),
    violet: hex(0x7c3aed),
    media: hex(0x0b0b0d),
    scrim: hexa(0x0000004d),
    shadow: hexa(0x0000002e),
    }
}

/// The palette for the current appearance.
pub fn palette(cx: &App) -> Palette {
    if cx.theme().mode.is_dark() { dark() } else { light() }
}

/// Type scale, in points. macOS body text is 13 pt; everything is a step on this scale.
pub mod text {
    pub const CAPTION: f32 = 11.;
    pub const SMALL: f32 = 12.;
    pub const BODY: f32 = 13.;
    pub const EMPHASIS: f32 = 15.;
    pub const TITLE: f32 = 20.;
    pub const DISPLAY: f32 = 28.;
}

/// Motion policy (Apple's damping/response pairs). Keyboard-driven changes never animate.
pub mod motion {
    use super::*;

    /// Default for anything spatial: critically damped, no overshoot.
    pub const MOVE: Spring = Spring::new(Duration::from_millis(320)).with_epsilon(0.25);
    /// Small controls (toggles, indicators).
    pub const CONTROL: Spring = Spring::new(Duration::from_millis(220)).with_epsilon(0.01);
}

/// Keeps GPUI Component's own widgets (inputs, scrollbars, switches, menus) on our palette. GPUI Kit
/// reloads its theme registry after start-up and follows the system appearance, which replaces
/// colors, so this runs again whenever the theme global changes.
pub fn apply(cx: &mut App) {
    if let Some(mode) = cx.try_global::<ForcedMode>().map(|f| f.0)
        && cx.theme().mode != mode {
            Theme::change(mode, None, cx);
        }
    let p = palette(cx);
    if cx.theme().colors.primary == p.primary && cx.theme().colors.background == p.bg {
        return;
    }
    Theme::update(cx, |t| {
        let c = &mut t.colors;
        c.background = p.bg;
        c.foreground = p.fg;
        c.border = p.border;
        c.input = p.border_strong;
        c.ring = p.primary;
        c.primary = p.primary;
        c.primary_hover = p.primary_hover;
        c.primary_active = p.primary_pressed;
        c.primary_foreground = p.on_primary;
        c.button_primary = p.primary;
        c.button_primary_hover = p.primary_hover;
        c.button_primary_active = p.primary_pressed;
        c.button_primary_foreground = p.on_primary;
        c.muted = p.hover;
        c.muted_foreground = p.fg_muted;
        c.accent = p.selected;
        c.accent_foreground = p.fg;
        c.popover = p.elevated;
        c.popover_foreground = p.fg;
        c.selection = p.primary_soft;
        c.caret = p.primary;
        c.switch = p.primary;
        c.slider_bar = p.primary;
        c.list_active = p.selected;
        c.list_hover = p.hover;
        c.list_active_border = p.border;
        c.sidebar = p.sidebar;
        c.scrollbar = gpui_kit::transparent_black();
        c.danger = p.danger;
        c.warning = p.warning;
        c.success = p.primary;
        c.info = p.info;
    });
}

/// Pins the appearance regardless of the system (`--light` / `--dark`, and the Settings choice).
pub struct ForcedMode(pub ThemeMode);

impl Global for ForcedMode {}

pub fn follow_system(window: &Window, cx: &mut App) {
    if cx.has_global::<ForcedMode>() {
        apply(cx);
        return;
    }
    let mode = match window.appearance() {
        WindowAppearance::Dark | WindowAppearance::VibrantDark => ThemeMode::Dark,
        _ => ThemeMode::Light,
    };
    if cx.theme().mode != mode {
        Theme::change(mode, None, cx);
    }
    apply(cx);
}

/// Duration-based motion for things that enter and leave (Emil's rules): strong ease-out, under
/// 300 ms, exits faster than entries. Springs stay for anything the pointer can redirect.
pub mod ease {
    use std::time::{Duration, Instant};

    /// `cubic-bezier(0.23, 1, 0.32, 1)`: starts fast, lands softly.
    pub fn out(t: f32) -> f32 {
        bezier(0.23, 1.0, 0.32, 1.0, t.clamp(0., 1.))
    }

    pub const ENTER: Duration = Duration::from_millis(220);
    pub const EXIT: Duration = Duration::from_millis(150);
    pub const POPOVER: Duration = Duration::from_millis(150);

    /// Eased progress since `start`, 0 → 1. `None` once finished (stop requesting frames).
    pub fn progress(start: Instant, length: Duration) -> (f32, bool) {
        let t = start.elapsed().as_secs_f32() / length.as_secs_f32();
        (out(t), t < 1.0)
    }

    fn bezier(x1: f32, y1: f32, x2: f32, y2: f32, x: f32) -> f32 {
        // Solve x(t) = x by Newton's method, then evaluate y(t).
        let (cx, bx) = (3. * x1, 3. * (x2 - x1) - 3. * x1);
        let ax = 1. - cx - bx;
        let (cy, by) = (3. * y1, 3. * (y2 - y1) - 3. * y1);
        let ay = 1. - cy - by;
        let sample_x = |t: f32| ((ax * t + bx) * t + cx) * t;
        let slope_x = |t: f32| (3. * ax * t + 2. * bx) * t + cx;
        let mut t = x;
        for _ in 0..8 {
            let d = slope_x(t);
            if d.abs() < 1e-6 {
                break;
            }
            t -= (sample_x(t) - x) / d;
        }
        let t = t.clamp(0., 1.);
        ((ay * t + by) * t + cy) * t
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn ease_out_is_fast_then_soft() {
            assert!((super::out(0.) - 0.).abs() < 1e-4);
            assert!((super::out(1.) - 1.).abs() < 1e-4);
            assert!(super::out(0.25) > 0.6, "most of the travel happens early");
        }
    }
}

#[cfg(test)]
mod no_gradients {
    /// The design uses flat surfaces only. Gradients crept in once; this keeps them out.
    #[test]
    fn sources_use_no_gradients() {
        fn walk(dir: &std::path::Path, hits: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, hits);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    let needle = ["linear", "_gradient("].concat();
                    if text.contains(&needle) {
                        hits.push(path.display().to_string());
                    }
                }
            }
        }
        let mut hits = Vec::new();
        walk(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut hits);
        assert!(hits.is_empty(), "gradients found in {hits:?}");
    }
}
