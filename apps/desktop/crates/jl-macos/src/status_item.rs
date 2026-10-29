//! Menu bar extra (`NSStatusItem`) with the recording menu.

use std::cell::RefCell;
use std::time::Duration;

use anyhow::{Context, Result};
use crossbeam_channel::Sender;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{
    AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel,
};
use objc2_app_kit::{
    NSCellImagePosition, NSColor, NSEventModifierFlags, NSFont, NSFontAttributeName,
    NSFontWeightRegular, NSImage, NSImageSymbolConfiguration, NSMenu, NSMenuItem, NSStatusBar,
    NSStatusItem, NSVariableStatusItemLength,
};
use objc2_foundation::{NSArray, NSAttributedString, NSDictionary, NSString};

use crate::Shortcut;
use crate::menu_model::{MenuEntry, MenuItem, StatusEvent, StatusMenu, format_elapsed};

const IDLE_SYMBOL: &str = "record.circle";
const RECORDING_SYMBOL: &str = "record.circle.fill";

struct TargetIvars {
    sender: Sender<StatusEvent>,
    /// The status item, so a right click can show the menu (weakly held via the wrapper).
    item: RefCell<Option<Retained<NSStatusItem>>>,
    menu: RefCell<Option<Retained<NSMenu>>>,
    /// Event for each actionable item, indexed by `NSMenuItem.tag`.
    actions: RefCell<Vec<StatusEvent>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and MenuTarget does not implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "JLStatusMenuTarget"]
    #[ivars = TargetIvars]
    struct MenuTarget;

    impl MenuTarget {
        #[unsafe(method(menuItemSelected:))]
        fn menu_item_selected(&self, item: &NSMenuItem) {
            let event = usize::try_from(item.tag()).ok().and_then(|tag| self.ivars().actions.borrow().get(tag).cloned());
            if let Some(event) = event
                && self.ivars().sender.send(event).is_err()
            {
                log::debug!("status item event dropped: receiver gone");
            }
        }

        /// Left click opens the app's quick recorder; right click (or ⌃-click) shows the menu.
        #[unsafe(method(buttonClicked:))]
        fn button_clicked(&self, _sender: &AnyObject) {
            let mtm = MainThreadMarker::from(self);
            let event = objc2_app_kit::NSApplication::sharedApplication(mtm).currentEvent();
            let secondary = event.as_ref().is_some_and(|e| {
                e.r#type() == objc2_app_kit::NSEventType::RightMouseUp
                    || e.modifierFlags().contains(NSEventModifierFlags::Control)
            });
            let item = self.ivars().item.borrow().clone();
            let Some(item) = item else { return };
            if secondary {
                // Attach the menu just long enough for the click to open it.
                if let (Some(menu), Some(button)) = (self.ivars().menu.borrow().clone(), item.button(mtm)) {
                    item.setMenu(Some(&menu));
                    unsafe { button.performClick(None) };
                    item.setMenu(None);
                }
                return;
            }
            if let Some(anchor) = anchor_of(&item, mtm) {
                let _ = self.ivars().sender.send(StatusEvent::Clicked { anchor });
            }
        }
    }

    unsafe impl NSObjectProtocol for MenuTarget {}
);

impl MenuTarget {
    fn new(sender: Sender<StatusEvent>, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(TargetIvars {
            sender,
            item: RefCell::new(None),
            menu: RefCell::new(None),
            actions: RefCell::new(Vec::new()),
        });
        unsafe { msg_send![super(this), init] }
    }
}

/// The app's menu bar extra. Main-thread only (`!Send`); dropping it removes the item.
pub struct StatusItem {
    mtm: MainThreadMarker,
    item: Retained<NSStatusItem>,
    menu: Retained<NSMenu>,
    target: Retained<MenuTarget>,
    idle_image: Option<Retained<NSImage>>,
    recording_image: Option<Retained<NSImage>>,
    recording: Option<Duration>,
    shown_title: String,
}

impl StatusItem {
    /// Adds the status item to the menu bar with an empty menu (call [`StatusItem::set_menu`]).
    /// Must be called on the main thread after the application has finished launching.
    pub fn install(events: Sender<StatusEvent>) -> Result<StatusItem> {
        let mtm =
            MainThreadMarker::new().context("StatusItem::install must run on the main thread")?;
        let item = NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);
        item.setAutosaveName(Some(&NSString::from_str("JittleLampStatusItem")));

        let menu = NSMenu::new(mtm);
        menu.setAutoenablesItems(false);

        let idle_image = symbol_image(IDLE_SYMBOL, "Jittle Lamp");
        let recording_image =
            symbol_image(RECORDING_SYMBOL, "Jittle Lamp — recording").map(|image| {
                let red = NSArray::from_retained_slice(&[NSColor::systemRedColor()]);
                let config = NSImageSymbolConfiguration::configurationWithPaletteColors(&red);
                let tinted = image.imageWithSymbolConfiguration(&config).unwrap_or(image);
                tinted.setTemplate(false);
                tinted
            });
        if idle_image.is_none() {
            log::warn!("SF Symbol {IDLE_SYMBOL} unavailable; status item falls back to text");
        }

        let mut this = StatusItem {
            mtm,
            item,
            menu,
            target: MenuTarget::new(events, mtm),
            idle_image,
            recording_image,
            recording: None,
            shown_title: String::new(),
        };
        *this.target.ivars().item.borrow_mut() = Some(this.item.clone());
        *this.target.ivars().menu.borrow_mut() = Some(this.menu.clone());
        if let Some(button) = this.item.button(mtm) {
            button.setImagePosition(NSCellImagePosition::ImageLeading);
            button.setToolTip(Some(&NSString::from_str("Jittle Lamp — click to record, right-click for more")));
            unsafe {
                button.setTarget(Some(&this.target));
                button.setAction(Some(sel!(buttonClicked:)));
            }
            button.sendActionOn(objc2_app_kit::NSEventMask::LeftMouseUp | objc2_app_kit::NSEventMask::RightMouseUp);
        }
        this.apply_recording(None);
        Ok(this)
    }

    /// Switches between the idle icon and the red recording icon with an elapsed-time title.
    /// Cheap to call every second: only the title is touched while the state is unchanged.
    pub fn set_recording(&mut self, elapsed: Option<Duration>) {
        let state_changed = self.recording.is_some() != elapsed.is_some();
        self.recording = elapsed;
        if state_changed {
            self.apply_recording(elapsed);
        } else if let Some(elapsed) = elapsed {
            self.set_title(&format_elapsed(elapsed));
        }
    }

    /// Rebuilds the menu. Safe to call while the menu is open.
    pub fn set_menu(&self, model: &StatusMenu) {
        self.menu.removeAllItems();
        let mut actions = Vec::new();
        build_items(
            &self.menu,
            &model.entries(),
            &self.target,
            &mut actions,
            self.mtm,
        );
        *self.target.ivars().actions.borrow_mut() = actions;
    }

    /// The icon's frame in global top-left-origin points, for anchoring a panel under it.
    pub fn anchor(&self) -> Option<(i32, i32, i32, i32)> {
        anchor_of(&self.item, self.mtm)
    }

    /// The underlying `NSStatusItem`, for anything this wrapper doesn't cover.
    pub fn ns_status_item(&self) -> &NSStatusItem {
        &self.item
    }

    /// Performs the action of the item whose title path matches, as if clicked (e.g.
    /// `&["Start Recording", "Safari"]`). Returns false when no enabled item matches. Used by
    /// the example to exercise the action wiring without opening the menu.
    #[doc(hidden)]
    pub fn trigger(&self, path: &[&str]) -> bool {
        let mut menu = self.menu.clone();
        for (depth, title) in path.iter().enumerate() {
            let items = menu.itemArray();
            let Some((index, item)) = items
                .iter()
                .enumerate()
                .find(|(_, i)| i.title().to_string() == *title)
            else {
                return false;
            };
            if depth + 1 == path.len() {
                if !item.isEnabled() {
                    return false;
                }
                menu.performActionForItemAtIndex(index as isize);
                return true;
            }
            let Some(sub) = item.submenu() else {
                return false;
            };
            menu = sub;
        }
        false
    }

    fn apply_recording(&mut self, elapsed: Option<Duration>) {
        let Some(button) = self.item.button(self.mtm) else {
            return;
        };
        let image = if elapsed.is_some() {
            &self.recording_image
        } else {
            &self.idle_image
        };
        button.setImage(image.as_deref());
        match elapsed {
            Some(elapsed) => self.set_title(&format_elapsed(elapsed)),
            None if image.is_none() => self.set_title("JL"),
            None => self.set_title(""),
        }
    }

    fn set_title(&mut self, title: &str) {
        if self.shown_title == title {
            return;
        }
        let Some(button) = self.item.button(self.mtm) else {
            return;
        };
        if title.is_empty() {
            button.setTitle(&NSString::new());
        } else {
            // Monospaced digits keep the item from jittering as the timer ticks.
            let size = NSFont::menuBarFontOfSize(0.0).pointSize();
            let font = NSFont::monospacedDigitSystemFontOfSize_weight(size, unsafe {
                NSFontWeightRegular
            });
            let attrs: Retained<NSDictionary<_, AnyObject>> = NSDictionary::from_slices(
                &[unsafe { NSFontAttributeName }],
                &[&*font as &AnyObject],
            );
            let text = NSString::from_str(&format!(" {title}"));
            let string = unsafe {
                NSAttributedString::initWithString_attributes(
                    NSAttributedString::alloc(),
                    &text,
                    Some(&attrs),
                )
            };
            button.setAttributedTitle(&string);
        }
        self.shown_title = title.to_string();
    }
}

impl Drop for StatusItem {
    fn drop(&mut self) {
        NSStatusBar::systemStatusBar().removeStatusItem(&self.item);
    }
}

fn symbol_image(name: &str, description: &str) -> Option<Retained<NSImage>> {
    NSImage::imageWithSystemSymbolName_accessibilityDescription(
        &NSString::from_str(name),
        Some(&NSString::from_str(description)),
    )
}

fn build_items(
    menu: &NSMenu,
    entries: &[MenuEntry],
    target: &MenuTarget,
    actions: &mut Vec<StatusEvent>,
    mtm: MainThreadMarker,
) {
    for entry in entries {
        match entry {
            MenuEntry::Separator => menu.addItem(&NSMenuItem::separatorItem(mtm)),
            MenuEntry::Header(title) => {
                menu.addItem(&NSMenuItem::sectionHeaderWithTitle(
                    &NSString::from_str(title),
                    mtm,
                ));
            }
            MenuEntry::Info(title) => {
                let item = plain_item(title, mtm);
                item.setEnabled(false);
                menu.addItem(&item);
            }
            MenuEntry::Submenu {
                title,
                symbol,
                items,
            } => {
                let item = plain_item(title, mtm);
                set_symbol(&item, *symbol);
                let submenu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(title));
                submenu.setAutoenablesItems(false);
                build_items(&submenu, items, target, actions, mtm);
                item.setSubmenu(Some(&submenu));
                item.setEnabled(!items.is_empty());
                menu.addItem(&item);
            }
            MenuEntry::Item(model) => menu.addItem(&action_item(model, target, actions, mtm)),
        }
    }
}

fn plain_item(title: &str, mtm: MainThreadMarker) -> Retained<NSMenuItem> {
    unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(title),
            None,
            &NSString::new(),
        )
    }
}

fn action_item(
    model: &MenuItem,
    target: &MenuTarget,
    actions: &mut Vec<StatusEvent>,
    mtm: MainThreadMarker,
) -> Retained<NSMenuItem> {
    let item = plain_item(&model.title, mtm);
    set_symbol(&item, model.symbol);
    if let Some(shortcut) = model.shortcut.and_then(|s| Shortcut::parse(s).ok())
        && let Some(key) = shortcut.menu_key_equivalent()
    {
        item.setKeyEquivalent(&NSString::from_str(&key));
        item.setKeyEquivalentModifierMask(modifier_flags(&shortcut));
    }
    match &model.event {
        Some(event) => {
            item.setTag(actions.len() as isize);
            actions.push(event.clone());
            unsafe {
                item.setTarget(Some(target));
                item.setAction(Some(sel!(menuItemSelected:)));
            }
            item.setEnabled(true);
        }
        None => item.setEnabled(false),
    }
    item
}

fn set_symbol(item: &NSMenuItem, symbol: Option<&str>) {
    if let Some(image) = symbol.and_then(|name| symbol_image(name, "")) {
        item.setImage(Some(&image));
    }
}

fn modifier_flags(shortcut: &Shortcut) -> NSEventModifierFlags {
    let m = shortcut.modifiers;
    let mut flags = NSEventModifierFlags::empty();
    if m.command {
        flags |= NSEventModifierFlags::Command;
    }
    if m.control {
        flags |= NSEventModifierFlags::Control;
    }
    if m.option {
        flags |= NSEventModifierFlags::Option;
    }
    if m.shift {
        flags |= NSEventModifierFlags::Shift;
    }
    flags
}

/// The status button's window frame, flipped from AppKit's bottom-left origin to the top-left
/// origin GPUI uses (relative to the primary screen).
fn anchor_of(item: &NSStatusItem, mtm: MainThreadMarker) -> Option<(i32, i32, i32, i32)> {
    let window = item.button(mtm)?.window()?;
    let frame = window.frame();
    let primary = objc2_app_kit::NSScreen::screens(mtm).firstObject()?.frame();
    let top = primary.size.height - (frame.origin.y + frame.size.height);
    Some((frame.origin.x.round() as i32, top.round() as i32, frame.size.width.round() as i32, frame.size.height.round() as i32))
}
