//! Component family `media` - pictures: `<Avatar>` (a person's picture, or their initials on a
//! tint, with a presence dot - the web's avatars), `<AvatarStack>` (the people present, as
//! overlapping initials - the web's presence list) and `<PictureBox>` (WinForms `PictureBox`).
//! Compiled with the `family-media` feature (on by default through `all-families`).
//!
//! An image comes from a file (`Image`, relative to the view, bindable) or from memory
//! (`ImageData`, bound to the bytes of a PNG, JPEG, GIF, BMP… file handed as a `Shared<Vec<u8>>` /
//! `Value::Object` - a picture downloaded by the application). Decoded once per content
//! (`kubuno_desktop_controls::styled::load_image` / `load_image_bytes`).

#[allow(unused_imports)] // Used by the `component!` invocations below.
use crate::registry::macros::component;
use crate::registry::ComponentMeta;

use crate::binding::{BindingSpec, PropSource, Value, ViewModel};
use crate::node::{PaintCx, ViewNode};
use crate::props::{BuildError, Props};

use kubuno_desktop_controls::{styled, ImageLayout};
use kubuno_desktop_ui::{Canvas, Rect, Size};
use windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F;
use windows::Win32::Graphics::Direct2D::ID2D1Bitmap1;

/// `<SplashArtwork>`, the artwork of a splash screen (`kubuno_desktop_ui::splash`), in its own file.
#[path = "splash.rs"]
pub mod splash;

/// The image of `path` (resolved against the view's folder) or of the bytes `data` resolves to.
pub(crate) struct ImageSource {
    path: PropSource<String>,
    data: Option<BindingSpec>,
    base_dir: Option<std::path::PathBuf>,
}

impl ImageSource {
    fn read(props: &Props<'_>, base_dir: Option<std::path::PathBuf>) -> Result<Self, BuildError> {
        Ok(Self { path: props.str("Image", "")?, data: props.str("ImageData", "")?.binding().cloned(), base_dir })
    }

    /// The bitmap to show this frame, if any.
    fn bitmap(&self, c: &dyn kubuno_desktop_controls::ControlCanvas, vm: &dyn ViewModel) -> Option<ID2D1Bitmap1> {
        if let Some(spec) = &self.data {
            if let Some(Value::Object(o)) = vm.get(&spec.path) {
                if let Some(bytes) = o.downcast_ref::<Vec<u8>>() {
                    if !bytes.is_empty() {
                        let key = (o.identity() as u64) ^ ((bytes.len() as u64) << 40);
                        return styled::load_image_bytes(c, key, bytes);
                    }
                }
            }
        }
        let path = self.path.resolve(vm);
        if path.trim().is_empty() {
            return None;
        }
        let full = match &self.base_dir {
            // A resource (`kbres:` URI, vskubuno docs/RESOURCES.md) is not a path.
            Some(dir) if std::path::Path::new(&path).is_relative() && !path.starts_with(kubuno_desktop_resources::URI_SCHEME) => dir.join(&path).to_string_lossy().into_owned(),
            _ => path,
        };
        styled::load_image(c, &full)
    }
}

/// Draws `bitmap` covering `dest` (cropped, never distorted: the web's `object-cover`).
fn draw_cover(c: &dyn kubuno_desktop_controls::ControlCanvas, bitmap: &ID2D1Bitmap1, dest: Rect) {
    let (w, h) = styled::image_size(bitmap);
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    let (dw, dh) = (dest.right - dest.left, dest.bottom - dest.top);
    let scale = (dw / w).max(dh / h);
    let (sw, sh) = (w * scale, h * scale);
    let left = dest.left + (dw - sw) / 2.0;
    let top = dest.top + (dh - sh) / 2.0;
    c.draw_bitmap(bitmap, &Rect::new(left, top, left + sw, top + sh), 1.0);
}

// ═════════════════════════════════════════════════════════════════════════
// Avatar
// ═════════════════════════════════════════════════════════════════════════

component! {
    mod_name: avatar,
    name: "Avatar",
    // Note: The web's avatars (`ShareDialog`'s `Avatar`, `UserAvatar`): a picture, else initials on a tint.
    doc: "A person's picture in a circle, or their initials on a colour when there is no picture, with an optional presence dot.",
    ctor: kubuno_desktop_ui::display::Icon::new("User"),
    children: ChildrenModel::None,
    props: [
        PropertyMeta::new("DisplayName", PropKind::String, "", "The person's name: its initials are shown when there is no picture, and it picks the colour.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("Initials", PropKind::String, "", "The letters shown instead of the name's initials.").category("Appearance").bindable(),
        PropertyMeta::new("Image", PropKind::String, "", "The picture: the path of an image file, relative to the view.").category("Appearance").editor("image").bindable(),
        PropertyMeta::new("ImageData", PropKind::String, "", "The picture as the bytes of an image file (a binding to a Shared<Vec<u8>>), for a picture the application downloaded.").category("Appearance").editor("object").bindable(),
        PropertyMeta::new("Tint", PropKind::Enum(&["Auto", "Accent", "Primary"]), "Auto", "Auto: a colour picked from the name, initials in white. Accent: the pale accent colour, initials in the accent colour. Primary: the accent colour, initials in white (the signed-in user in a header).").category("Appearance"),
        PropertyMeta::new("Shape", PropKind::Enum(&["Circle", "Rounded"]), "Circle", "A circle, or a square with rounded corners.").category("Appearance"),
        PropertyMeta::new("Presence", PropKind::Enum(&["None", "Online", "Away", "Busy", "Offline"]), "None", "The dot shown at the bottom right: whether the person is available.").category("Appearance").bindable(),
        PropertyMeta::new("AvatarSize", PropKind::F32, "36", "The diameter of the avatar, in DIP (the element's box is filled when it is smaller).").category("Layout"),
    ],
    events: [],
    smoke: |i| { i },
    build: |props, cx| {
        crate::registry::families::media::build_avatar(props, cx.base_dir.clone())
    },
}

pub(crate) fn build_avatar(props: &Props<'_>, base_dir: Option<std::path::PathBuf>) -> Result<Box<dyn ViewNode>, BuildError> {
    Ok(Box::new(AvatarNode {
        name: props.str("DisplayName", "")?,
        initials: props.str("Initials", "")?,
        image: ImageSource::read(props, base_dir)?,
        accent: props.enum_("Tint", "Auto")?,
        rounded: props.enum_("Shape", "Circle")?,
        presence: props.enum_("Presence", "None")?,
        size: props.f32("AvatarSize", 36.0)?,
    }))
}

/// `<Avatar>`'s live node.
pub struct AvatarNode {
    name: PropSource<String>,
    initials: PropSource<String>,
    image: ImageSource,
    accent: PropSource<String>,
    rounded: PropSource<String>,
    presence: PropSource<String>,
    size: PropSource<f32>,
}

/// The initials of `name`: the first letters of its first two words (one word: its first two
/// letters), upper case.
pub fn initials_of(name: &str) -> String {
    let words: Vec<&str> = name.split(|c: char| c.is_whitespace() || c == '.' || c == '@' || c == '-' || c == '_').filter(|w| !w.is_empty()).collect();
    let letters: String = match words.as_slice() {
        [] => String::new(),
        [one] => one.chars().take(2).collect(),
        [first, second, ..] => first.chars().take(1).chain(second.chars().take(1)).collect(),
    };
    letters.to_uppercase()
}

/// The web's avatar palette (`ShareDialog.tsx`), picked by a hash of the name.
fn tint_of(name: &str) -> D2D1_COLOR_F {
    const PALETTE: [u32; 8] = [0x1a73e8, 0xd93025, 0x1e8e3e, 0xf9ab00, 0x9334e6, 0xe8710a, 0x12b5cb, 0xd01884];
    let h = name.chars().fold(0u32, |h, c| h.wrapping_mul(31).wrapping_add(c as u32));
    let rgb = PALETTE[(h as usize) % PALETTE.len()];
    D2D1_COLOR_F { r: ((rgb >> 16) & 0xff) as f32 / 255.0, g: ((rgb >> 8) & 0xff) as f32 / 255.0, b: (rgb & 0xff) as f32 / 255.0, a: 1.0 }
}

impl ViewNode for AvatarNode {
    fn measure(&self, _c: &dyn Canvas, vm: &dyn ViewModel) -> Size {
        let s = self.size.resolve(vm).max(8.0);
        Size::new(s, s)
    }

    fn intrinsic_width(&self, _c: &dyn Canvas, vm: &dyn ViewModel) -> Option<f32> {
        Some(self.size.resolve(vm).max(8.0))
    }

    fn paint(&mut self, cx: &mut PaintCx<'_>, bounds: Rect) {
        let vm: &dyn ViewModel = &*cx.vm;
        let c = cx.canvas;
        let side = self.size.resolve(vm).max(8.0).min(bounds.right - bounds.left).min(bounds.bottom - bounds.top);
        if side <= 0.0 {
            return;
        }
        let rect = Rect::new(bounds.left, bounds.top, bounds.left + side, bounds.top + side);
        let radius = if self.rounded.resolve(vm) == "Rounded" { (side * 0.22).round() } else { side / 2.0 };
        let theme = c.theme().clone();
        let name = self.name.resolve(vm);
        match self.image.bitmap(c, vm) {
            Some(bitmap) => {
                c.push_clip_rounded(&rect, radius);
                draw_cover(c, &bitmap, rect);
                c.pop_clip_rounded();
            }
            None => {
                let (fill, ink) = match self.accent.resolve(vm).as_str() {
                    "Accent" => (theme.accent_light, theme.accent),
                    "Primary" => (theme.accent, theme.accent_foreground),
                    _ => (tint_of(&name), D2D1_COLOR_F { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }),
                };
                c.fill_rounded(&rect, radius, &fill);
                let own = self.initials.resolve(vm);
                let text = if own.trim().is_empty() { initials_of(&name) } else { own.trim().to_uppercase() };
                if text.is_empty() {
                    c.vector_icon("User", &rect, side * 0.55, &ink);
                } else {
                    let f = c.formats();
                    // The letters grow with the avatar: a profile hero is not a list row.
                    // The signed-in user's small avatar of a header writes its letters in the body face
                    // (the web's `HeaderActions`); a list's, in the strong caption face.
                    let primary_small = side < 40.0 && self.accent.resolve(vm) == "Primary";
                    let format = if side >= 72.0 { &f.heading_strong } else if side >= 40.0 { &f.body_strong } else if primary_small { &f.body } else { &f.caption_strong };
                    c.text_ellipsis_center(&text, &rect, format, &ink);
                }
            }
        }
        let presence = match self.presence.resolve(vm).as_str() {
            "Online" => Some(theme.success),
            "Away" => Some(theme.warning),
            "Busy" => Some(theme.danger),
            "Offline" => Some(theme.text_tertiary),
            _ => None,
        };
        if let Some(color) = presence {
            // A dot a quarter of the avatar, ringed with the surface it sits on.
            let d = (side * 0.28).clamp(8.0, 16.0);
            let ring = 2.0;
            let dot = Rect::new(rect.right - d, rect.bottom - d, rect.right, rect.bottom);
            c.fill_rounded(&Rect::new(dot.left - ring, dot.top - ring, dot.right + ring, dot.bottom + ring), (d + 2.0 * ring) / 2.0, &c.current_bg());
            c.fill_rounded(&dot, d / 2.0, &color);
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════
// AvatarStack
// ═════════════════════════════════════════════════════════════════════════

component! {
    mod_name: avatar_stack,
    name: "AvatarStack",
    // Note: The web's `PresenceAvatarList` (`web/src/collab/presence.tsx`), formerly `PresenceAvatars` in the Presentations and Spreadsheets apps: discs in each person's colour with their initials, ringed with the surface colour, overlapping, a few at most then a « +N » chip.
    doc: "The people present, as a row of overlapping circles with their initials in their colour; past a few, a chip counts the others. Each circle shows the person's name as its tooltip.",
    ctor: kubuno_desktop_ui::display::Icon::new("Users"),
    children: ChildrenModel::None,
    props: [
        PropertyMeta::new("Users", PropKind::String, "", "The people, one per line: a name, then optionally a bar and a colour (Alice|#1a73e8). Without a colour, one is picked from the name.").category("Data").bindable(),
        PropertyMeta::new("AvatarSize", PropKind::F32, "28", "The diameter of each circle, in DIP.").category("Layout"),
        PropertyMeta::new("Overlap", PropKind::F32, "8", "How much each circle covers the previous one, in DIP.").category("Layout"),
        PropertyMeta::new("MaxVisible", PropKind::F32, "5", "How many people are shown before the chip that counts the others.").category("Behavior"),
        PropertyMeta::new("RingColor", PropKind::String, "", "The colour of the ring around each circle: a theme colour or a colour of your choice. Empty: the colour of the surface.").category("Appearance").editor("color"),
    ],
    events: [],
    smoke: |i| { i },
    build: |props, _cx| {
        Ok(Box::new(crate::registry::families::media::AvatarStackNode {
            users: props.str("Users", "")?,
            size: props.f32("AvatarSize", 28.0)?,
            overlap: props.f32("Overlap", 8.0)?,
            max_visible: props.f32("MaxVisible", 5.0)?,
            ring: props.str("RingColor", "")?,
            hot: None,
        }) as Box<dyn ViewNode>)
    },
}

/// The grey of the « +N » chip (`bg-gray-500` of the web's list).
const STACK_MORE_FILL: u32 = 0x80868b;

/// The people of an `<AvatarStack>`'s `Users`: one per line, `name|#rrggbb` (the colour optional),
/// the empty names skipped.
pub fn stack_users(users: &str) -> Vec<(String, Option<String>)> {
    users
        .lines()
        .filter_map(|line| {
            let (name, color) = match line.rsplit_once('|') {
                Some((n, c)) => (n.trim(), Some(c.trim().to_string()).filter(|c| !c.is_empty())),
                None => (line.trim(), None),
            };
            (!name.is_empty()).then(|| (name.to_string(), color))
        })
        .collect()
}

/// One circle of an `<AvatarStack>`.
#[derive(Debug, Clone, PartialEq)]
pub enum StackSlot {
    /// The person of index `0` in the list.
    User(usize),
    /// The « +N » chip: how many people are not shown.
    More(usize),
}

/// The circles of `count` people in `bounds`: `size` wide, each `size - overlap` after the
/// previous, at most `max` people then the chip; centred vertically.
pub fn stack_slots(count: usize, max: usize, size: f32, overlap: f32, bounds: Rect) -> Vec<(StackSlot, Rect)> {
    let step = (size - overlap).max(1.0);
    let top = bounds.top + ((bounds.bottom - bounds.top - size) / 2.0).max(0.0);
    let at = |i: usize| {
        let x = bounds.left + i as f32 * step;
        Rect::new(x, top, x + size, top + size)
    };
    let mut out: Vec<(StackSlot, Rect)> = (0..count.min(max)).map(|i| (StackSlot::User(i), at(i))).collect();
    if count > max {
        out.push((StackSlot::More(count - max), at(max)));
    }
    out
}

/// `<AvatarStack>`'s live node.
pub struct AvatarStackNode {
    users: PropSource<String>,
    size: PropSource<f32>,
    overlap: PropSource<f32>,
    max_visible: PropSource<f32>,
    ring: PropSource<String>,
    /// The circle under the pointer (its tooltip).
    hot: Option<usize>,
}

impl AvatarStackNode {
    fn metrics(&self, vm: &dyn ViewModel) -> (f32, f32, usize) {
        let size = self.size.resolve(vm).max(8.0);
        let overlap = self.overlap.resolve(vm).clamp(0.0, size - 1.0);
        (size, overlap, self.max_visible.resolve(vm).max(0.0).round() as usize)
    }
}

/// `color` (`#rrggbb`) as a Direct2D colour.
fn hex_color(color: &str) -> Option<D2D1_COLOR_F> {
    kubuno_desktop_ui::graphics::Color::from_hex(color).map(|c| c.to_d2d())
}

fn rgb(rgb: u32) -> D2D1_COLOR_F {
    D2D1_COLOR_F { r: ((rgb >> 16) & 0xff) as f32 / 255.0, g: ((rgb >> 8) & 0xff) as f32 / 255.0, b: (rgb & 0xff) as f32 / 255.0, a: 1.0 }
}

impl ViewNode for AvatarStackNode {
    fn measure(&self, _c: &dyn Canvas, vm: &dyn ViewModel) -> Size {
        let (size, overlap, max) = self.metrics(vm);
        let n = stack_users(&self.users.resolve(vm)).len().min(max + 1);
        let w = if n == 0 { 0.0 } else { (size - overlap).max(1.0) * (n as f32 - 1.0) + size + 4.0 };
        Size::new(w, size)
    }

    fn intrinsic_width(&self, c: &dyn Canvas, vm: &dyn ViewModel) -> Option<f32> {
        Some(self.measure(c, vm).width)
    }

    fn paint(&mut self, cx: &mut PaintCx<'_>, bounds: Rect) {
        use kubuno_desktop_ui::graphics::{Brush, Color, Font, FontStyle, Graphics, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
        let vm: &dyn ViewModel = &*cx.vm;
        let c = cx.canvas;
        let (size, overlap, max) = self.metrics(vm);
        let users = stack_users(&self.users.resolve(vm));
        // Inset by the ring, so the first circle's ring is not cut by the element's edge.
        let inner = Rect::new(bounds.left + 2.0, bounds.top, bounds.right, bounds.bottom);
        let slots = stack_slots(users.len(), max, size, overlap, inner);
        let theme = c.theme().clone();
        let ring_text = self.ring.resolve(vm);
        let ring = crate::style::parse_color(&ring_text)
            .ok()
            .flatten()
            .map(|v| v.resolve_with(&theme, crate::style::high_contrast()))
            .unwrap_or(theme.card_background);
        let g = Graphics::new(c);
        // The web's initials: white, 11 px bold on a 28 DIP circle, growing with it.
        let font = Font::with_dip("Segoe UI", (11.0 * size / 28.0).max(6.0), FontStyle::BOLD);
        let format = StringFormat { alignment: StringAlignment::Center, line_alignment: StringAlignment::Center, trimming: StringTrimming::None, flags: StringFormatFlags::NO_WRAP };
        for (slot, r) in &slots {
            let (fill, label) = match slot {
                StackSlot::User(i) => {
                    let (name, color) = &users[*i];
                    let fill = color.as_deref().and_then(hex_color).unwrap_or_else(|| tint_of(name));
                    let initials = initials_of(name);
                    (fill, if initials.is_empty() { "?".to_string() } else { initials })
                }
                StackSlot::More(n) => (rgb(STACK_MORE_FILL), format!("+{n}")),
            };
            g.fill_ellipse(Brush::solid(Color::from(ring)), Rect::new(r.left - 2.0, r.top - 2.0, r.right + 2.0, r.bottom + 2.0));
            g.fill_ellipse(Brush::solid(Color::from(fill)), *r);
            g.draw_string(&label, &font, Brush::solid(Color::WHITE), *r, &format);
        }
        if cx.design.is_some() {
            if users.is_empty() {
                crate::node::custom::paint_placeholder(c, bounds, "AvatarStack", "Set Users to show people");
            }
            return;
        }
        // The circle under the pointer: the last one drawn there (they overlap left to right).
        let frame = cx.frame;
        let (mx, my) = frame.mouse;
        self.hot = if frame.pointer_outside() { None } else { slots.iter().rposition(|(_, r)| r.contains(mx, my)) };
        let Some((slot_events, _)) = cx.sender.clone() else { return };
        let Some(services) = cx.services.as_deref_mut() else { return };
        let name_of = |slot: &StackSlot| match slot {
            StackSlot::User(i) => users[*i].0.clone(),
            StackSlot::More(_) => users.iter().skip(max).map(|(n, _)| n.as_str()).collect::<Vec<_>>().join("\n"),
        };
        if let Some((slot, r)) = self.hot.and_then(|i| slots.get(i)) {
            services.offer_tooltip(name_of(slot), crate::clip::visible_client(crate::common::to_client(*r)), &slot_events.id);
        }
        // Each person in the accessibility tree, under the element.
        let parent = crate::common::access_id(&slot_events.id);
        for (i, (slot, r)) in slots.iter().enumerate() {
            let StackSlot::User(_) = slot else { continue };
            let v = crate::clip::visible_client(crate::common::to_client(*r));
            services.access.push(kubuno_desktop_controls::host::access::AccessNode {
                id: crate::common::access_id(&format!("{}/part{i}", slot_events.id)),
                parent: Some(parent),
                role: kubuno_desktop_controls::host::access::AccessRole::Button,
                name: name_of(slot),
                description: String::new(),
                value: None,
                bounds: (v.left, v.top, v.right, v.bottom),
                focusable: false,
                disabled: false,
                checked: None,
                clickable: false,
                read_only: true,
                access_key: None,
                expanded: None,
            });
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════
// PictureBox
// ═════════════════════════════════════════════════════════════════════════

component! {
    mod_name: picture_box,
    name: "PictureBox",
    // Note: WinForms `PictureBox`: an image, laid out by `SizeMode`.
    doc: "An image, from a file or from memory, fitted into the control by SizeMode.",
    ctor: kubuno_desktop_ui::display::Icon::new("Image"),
    children: ChildrenModel::None,
    props: [
        PropertyMeta::new("Image", PropKind::String, "", "The image: the path of an image file, relative to the view.").category("Appearance").editor("image").bindable(),
        PropertyMeta::new("ImageData", PropKind::String, "", "The image as the bytes of an image file (a binding to a Shared<Vec<u8>>).").category("Appearance").editor("object").bindable(),
        PropertyMeta::new("SizeMode", PropKind::Enum(&["Normal", "Stretch", "Zoom", "Center", "Cover"]), "Normal", "Normal: at its size, top left. Stretch: to the control's size. Zoom: as large as fits, keeping its proportions. Center: at its size, centred. Cover: fills the control, keeping its proportions (cropped).").category("Behavior"),
        PropertyMeta::new("CornerRadius", PropKind::F32, "0", "Rounds the corners of the image, in DIP.").category("Appearance"),
        PropertyMeta::new("BorderStyle", PropKind::Enum(&["None", "FixedSingle"]), "None", "A line drawn around the control.").category("Appearance"),
    ],
    events: [],
    smoke: |i| { i },
    build: |props, cx| {
        Ok(Box::new(crate::registry::families::media::PictureBoxNode {
            image: crate::registry::families::media::ImageSource::read(props, cx.base_dir.clone())?,
            mode: props.enum_("SizeMode", "Normal")?,
            radius: props.f32("CornerRadius", 0.0)?,
            border: props.enum_("BorderStyle", "None")?,
        }) as Box<dyn ViewNode>)
    },
}

/// `<PictureBox>`'s live node.
pub struct PictureBoxNode {
    image: ImageSource,
    mode: PropSource<String>,
    radius: PropSource<f32>,
    border: PropSource<String>,
}

impl ViewNode for PictureBoxNode {
    fn measure(&self, _c: &dyn Canvas, _vm: &dyn ViewModel) -> Size {
        Size::new(160.0, 120.0)
    }

    fn paint(&mut self, cx: &mut PaintCx<'_>, bounds: Rect) {
        let vm: &dyn ViewModel = &*cx.vm;
        let c = cx.canvas;
        let radius = self.radius.resolve(vm).max(0.0);
        let border = self.border.resolve(vm) == "FixedSingle";
        let Some(bitmap) = self.image.bitmap(c, vm) else {
            if border {
                c.stroke_rounded(&bounds, radius, &c.theme().card_stroke);
            }
            if cx.design.is_some() {
                crate::node::custom::paint_placeholder(c, bounds, "PictureBox", "Set Image to show a picture");
            }
            return;
        };
        let clip = |c: &dyn kubuno_desktop_controls::ControlCanvas| {
            if radius > 0.0 {
                c.push_clip_rounded(&bounds, radius);
            } else {
                c.push_clip(&bounds);
            }
        };
        clip(c);
        match self.mode.resolve(vm).as_str() {
            "Cover" => draw_cover(c, &bitmap, bounds),
            mode => {
                let layout = match mode {
                    "Stretch" => ImageLayout::Stretch,
                    "Zoom" => ImageLayout::Zoom,
                    "Center" => ImageLayout::Center,
                    _ => ImageLayout::None,
                };
                styled::draw_image(c, &bitmap, bounds, layout);
            }
        }
        if radius > 0.0 {
            c.pop_clip_rounded();
        } else {
            c.pop_clip();
        }
        if border {
            c.stroke_rounded(&bounds, radius, &c.theme().card_stroke);
        }
    }
}

/// Every component this family declares.
pub const ALL: &[ComponentMeta] = &[avatar::META, avatar_stack::META, picture_box::META, splash::splash_artwork::META];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initials_follow_the_web() {
        assert_eq!(initials_of("Martinien Olinga"), "MO");
        assert_eq!(initials_of("alice"), "AL");
        assert_eq!(initials_of("jean-paul.sartre@example.com"), "JP");
        assert_eq!(initials_of("  "), "");
    }

    #[test]
    fn a_name_keeps_its_tint() {
        assert_eq!(tint_of("Alice"), tint_of("Alice"));
    }

    #[test]
    fn a_stack_reads_one_person_per_line() {
        let users = stack_users("Martinien Olinga|#1a73e8\n|#000000\nana\n  Bob | #d93025 ");
        assert_eq!(
            users,
            vec![("Martinien Olinga".to_string(), Some("#1a73e8".to_string())), ("ana".to_string(), None), ("Bob".to_string(), Some("#d93025".to_string()))]
        );
        // The core's initials (the first two words), not the web list's (first and last word).
        assert_eq!(initials_of("Jean Paul Sartre"), "JP");
        assert_eq!(hex_color("#1a73e8"), Some(rgb(0x1a73e8)));
    }

    #[test]
    fn a_stack_shows_a_few_people_then_counts_the_others() {
        let b = Rect::new(0.0, 0.0, 200.0, 32.0);
        let slots = stack_slots(7, 5, 28.0, 8.0, b);
        assert_eq!(slots.len(), 6);
        assert_eq!(slots[5].0, StackSlot::More(2));
        assert_eq!(slots[1].1.left - slots[0].1.left, 20.0, "28 DIP circles overlapping by 8");
        assert_eq!(slots[0].1.top, 2.0, "centred vertically");
        assert_eq!(stack_slots(3, 5, 28.0, 8.0, b).len(), 3);
        assert!(stack_slots(0, 5, 28.0, 8.0, b).is_empty());
    }

    #[test]
    fn avatars_and_pictures_compile() {
        let src = r##"<Panel><Avatar DisplayName="{Binding Name}" Presence="Online" AvatarSize="40"/><PictureBox Image="logo.png" SizeMode="Zoom" CornerRadius="8"/><Avatar ImageData="{Binding Photo}"/><AvatarStack Users="{Binding PresenceUsers}" MaxVisible="3" RingColor="#FFFFFF"/></Panel>"##;
        assert!(crate::compile::compile(src).is_ok(), "{:?}", crate::compile::compile(src).err());
        let bad = r#"<Panel><Avatar ImageData="photo.png"/></Panel>"#;
        assert!(crate::compile::compile(bad).is_err(), "ImageData takes a binding only");
    }
}
