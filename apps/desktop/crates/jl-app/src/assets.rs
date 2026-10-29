//! App icons (Lucide, ISC licence, see assets/LICENSE-LUCIDE) layered over the GPUI Kit defaults.

use std::borrow::Cow;

use gpui_kit::{AssetSource, Result, SharedString};

include!(concat!(env!("OUT_DIR"), "/icons.rs"));

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some((_, data)) = ICONS.iter().find(|(p, _)| *p == path) {
            return Ok(Some(Cow::Borrowed(data)));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut out = gpui_kit::assets::Assets.list(path)?;
        out.extend(ICONS.iter().filter(|(p, _)| p.starts_with(path)).map(|(p, _)| SharedString::from(*p)));
        Ok(out)
    }
}

/// Path of a bundled icon, e.g. `icon("play")`.
pub fn icon(name: &str) -> SharedString {
    SharedString::from(format!("icons/jl/{name}.svg"))
}
