//! Render a parsed `.kbview`/`.kbcontrol` into a CPU pixmap.
//!
//! The view is parsed by the *shared* Kubuno grammar ([`kubuno_desktop_views_syntax`]) - the same parser the web
//! compiler and the desktop runtime use - and rendered in the *shared* control vocabulary (the registry
//! `web/src/ui/kbview-registry.web.json`): a screen's root is a `Panel`/`Stack`, boxes carry
//! `BackColor`/`Surface`/`CornerRadius`/`Elevation`, text is a `Label` sized by its typographic `Role`, a `Button` is
//! styled by its `Variant`. So a mobile view renders the same here as in the web/desktop designer.
//!
//! Layout is delegated to [`taffy`], a CSS flexbox engine - the same model the web design surface uses - so the
//! device and the designer agree: a `Stack` is a flex container (`Direction`, `Gap`, `CrossAlign` → `align-items`,
//! `Justify` → `justify-content`, `Stack.Fill` → `flex: 1 1 0`), a `Panel` docks its children like a DockPanel
//! (nested flex boxes, in document order, the undocked children filling what remains) or places them absolutely
//! (`Layout="Absolute"` + `X`/`Y`), and a `ScrollArea` clips its content. Painting is done on the CPU with
//! [`tiny_skia`]: anti-aliased rounded boxes, Gaussian-blurred drop shadows, Lucide icon strokes and text drawn
//! from the font's glyph outlines (via skrifa), with ellipsis and word wrapping.
//!
//! Views are authored in **logical** pixels (≈ a 390-pt-wide phone, like the web); everything is scaled to the
//! physical surface by the device pixel ratio.

use std::cell::RefCell;
use std::collections::HashMap;

use kubuno_desktop_views_syntax::ast::{AstNode, Document, Element};
use kubuno_desktop_views_syntax::syntax::parse;
use kurbo::{BezPath, PathEl};
use skrifa::instance::{LocationRef, Size as FontSize};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::{FontRef, MetadataProvider};
use taffy::prelude::*;
use taffy::Overflow;
use tiny_skia as sk;

use crate::host::{HostCanvas, HostElement, HostRect};
use crate::icons::icon_paths;
use crate::text_input::FieldSpec;
use crate::FontHandle;

/// The logical width a Kubuno view is authored in (a phone's CSS width), scaled to the real surface.
const DESIGN_WIDTH: f32 = 390.0;

/// Safe-area insets (status bar on top, gesture / navigation bar at the bottom), in design px (≈ dp). The shells
/// draw edge to edge: the screen background fills the whole surface, the content is laid out inside these bands.
const SAFE_TOP: f32 = 28.0;
const SAFE_BOTTOM: f32 = 34.0;

/// Line height of a text line, as a multiple of the font size.
const LINE: f32 = 1.4;

/// An RGBA colour (straight alpha).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba(pub u8, pub u8, pub u8, pub u8);

impl Rgba {
    pub const WHITE: Rgba = Rgba(0xff, 0xff, 0xff, 0xff);
    /// An opaque colour.
    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Rgba(r, g, b, 0xff)
    }
    fn paint(self) -> sk::Paint<'static> {
        let mut p = sk::Paint::default();
        p.set_color_rgba8(self.0, self.1, self.2, self.3);
        p.anti_alias = true;
        p
    }
    fn is_visible(self) -> bool {
        self.3 > 0
    }
}

/// What a text leaf needs to be measured by the layout engine.
#[derive(Clone)]
struct TextSpec {
    text: String,
    px: f32,
    wrap: bool,
    bold: bool,
}

/// How an element sits in its parent, which shapes its flex style.
#[derive(Clone, Copy, PartialEq)]
enum Slot {
    /// A flow child of a `Stack` (or a lone child).
    Flow,
    /// A child of a `ScrollArea`: keeps its natural size (does not shrink to the viewport).
    ScrollChild,
    /// Docked to an edge of a `Panel` (Top / Bottom / Left / Right): keeps its natural size along the dock axis.
    DockEdge,
    /// An undocked child of a `Panel`: fills the area the docked children leave.
    DockFill,
    /// A child of a `Panel Layout="Absolute"`, at `X`/`Y` (physical px).
    Absolute(f32, f32),
}

/// Parse `src` as a `.kbview`/`.kbcontrol`, lay it out and paint it into a `width`×`height` pixmap.
///
/// Never panics: the shared parser is error-tolerant; an unparseable or empty view yields a white surface. Unknown
/// controls and attributes are ignored. `None` only when the pixmap itself cannot be allocated (zero size).
pub fn render_view(
    src: &str,
    width: u32,
    height: u32,
    font: Option<&FontHandle>,
    safe_area: Option<(f32, f32)>,
) -> Option<sk::Pixmap> {
    let mut pm = sk::Pixmap::new(width, height)?;
    let Some(root) = Document::cast(parse(src).syntax()).and_then(|d| d.root_element()) else {
        pm.fill(sk::Color::WHITE);
        return Some(pm);
    };
    let dpr = (width as f32 / DESIGN_WIDTH).max(0.1);

    // The screen background fills the whole surface (it shows behind the system bars).
    let bg = attr_color(&root, "BackColor").unwrap_or(Rgba::WHITE);
    pm.fill(sk::Color::from_rgba8(bg.0, bg.1, bg.2, 0xff));

    // The shell may give the real insets (physical px, e.g. iOS safeAreaInsets); otherwise a phone default.
    let (top, bottom) = safe_area.unwrap_or((SAFE_TOP * dpr, SAFE_BOTTOM * dpr));
    let safe_h = (height as f32 - top - bottom).max(1.0);

    let mut tree = TaffyTree::new();
    // Keep fractional positions: everything is drawn anti-aliased, and rounding a text box down by a fraction
    // of a pixel would make it ellipsize text that fits.
    tree.disable_rounding();
    let mut b = Builder { tree, els: HashMap::new(), font, dpr, bottom, hosts: RefCell::new(Vec::new()), item_stack: Vec::new(), texts: HashMap::new() };
    let root_node = b.build_el(&root, Slot::Flow)?;
    // The root fills the safe area.
    if let Ok(style) = b.tree.style(root_node) {
        let mut style = style.clone();
        style.size = Size { width: length(width as f32), height: length(safe_h) };
        let _ = b.tree.set_style(root_node, style);
    }
    b.compute(root_node, width as f32, safe_h);
    b.paint(root_node, 0.0, top, &mut pm, None);

    // Host controls on screen paint their overlay last, on top of the floating content (e.g. a map's data
    // attribution, which must always stay visible).
    let painted = b.hosts.take();
    for name in painted {
        if let Some(control) = crate::host::get(&name) {
            let mut canvas = HostCanvas { pm: &mut pm, clip: None, font, dpr, bottom_inset: bottom };
            control.paint_overlay(&mut canvas);
        }
    }
    Some(pm)
}

/// A tappable target of a view: an element that carries an `x:Name` and/or one or more event attributes
/// (`OnClick`, `OnTextChanged`…), with its laid-out box (physical px). The app hit-tests a tap against these to
/// learn which handler to run - the engine itself stays free of app logic.
#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    /// The element's `x:Name`, if it has one.
    pub name: Option<String>,
    /// Its event handlers, as `(event, handler)` - e.g. `("Click", "search_submit")` for `OnClick="search_submit"`.
    pub events: Vec<(String, String)>,
    /// The laid-out box, physical px.
    pub rect: HostRect,
    /// For an editable text field (`SearchField` / `TextField`, not `ReadOnly`), what kind of field it is: a tap on it
    /// takes the keyboard focus instead of firing a click.
    pub field: Option<FieldSpec>,
    /// For an editable field, its static `Text` (resolved): its value until something is typed.
    pub text: Option<String>,
}

/// The editable-field declaration of an input control, from the shared vocabulary's attributes: `InputType="Password"`
/// (web / mobile) or `UseSystemPasswordChar` / `PasswordChar` (desktop) mask it, `MaxLength` caps it, `TabIndex` orders
/// it, `ReadOnly="true"` makes it not editable. `None` for any other element.
pub(crate) fn field_spec(el: &Element) -> Option<FieldSpec> {
    let control = el.name()?;
    if !matches!(control.as_str(), "SearchField" | "TextField") || attr(el, "ReadOnly").as_deref() == Some("true") {
        return None;
    }
    let password_char = attr(el, "PasswordChar").and_then(|p| p.chars().next());
    let masked = attr(el, "InputType").is_some_and(|t| t.eq_ignore_ascii_case("Password"))
        || attr(el, "UseSystemPasswordChar").as_deref() == Some("true")
        || password_char.is_some();
    Some(FieldSpec {
        control,
        masked,
        mask: password_char.unwrap_or('•'),
        max_len: attr(el, "MaxLength").and_then(|m| m.trim().parse::<usize>().ok()).filter(|m| *m > 0),
        tab_index: attr(el, "TabIndex").and_then(|t| t.trim().parse::<i32>().ok()),
    })
}

/// The event handlers an element declares: `(event name without `On`, handler)`. An event attribute is the shared
/// grammar's rule - `On` followed by an upper-case letter (`OnClick`, `OnTextChanged`).
fn event_handlers(el: &Element) -> Vec<(String, String)> {
    el.attributes()
        .filter_map(|a| {
            let name = a.name()?;
            let rest = name.strip_prefix("On").filter(|r| r.chars().next().is_some_and(|c| c.is_ascii_uppercase()))?;
            let handler = a.value().filter(|v| !v.is_empty())?;
            Some((rest.to_string(), handler))
        })
        .collect()
}

/// The tappable targets of a view: for every element carrying an `x:Name` or an event attribute, its laid-out box
/// (physical px) and its handlers, in paint order (ancestors before descendants) - so [`hit_test`] can take the last
/// (topmost) match. Same layout as [`render_view`]; an unparseable or zero-size view has none.
pub fn view_hits(src: &str, width: u32, height: u32, font: Option<&FontHandle>, safe_area: Option<(f32, f32)>) -> Vec<Hit> {
    if width == 0 || height == 0 {
        return Vec::new();
    }
    let Some(root) = Document::cast(parse(src).syntax()).and_then(|d| d.root_element()) else {
        return Vec::new();
    };
    let dpr = (width as f32 / DESIGN_WIDTH).max(0.1);
    let (top, bottom) = safe_area.unwrap_or((SAFE_TOP * dpr, SAFE_BOTTOM * dpr));
    let safe_h = (height as f32 - top - bottom).max(1.0);
    let mut tree = TaffyTree::new();
    tree.disable_rounding();
    let mut b = Builder { tree, els: HashMap::new(), font, dpr, bottom, hosts: RefCell::new(Vec::new()), item_stack: Vec::new(), texts: HashMap::new() };
    let Some(root_node) = b.build_el(&root, Slot::Flow) else {
        return Vec::new();
    };
    if let Ok(style) = b.tree.style(root_node) {
        let mut style = style.clone();
        style.size = Size { width: length(width as f32), height: length(safe_h) };
        let _ = b.tree.set_style(root_node, style);
    }
    b.compute(root_node, width as f32, safe_h);
    let mut out = Vec::new();
    b.collect_hits(root_node, 0.0, top, &mut out);
    out
}

/// The topmost tappable target containing `(x, y)` (physical px), or `None`. Iterates the paint-ordered list in
/// reverse so a child wins over the ancestor it sits in.
pub fn hit_test(hits: &[Hit], x: f32, y: f32) -> Option<&Hit> {
    hits.iter().rev().find(|h| h.rect.contains(x, y))
}

/// Builds the taffy tree from the element tree, then paints it.
struct Builder<'a> {
    tree: TaffyTree<TextSpec>,
    /// The element behind each layout node (synthetic dock boxes have none).
    els: HashMap<NodeId, Element>,
    font: Option<&'a FontHandle>,
    dpr: f32,
    /// The bottom safe-area inset (physical px), handed to host controls.
    bottom: f32,
    /// The host controls painted in this frame (each once), whose overlays are drawn at the end.
    hosts: RefCell<Vec<String>>,
    /// The repeater item scopes in effect while building a subtree (innermost last); bindings resolve against these,
    /// then the root data context.
    item_stack: Vec<crate::data::Scope>,
    /// The resolved text of each text node (its `{Bind …}` evaluated at build time, with the item scope then active),
    /// used at paint time when the item scope is gone.
    texts: HashMap<NodeId, String>,
}

/// If `raw` is a binding (`{Bind path}` or `{Binding Path=path}` / `{Binding path}`), its path; else `None`.
fn binding_path(raw: &str) -> Option<&str> {
    let inner = raw.trim().strip_prefix('{')?.strip_suffix('}')?.trim();
    let rest = inner.strip_prefix("Binding").or_else(|| inner.strip_prefix("Bind"))?.trim_start();
    let path = rest.strip_prefix("Path=").map(str::trim_start).unwrap_or(rest).trim();
    (!path.is_empty()).then_some(path)
}

impl Builder<'_> {
    // ── Data binding ──────────────────────────────────────────────────────────────────────────────────────

    /// Resolve `{Bind path}` against the current item scopes (innermost first), then the root data context; a plain
    /// string is returned unchanged.
    fn resolve(&self, raw: &str) -> String {
        match binding_path(raw) {
            Some(path) => self.lookup(path).unwrap_or_default(),
            None => raw.to_string(),
        }
    }

    /// The text bound to `path` in the item-scope stack, then the root context.
    fn lookup(&self, path: &str) -> Option<String> {
        for scope in self.item_stack.iter().rev() {
            if let Some(t) = scope.text(path) {
                return Some(t.to_string());
            }
        }
        crate::data::with_root(|r| r.text(path).map(str::to_string))
    }

    /// The list bound to `path` (for a `Repeater`), in the item-scope stack, then the root context.
    fn lookup_list(&self, path: &str) -> Vec<crate::data::Scope> {
        for scope in self.item_stack.iter().rev() {
            if let Some(l) = scope.items(path) {
                return l.to_vec();
            }
        }
        crate::data::with_root(|r| r.items(path).map(<[_]>::to_vec)).unwrap_or_default()
    }

    /// A text element's resolved text (its `Text` attribute or inline content, with any `{Bind …}` evaluated).
    fn text_of(&self, el: &Element) -> String {
        self.resolve(&label_text(el))
    }

    // ── Layout ───────────────────────────────────────────────────────────────────────────────────────────

    /// The flex style shared by every element: explicit size, margin, padding, `Stack.Fill`, and its slot.
    fn base_style(&self, el: &Element, slot: Slot) -> Style {
        let d = self.dpr;
        let mut style = Style {
            size: Size {
                width: attr_f32(el, "Width").map(|v| length(v * d)).unwrap_or(Dimension::Auto),
                height: attr_f32(el, "Height").map(|v| length(v * d)).unwrap_or(Dimension::Auto),
            },
            ..Default::default()
        };
        let m = four(el, "Margin", d);
        style.margin = Rect { left: length(m.0), top: length(m.1), right: length(m.2), bottom: length(m.3) };
        let p = four(el, "Padding", d);
        style.padding = Rect { left: length(p.0), top: length(p.1), right: length(p.2), bottom: length(p.3) };
        // Like `min-width: 0` on the web: a box may shrink below its content (text then ellipsizes / wraps).
        style.min_size = Size { width: length(0.0_f32), height: Dimension::Auto };
        if attr(el, "Stack.Fill").as_deref() == Some("true") {
            style.flex_grow = 1.0;
            style.flex_shrink = 1.0;
            style.flex_basis = length(0.0_f32);
        }
        match slot {
            Slot::Flow => {}
            Slot::ScrollChild | Slot::DockEdge => style.flex_shrink = 0.0,
            Slot::DockFill => {
                style.position = Position::Absolute;
                style.inset = Rect { left: length(0.0_f32), top: length(0.0_f32), right: length(0.0_f32), bottom: length(0.0_f32) };
                style.size = Size { width: Dimension::Auto, height: Dimension::Auto };
            }
            Slot::Absolute(x, y) => {
                style.position = Position::Absolute;
                style.inset = Rect { left: length(x), top: length(y), right: auto(), bottom: auto() };
            }
        }
        style
    }

    /// A fixed-size leaf (icon, avatar, switch…): its natural size, and it never shrinks.
    fn fixed(&mut self, el: &Element, slot: Slot, w: f32, h: f32) -> Option<NodeId> {
        let mut style = self.base_style(el, slot);
        if style.size.width == Dimension::Auto {
            style.size.width = length(w);
        }
        if style.size.height == Dimension::Auto {
            style.size.height = length(h);
        }
        style.flex_shrink = 0.0;
        style.min_size = Size { width: Dimension::Auto, height: Dimension::Auto };
        let node = self.tree.new_leaf(style).ok()?;
        self.els.insert(node, el.clone());
        Some(node)
    }

    /// Build the layout node of `el` (and its subtree).
    fn build_el(&mut self, el: &Element, slot: Slot) -> Option<NodeId> {
        let d = self.dpr;
        let name = el.name().unwrap_or_default();
        match name.as_str() {
            "Label" | "TextBlock" => {
                let style = self.base_style(el, slot);
                // Resolve any `{Bind …}` now, with the current repeater item scope; keep the result for paint time.
                let text = self.text_of(el);
                let spec = TextSpec {
                    text: text.clone(),
                    px: role_px(attr(el, "Role").as_deref()) * d,
                    wrap: attr(el, "Overflow").as_deref() == Some("Wrap"),
                    bold: is_bold(el),
                };
                let node = self.tree.new_leaf_with_context(style, spec).ok()?;
                self.els.insert(node, el.clone());
                self.texts.insert(node, text);
                Some(node)
            }
            "Repeater" => {
                // Expand the template children once per item of the bound list, each with that item scope active, so
                // the subtree is plain nodes the rest of the renderer handles unchanged.
                let path = attr(el, "Items").map(|k| binding_path(&k).unwrap_or(&k).to_string());
                let items = path.map(|p| self.lookup_list(&p)).unwrap_or_default();
                let templates: Vec<Element> = el.children().collect();
                let mut kids: Vec<NodeId> = Vec::new();
                for item in items {
                    self.item_stack.push(item);
                    for t in &templates {
                        if let Some(n) = self.build_el(t, slot) {
                            kids.push(n);
                        }
                    }
                    self.item_stack.pop();
                }
                let mut style = self.base_style(el, slot);
                style.flex_direction = FlexDirection::Column;
                let gap = attr_f32(el, "Gap").unwrap_or(0.0) * d;
                style.gap = Size { width: length(gap), height: length(gap) };
                let node = self.tree.new_with_children(style, &kids).ok()?;
                self.els.insert(node, el.clone());
                Some(node)
            }
            "Icon" => {
                let s = attr_f32(el, "Size").unwrap_or(20.0) * d;
                self.fixed(el, slot, s, s)
            }
            "IconButton" => {
                let s = attr_f32(el, "Diameter").unwrap_or(36.0) * d;
                self.fixed(el, slot, s, s)
            }
            "Avatar" => {
                let s = attr_f32(el, "AvatarSize").unwrap_or(36.0) * d;
                self.fixed(el, slot, s, s)
            }
            "Switch" => self.fixed(el, slot, 40.0 * d, 22.0 * d),
            "Badge" => {
                let px = 11.0 * d;
                let tw = attr(el, "Text").map(|t| text_width(self.font, &t, px, true)).unwrap_or(0.0);
                self.fixed(el, slot, tw + 12.0 * d, 18.0 * d)
            }
            "Button" => {
                let px = button_font_px(attr(el, "Size").as_deref()) * d;
                let tw = attr(el, "Text").map(|t| text_width(self.font, &t, px, true)).unwrap_or(0.0);
                let mut style = self.base_style(el, slot);
                if style.size.height == Dimension::Auto {
                    style.size.height = length(button_height(attr(el, "Size").as_deref()) * d);
                }
                style.min_size = Size { width: length(tw + 2.0 * 22.0 * d), height: Dimension::Auto };
                style.flex_shrink = 0.0;
                let node = self.tree.new_leaf(style).ok()?;
                self.els.insert(node, el.clone());
                Some(node)
            }
            "Separator" => {
                let t = (1.0 * d).max(1.0);
                let mut style = self.base_style(el, slot);
                if attr(el, "Orientation").as_deref() == Some("Vertical") {
                    style.size.width = length(t);
                } else {
                    style.size.height = length(t);
                }
                style.align_self = Some(AlignSelf::Stretch);
                style.flex_shrink = 0.0;
                let node = self.tree.new_leaf(style).ok()?;
                self.els.insert(node, el.clone());
                Some(node)
            }
            "SearchField" | "TextField" | "ProgressBar" => {
                let h = match name.as_str() {
                    "SearchField" => 40.0,
                    "ProgressBar" => 6.0,
                    _ => {
                        if attr(el, "Label").is_some_and(|l| !l.is_empty()) {
                            60.0
                        } else {
                            40.0
                        }
                    }
                } * d;
                let mut style = self.base_style(el, slot);
                if style.size.height == Dimension::Auto {
                    style.size.height = length(h);
                }
                style.flex_shrink = 0.0;
                let node = self.tree.new_leaf(style).ok()?;
                self.els.insert(node, el.clone());
                Some(node)
            }
            "Stack" => {
                let mut style = self.base_style(el, slot);
                style.flex_direction = if attr(el, "Direction").as_deref() == Some("LeftToRight") {
                    FlexDirection::Row
                } else {
                    FlexDirection::Column
                };
                let gap = attr_f32(el, "Gap").unwrap_or(0.0) * d;
                style.gap = Size { width: length(gap), height: length(gap) };
                style.align_items = Some(match attr(el, "CrossAlign").as_deref() {
                    Some("Start") => AlignItems::FlexStart,
                    Some("Center") => AlignItems::Center,
                    Some("End") => AlignItems::FlexEnd,
                    _ => AlignItems::Stretch,
                });
                style.justify_content = match attr(el, "Justify").as_deref() {
                    Some("Center") => Some(JustifyContent::Center),
                    Some("End") => Some(JustifyContent::FlexEnd),
                    Some("SpaceBetween") => Some(JustifyContent::SpaceBetween),
                    _ => None,
                };
                let kids: Vec<NodeId> = el.children().filter_map(|c| self.build_el(&c, Slot::Flow)).collect();
                let node = self.tree.new_with_children(style, &kids).ok()?;
                self.els.insert(node, el.clone());
                Some(node)
            }
            "ScrollArea" => {
                let mut style = self.base_style(el, slot);
                style.flex_direction = FlexDirection::Column;
                style.overflow = taffy::Point { x: Overflow::Hidden, y: Overflow::Hidden };
                style.min_size = Size { width: length(0.0_f32), height: length(0.0_f32) };
                let kids: Vec<NodeId> =
                    el.children().filter_map(|c| self.build_el(&c, Slot::ScrollChild)).collect();
                let node = self.tree.new_with_children(style, &kids).ok()?;
                self.els.insert(node, el.clone());
                Some(node)
            }
            // A Panel / UserControl / Card / unknown box.
            _ => {
                let kids: Vec<Element> = el.children().collect();
                let mut style = self.base_style(el, slot);
                style.flex_direction = FlexDirection::Column;
                let children: Vec<NodeId> = if kids.is_empty() {
                    Vec::new()
                } else if attr(el, "Layout").as_deref() == Some("Absolute") {
                    kids.iter()
                        .filter_map(|c| {
                            let x = attr_f32(c, "X").unwrap_or(0.0) * d;
                            let y = attr_f32(c, "Y").unwrap_or(0.0) * d;
                            self.build_el(c, Slot::Absolute(x, y))
                        })
                        .collect()
                } else {
                    // A background layer (a full-bleed host control, e.g. an app's map) fills the whole panel and
                    // sits behind the docked content, which floats over it; everything else docks / fills the panel
                    // as usual, on top.
                    let (bg, rest): (Vec<Element>, Vec<Element>) = kids
                        .iter()
                        .cloned()
                        .partition(|c| c.name().is_some_and(|n| crate::host::is_background(&n)));
                    let edges: Vec<Element> =
                        rest.iter().filter(|c| dock_edge(c).is_some()).cloned().collect();
                    let fills: Vec<Element> = rest.iter().filter(|c| dock_edge(c).is_none()).cloned().collect();
                    let mut layers: Vec<NodeId> =
                        bg.iter().filter_map(|c| self.build_el(c, Slot::DockFill)).collect();
                    layers.push(self.build_dock(&edges, &fills)?);
                    layers
                };
                let node = self.tree.new_with_children(style, &children).ok()?;
                self.els.insert(node, el.clone());
                Some(node)
            }
        }
    }

    /// A DockPanel as nested flex boxes: the first docked child takes its edge, the rest dock into what remains,
    /// and the undocked children fill (and overlay) the final remaining area.
    fn build_dock(&mut self, edges: &[Element], fills: &[Element]) -> Option<NodeId> {
        let grow = |dir: FlexDirection| Style {
            flex_direction: dir,
            flex_grow: 1.0,
            flex_shrink: 1.0,
            flex_basis: length(0.0_f32),
            min_size: Size { width: length(0.0_f32), height: length(0.0_f32) },
            ..Default::default()
        };
        let Some((first, rest)) = edges.split_first() else {
            let kids: Vec<NodeId> = fills.iter().filter_map(|f| self.build_el(f, Slot::DockFill)).collect();
            return self.tree.new_with_children(grow(FlexDirection::Column), &kids).ok();
        };
        let rest_node = self.build_dock(rest, fills)?;
        let me = self.build_el(first, Slot::DockEdge)?;
        let (dir, kids) = match dock_edge(first) {
            Some("Top") => (FlexDirection::Column, [me, rest_node]),
            Some("Bottom") => (FlexDirection::Column, [rest_node, me]),
            Some("Left") => (FlexDirection::Row, [me, rest_node]),
            _ => (FlexDirection::Row, [rest_node, me]),
        };
        self.tree.new_with_children(grow(dir), &kids).ok()
    }

    /// Run the flexbox layout, measuring text leaves (wrapped to the width they get).
    fn compute(&mut self, root: NodeId, width: f32, height: f32) {
        let font = self.font;
        let _ = self.tree.compute_layout_with_measure(
            root,
            Size { width: AvailableSpace::Definite(width), height: AvailableSpace::Definite(height) },
            |known: Size<Option<f32>>,
             avail: Size<AvailableSpace>,
             _node: NodeId,
             ctx: Option<&mut TextSpec>,
             _style: &Style|
             -> Size<f32> {
                let Some(spec) = ctx else { return Size::ZERO };
                let lh = spec.px * LINE;
                if spec.wrap {
                    let limit = known.width.or(match avail.width {
                        AvailableSpace::Definite(w) => Some(w),
                        AvailableSpace::MinContent => Some(0.0),
                        AvailableSpace::MaxContent => None,
                    });
                    let lines = wrap_lines(font, &spec.text, spec.px, limit, spec.bold);
                    let w = lines.iter().map(|l| text_width(font, l, spec.px, spec.bold)).fold(0.0, f32::max);
                    Size {
                        width: known.width.unwrap_or(w),
                        height: known.height.unwrap_or(lines.len().max(1) as f32 * lh),
                    }
                } else {
                    Size {
                        width: known.width.unwrap_or_else(|| text_width(font, &spec.text, spec.px, spec.bold)),
                        height: known.height.unwrap_or(lh),
                    }
                }
            },
        );
    }

    // ── Paint ────────────────────────────────────────────────────────────────────────────────────────────

    /// Paint `node` (whose parent's origin is `ox`,`oy`) and its subtree.
    fn paint(&self, node: NodeId, ox: f32, oy: f32, pm: &mut sk::Pixmap, clip: Option<&sk::Mask>) {
        let Ok(l) = self.tree.layout(node) else { return };
        let (x, y, w, h) = (ox + l.location.x, oy + l.location.y, l.size.width, l.size.height);
        let children = self.tree.children(node).unwrap_or_default();
        let Some(el) = self.els.get(&node) else {
            for c in children {
                self.paint(c, x, y, pm, clip);
            }
            return;
        };
        let name = el.name().unwrap_or_default();
        let text_override = self.texts.get(&node).map(String::as_str);
        self.paint_element(el, &name, x, y, w, h, pm, clip, text_override);

        if name == "ScrollArea" {
            // Clip the scrolled content to the viewport.
            let mask = sk::Mask::new(pm.width(), pm.height()).and_then(|mut m| {
                let r = sk::Rect::from_xywh(x, y, w.max(1.0), h.max(1.0))?;
                m.fill_path(&sk::PathBuilder::from_rect(r), sk::FillRule::Winding, false, sk::Transform::identity());
                if let Some(parent) = clip {
                    // Intersect with the enclosing clip.
                    let data = m.data_mut();
                    for (a, b) in data.iter_mut().zip(parent.data()) {
                        *a = ((*a as u16 * *b as u16) / 255) as u8;
                    }
                }
                Some(m)
            });
            for c in children {
                self.paint(c, x, y, pm, mask.as_ref().or(clip));
            }
        } else {
            for c in children {
                self.paint(c, x, y, pm, clip);
            }
        }
    }

    /// Collect the tappable targets of `node`'s subtree (same geometry as [`Self::paint`]): every element with an
    /// `x:Name` or an event attribute, with its absolute box. Ancestors before descendants.
    fn collect_hits(&self, node: NodeId, ox: f32, oy: f32, out: &mut Vec<Hit>) {
        let Ok(l) = self.tree.layout(node) else { return };
        let (x, y, w, h) = (ox + l.location.x, oy + l.location.y, l.size.width, l.size.height);
        if let Some(el) = self.els.get(&node) {
            let name = attr(el, "x:Name");
            let events = event_handlers(el);
            let field = field_spec(el);
            if name.is_some() || !events.is_empty() || field.is_some() {
                let text = field.as_ref().map(|_| self.resolve(&attr(el, "Text").unwrap_or_default()));
                out.push(Hit { name, events, rect: HostRect { x, y, w, h }, field, text });
            }
        }
        for c in self.tree.children(node).unwrap_or_default() {
            self.collect_hits(c, x, y, out);
        }
    }

    /// What an input control shows, and whether it holds the keyboard focus: the value typed into it (else its static
    /// `Text`), masked for a password field; `None` when empty (the placeholder then shows). Shared by every input
    /// control, so they all edit, mask and show their caret the same way.
    fn field_text(&self, el: &Element) -> (Option<String>, bool) {
        let name = attr(el, "x:Name");
        let focused = name.as_deref().is_some_and(crate::text_input::is_focused);
        let raw = name
            .as_deref()
            .and_then(crate::text_input::value)
            .or_else(|| attr(el, "Text").map(|t| self.resolve(&t)))
            .filter(|t| !t.is_empty());
        let shown = match (raw, field_spec(el)) {
            (Some(t), Some(spec)) if spec.masked => Some(spec.mask.to_string().repeat(t.chars().count())),
            (raw, _) => raw,
        };
        (shown, focused)
    }

    /// Paint one element's own visuals (its box, or its control drawing) into its layout rect.
    #[allow(clippy::too_many_arguments)]
    fn paint_element(
        &self,
        el: &Element,
        name: &str,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        pm: &mut sk::Pixmap,
        clip: Option<&sk::Mask>,
        text_override: Option<&str>,
    ) {
        let d = self.dpr;
        let font = self.font;
        let grey = Rgba::rgb(0x5f, 0x63, 0x68);
        match name {
            "Label" | "TextBlock" => {
                self.paint_box(el, x, y, w, h, pm, clip);
                let p = four(el, "Padding", d);
                let (ix, iy, iw, ih) = (x + p.0, y + p.1, w - p.0 - p.2, h - p.1 - p.3);
                let px = role_px(attr(el, "Role").as_deref()) * d;
                let color = attr_color(el, "ForeColor").unwrap_or(INK);
                let text = text_override.map(str::to_string).unwrap_or_else(|| label_text(el));
                if text.is_empty() {
                    return;
                }
                let bold = is_bold(el);
                let lines = if attr(el, "Overflow").as_deref() == Some("Wrap") {
                    wrap_lines(font, &text, px, Some(iw), bold)
                } else {
                    vec![ellipsize(font, &text, px, iw, bold)]
                };
                let align = attr(el, "TextAlign").unwrap_or_default();
                self.draw_lines(&lines, px, color, &align, bold, ix, iy, iw, ih, pm, clip);
            }
            "Icon" => {
                let size = attr_f32(el, "Size").unwrap_or(20.0) * d;
                let color = attr_color(el, "ForeColor").unwrap_or(grey);
                draw_icon(pm, &attr(el, "Name").unwrap_or_default(), x, y, w, h, size, color, clip);
            }
            "IconButton" => {
                if let Some(bg) = attr_color(el, "BackColor") {
                    let r = w.min(h) / 2.0;
                    fill_circle(pm, x + w / 2.0, y + h / 2.0, r, bg, clip);
                }
                let size = attr_f32(el, "IconSize").unwrap_or(20.0) * d;
                let color = attr_color(el, "IconColor").unwrap_or(grey);
                draw_icon(pm, &attr(el, "Icon").unwrap_or_default(), x, y, w, h, size, color, clip);
            }
            "Avatar" => {
                let (cx, cy, r) = (x + w / 2.0, y + h / 2.0, w.min(h) / 2.0);
                let display = attr(el, "DisplayName").unwrap_or_default();
                let bg = match attr(el, "Tint").as_deref() {
                    Some("Accent") => Rgba::rgb(0x1a, 0x73, 0xe8),
                    _ if !display.is_empty() => avatar_color(&display),
                    _ => Rgba::rgb(0x9a, 0xa0, 0xa6),
                };
                fill_circle(pm, cx, cy, r, bg, clip);
                let text = attr(el, "Initials").filter(|s| !s.is_empty()).unwrap_or_else(|| initials(&display));
                let px = r * 0.8;
                let tw = text_width(font, &text, px, true);
                draw_text(pm, font, &text, cx - tw / 2.0, cy + px * 0.36, px, Rgba::WHITE, true, clip);
            }
            "Separator" => {
                let color = attr_color(el, "BackColor")
                    .or_else(|| attr_color(el, "ForeColor"))
                    .unwrap_or(Rgba::rgb(0xe0, 0xe0, 0xe0));
                fill_rrect(pm, x, y, x + w, y + h, 0.0, color, clip);
            }
            "SearchField" => {
                let r = h / 2.0;
                fill_rrect(pm, x, y, x + w, y + h, r, Rgba::rgb(0xf1, 0xf3, 0xf4), clip);
                let isize = 18.0 * d;
                let gx = x + 12.0 * d;
                draw_icon(pm, "Search", gx, y, isize, h, isize, grey, clip);
                let (value, focused) = self.field_text(el);
                let (txt, col) = match &value {
                    Some(t) => (t.clone(), Rgba::rgb(0x20, 0x21, 0x24)),
                    None => (attr(el, "Placeholder").unwrap_or_default(), Rgba::rgb(0x80, 0x86, 0x8b)),
                };
                let px = 13.5 * d;
                let tx = gx + isize + 8.0 * d;
                let clear = if value.is_some() && !focused { 18.0 * d + 12.0 * d } else { 12.0 * d };
                let avail = (x + w - clear - tx).max(0.0);
                let line = ellipsize(font, &txt, px, avail, false);
                let cx = (tx + text_width(font, &line, px, false)).min(tx + avail);
                self.draw_lines(&[line], px, col, "MiddleLeft", false, tx, y, w, h, pm, clip);
                if focused {
                    caret(pm, cx, y, h, px, d, clip);
                } else if value.is_some() {
                    let s = 18.0 * d;
                    draw_icon(pm, "X", x + w - s - 12.0 * d, y, s, h, s, grey, clip);
                }
            }
            "TextField" => {
                let mut top = y;
                if let Some(lbl) = attr(el, "Label").filter(|l| !l.is_empty()) {
                    let px = 12.0 * d;
                    self.draw_lines(&[lbl], px, grey, "TopLeft", false, x, y, w, 20.0 * d, pm, clip);
                    top = y + 20.0 * d;
                }
                let fh = y + h - top;
                fill_rrect(pm, x, top, x + w, y + h, 8.0 * d, Rgba::WHITE, clip);
                stroke_rrect(pm, x, top, x + w, y + h, 8.0 * d, 1.0 * d, Rgba::rgb(0xe0, 0xe0, 0xe0), clip);
                let mut tx = x + 12.0 * d;
                if let Some(icon) = attr(el, "LeftIcon").filter(|i| !i.is_empty()) {
                    let s = 18.0 * d;
                    draw_icon(pm, &icon, tx, top, s, fh, s, grey, clip);
                    tx += s + 8.0 * d;
                }
                let (value, focused) = self.field_text(el);
                let (txt, col) = match &value {
                    Some(t) => (t.clone(), Rgba::rgb(0x20, 0x21, 0x24)),
                    None => (attr(el, "Placeholder").unwrap_or_default(), Rgba::rgb(0x80, 0x86, 0x8b)),
                };
                let px = 13.5 * d;
                let avail = (x + w - 12.0 * d - tx).max(0.0);
                let line = ellipsize(font, &txt, px, avail, false);
                let cx = (tx + text_width(font, &line, px, false)).min(tx + avail);
                self.draw_lines(&[line], px, col, "MiddleLeft", false, tx, top, w, fh, pm, clip);
                if focused {
                    caret(pm, cx, top, fh, px, d, clip);
                }
            }
            "Switch" => {
                let on = attr(el, "On").as_deref() == Some("true");
                let track = if on { Rgba::rgb(0x1a, 0x73, 0xe8) } else { Rgba::rgb(0xbd, 0xc1, 0xc6) };
                fill_rrect(pm, x, y, x + w, y + h, h / 2.0, track, clip);
                let kr = h / 2.0 - 3.0 * d;
                let kx = if on { x + w - kr - 3.0 * d } else { x + kr + 3.0 * d };
                fill_circle(pm, kx, y + h / 2.0, kr, Rgba::WHITE, clip);
            }
            "ProgressBar" => {
                fill_rrect(pm, x, y, x + w, y + h, h / 2.0, Rgba::rgb(0xe8, 0xea, 0xed), clip);
                let max = attr_f32(el, "Maximum").unwrap_or(100.0).max(1.0);
                let frac = (attr_f32(el, "Value").unwrap_or(0.0) / max).clamp(0.0, 1.0);
                if frac > 0.0 {
                    fill_rrect(pm, x, y, x + w * frac, y + h, h / 2.0, Rgba::rgb(0x1a, 0x73, 0xe8), clip);
                }
            }
            "Badge" => {
                fill_rrect(pm, x, y, x + w, y + h, h / 2.0, Rgba::rgb(0xd3, 0xe3, 0xfd), clip);
                if let Some(text) = attr(el, "Text") {
                    let px = 11.0 * d;
                    self.draw_lines(&[text], px, Rgba::rgb(0x1a, 0x73, 0xe8), "MiddleCenter", true, x, y, w, h, pm, clip);
                }
            }
            "Button" => {
                let (bg, fg) = variant_colors(attr(el, "Variant").as_deref());
                let r = attr_f32(el, "CornerRadius").map(|v| v * d).unwrap_or(8.0 * d);
                if bg.is_visible() {
                    fill_rrect(pm, x, y, x + w, y + h, r, bg, clip);
                }
                if let Some(text) = attr(el, "Text") {
                    let px = button_font_px(attr(el, "Size").as_deref()) * d;
                    self.draw_lines(&[text], px, fg, "MiddleCenter", true, x, y, w, h, pm, clip);
                }
            }
            _ => match crate::host::get(name) {
                // A control supplied by the app (see `crate::host`): it paints itself, and its overlay is drawn at
                // the end of the frame.
                Some(control) => {
                    let mut canvas = HostCanvas { pm, clip, font, dpr: d, bottom_inset: self.bottom };
                    control.paint(&mut canvas, &HostElement(el), HostRect { x, y, w, h });
                    let mut hosts = self.hosts.borrow_mut();
                    if !hosts.iter().any(|n| n == name) {
                        hosts.push(name.to_string());
                    }
                }
                // A container: its box (shadow, background, border); children are painted by the caller.
                None => self.paint_box(el, x, y, w, h, pm, clip),
            },
        }
    }

    /// An element's box: its elevation shadow, its `BackColor` (or `Surface`) rounded to `CornerRadius`, its border.
    #[allow(clippy::too_many_arguments)]
    fn paint_box(&self, el: &Element, x: f32, y: f32, w: f32, h: f32, pm: &mut sk::Pixmap, clip: Option<&sk::Mask>) {
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        let d = self.dpr;
        let radius = (attr_f32(el, "CornerRadius").unwrap_or(0.0) * d).min(w / 2.0).min(h / 2.0);
        let bg = attr_color(el, "BackColor").or_else(|| surface_color(attr(el, "Surface").as_deref()));
        if let Some(level) = elevation_level(attr(el, "Elevation").as_deref()) {
            draw_shadow(pm, x, y, w, h, radius, level, d, clip);
        }
        if let Some(bg) = bg {
            fill_rrect(pm, x, y, x + w, y + h, radius, bg, clip);
        }
        // A photo background (`Image="key"`): the decoded image, cover-fit and clipped to the box.
        if let Some(key) = attr(el, "Image") {
            if let Some(img) = crate::images::image(&key) {
                draw_image_cover(pm, x, y, w, h, radius, &img, clip);
            }
        }
        if let Some(border) = attr_color(el, "BorderBrush") {
            let bt = attr_f32(el, "BorderThickness").unwrap_or(1.0) * d;
            stroke_rrect(pm, x, y, x + w, y + h, radius, bt, border, clip);
        }
    }

    /// Draw text lines inside a box, aligned by a 9-position `TextAlign` (TopLeft … BottomRight; default TopLeft).
    #[allow(clippy::too_many_arguments)]
    fn draw_lines(
        &self,
        lines: &[String],
        px: f32,
        color: Rgba,
        align: &str,
        bold: bool,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        pm: &mut sk::Pixmap,
        clip: Option<&sk::Mask>,
    ) {
        let font = self.font;
        let lh = px * LINE;
        let (asc, desc) = vmetrics(font, px);
        let total = lines.len() as f32 * lh;
        let top = if align.starts_with("Middle") {
            y + (h - total) / 2.0
        } else if align.starts_with("Bottom") {
            y + h - total
        } else {
            y
        };
        for (i, line) in lines.iter().enumerate() {
            let lw = text_width(font, line, px, bold);
            let lx = if align.ends_with("Center") {
                x + (w - lw) / 2.0
            } else if align.ends_with("Right") {
                x + w - lw
            } else {
                x
            };
            let baseline = top + i as f32 * lh + (lh - (asc + desc)) / 2.0 + asc;
            draw_text(pm, font, line, lx, baseline, px, color, bold, clip);
        }
    }
}

// ── Drawing primitives ──────────────────────────────────────────────────────────────────────────────────

/// A rounded-rectangle path (`r` clamped to half the smaller side; a plain rectangle when ~0).
fn rrect_path(x0: f32, y0: f32, x1: f32, y1: f32, r: f32) -> Option<sk::Path> {
    let (w, h) = (x1 - x0, y1 - y0);
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    if r < 0.01 {
        return Some(sk::PathBuilder::from_rect(sk::Rect::from_ltrb(x0, y0, x1, y1)?));
    }
    let k = 0.552_284_8 * r;
    let mut pb = sk::PathBuilder::new();
    pb.move_to(x0 + r, y0);
    pb.line_to(x1 - r, y0);
    pb.cubic_to(x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r);
    pb.line_to(x1, y1 - r);
    pb.cubic_to(x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1);
    pb.line_to(x0 + r, y1);
    pb.cubic_to(x0 + r - k, y1, x0, y1 - r + k, x0, y1 - r);
    pb.line_to(x0, y0 + r);
    pb.cubic_to(x0, y0 + r - k, x0 + r - k, y0, x0 + r, y0);
    pb.close();
    pb.finish()
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn fill_rrect(pm: &mut sk::Pixmap, x0: f32, y0: f32, x1: f32, y1: f32, r: f32, c: Rgba, clip: Option<&sk::Mask>) {
    if let Some(path) = rrect_path(x0, y0, x1, y1, r) {
        pm.fill_path(&path, &c.paint(), sk::FillRule::Winding, sk::Transform::identity(), clip);
    }
}

/// Draw the text caret of a focused field: a thin vertical bar at `cx`, centred in the `row_h`-tall row from `top`,
/// as tall as the text. Shown by the `SearchField` / `TextField` paint while the field holds the keyboard focus.
fn caret(pm: &mut sk::Pixmap, cx: f32, top: f32, row_h: f32, px: f32, d: f32, clip: Option<&sk::Mask>) {
    let ch = (px * 1.2).min(row_h);
    let cy = top + (row_h - ch) / 2.0;
    let wline = (1.5 * d).max(1.0);
    fill_rrect(pm, cx, cy, cx + wline, cy + ch, 0.0, Rgba::rgb(0x1a, 0x73, 0xe8), clip);
}

#[allow(clippy::too_many_arguments)]
fn stroke_rrect(
    pm: &mut sk::Pixmap,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    r: f32,
    width: f32,
    c: Rgba,
    clip: Option<&sk::Mask>,
) {
    // Inset by half the stroke so the border sits inside the box (crisp, not clipped by neighbours).
    let hw = width / 2.0;
    if let Some(path) = rrect_path(x0 + hw, y0 + hw, x1 - hw, y1 - hw, (r - hw).max(0.0)) {
        let stroke = sk::Stroke { width, ..Default::default() };
        pm.stroke_path(&path, &c.paint(), &stroke, sk::Transform::identity(), clip);
    }
}

pub(crate) fn fill_circle(pm: &mut sk::Pixmap, cx: f32, cy: f32, r: f32, c: Rgba, clip: Option<&sk::Mask>) {
    if let Some(path) = sk::PathBuilder::from_circle(cx, cy, r.max(0.1)) {
        pm.fill_path(&path, &c.paint(), sk::FillRule::Winding, sk::Transform::identity(), clip);
    }
}

/// Draw `img` translated to `(sx, sy)` and uniformly scaled by `scale` (bilinear) - used by host controls (e.g. a map).
pub(crate) fn draw_image_xform(pm: &mut sk::Pixmap, img: &sk::Pixmap, sx: f32, sy: f32, scale: f32, clip: Option<&sk::Mask>) {
    if scale <= 0.0 {
        return;
    }
    let paint = sk::PixmapPaint { quality: sk::FilterQuality::Bilinear, ..Default::default() };
    let tf = sk::Transform::from_row(scale, 0.0, 0.0, scale, sx, sy);
    pm.draw_pixmap(0, 0, img.as_ref(), &paint, tf, clip);
}

/// Stroke a polyline (round caps/joins) - used by host controls (e.g. a route line).
pub(crate) fn stroke_polyline(pm: &mut sk::Pixmap, pts: &[(f32, f32)], width: f32, c: Rgba, clip: Option<&sk::Mask>) {
    if pts.len() < 2 {
        return;
    }
    let mut pb = sk::PathBuilder::new();
    pb.move_to(pts[0].0, pts[0].1);
    for &(px, py) in &pts[1..] {
        pb.line_to(px, py);
    }
    if let Some(path) = pb.finish() {
        let stroke = sk::Stroke { width, line_cap: sk::LineCap::Round, line_join: sk::LineJoin::Round, ..Default::default() };
        pm.stroke_path(&path, &c.paint(), &stroke, sk::Transform::identity(), clip);
    }
}

/// Draw an image to cover the box `[x,y,w,h]` (scaled to fill, centre-cropped), clipped to its rounded corners.
#[allow(clippy::too_many_arguments)]
fn draw_image_cover(pm: &mut sk::Pixmap, x: f32, y: f32, w: f32, h: f32, radius: f32, img: &sk::Pixmap, clip: Option<&sk::Mask>) {
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    let (iw, ih) = (img.width() as f32, img.height() as f32);
    if iw <= 0.0 || ih <= 0.0 {
        return;
    }
    let scale = (w / iw).max(h / ih);
    let (ox, oy) = (x + (w - iw * scale) / 2.0, y + (h - ih * scale) / 2.0);
    let shader = sk::Pattern::new(
        img.as_ref(),
        sk::SpreadMode::Pad,
        sk::FilterQuality::Bilinear,
        1.0,
        sk::Transform::from_translate(ox, oy).pre_scale(scale, scale),
    );
    let paint = sk::Paint { shader, anti_alias: true, ..Default::default() };
    if let Some(path) = rrect_path(x, y, x + w, y + h, radius) {
        pm.fill_path(&path, &paint, sk::FillRule::Winding, sk::Transform::identity(), clip);
    }
}

/// A soft drop shadow: the box's silhouette rendered into a scratch pixmap, Gaussian-blurred (three box-blur
/// passes) and composited, slightly offset down, at an opacity that grows with the elevation.
#[allow(clippy::too_many_arguments)]
fn draw_shadow(pm: &mut sk::Pixmap, x: f32, y: f32, w: f32, h: f32, radius: f32, level: f32, dpr: f32, clip: Option<&sk::Mask>) {
    let sigma = (level * 0.6 * dpr).max(1.0);
    let off = level * 0.3 * dpr;
    let pad = (sigma * 2.6).ceil();
    let sw = (w + 2.0 * pad).ceil() as usize;
    let sh = (h + 2.0 * pad).ceil() as usize;
    if sw == 0 || sh == 0 || sw > 8192 || sh > 8192 {
        return;
    }
    let Some(mut sp) = sk::Pixmap::new(sw as u32, sh as u32) else { return };
    if let Some(path) = rrect_path(pad, pad, pad + w, pad + h, radius) {
        sp.fill_path(&path, &Rgba(0, 0, 0, 0xff).paint(), sk::FillRule::Winding, sk::Transform::identity(), None);
    }
    let mut a: Vec<u8> = sp.data().as_chunks::<4>().0.iter().map(|p| p[3]).collect();
    let r = ((sigma - 0.5).round() as usize).max(1);
    for _ in 0..3 {
        box_blur_h(&mut a, sw, sh, r);
        box_blur_v(&mut a, sw, sh, r);
    }
    for (px, av) in sp.data_mut().as_chunks_mut::<4>().0.iter_mut().zip(a) {
        px[0] = 0;
        px[1] = 0;
        px[2] = 0;
        px[3] = av;
    }
    let opacity = (0.12 + level * 0.009).min(0.26);
    let paint = sk::PixmapPaint { opacity, ..Default::default() };
    pm.draw_pixmap(
        (x - pad).round() as i32,
        (y - pad + off).round() as i32,
        sp.as_ref(),
        &paint,
        sk::Transform::identity(),
        clip,
    );
}

/// One horizontal box-blur pass of radius `r` over an alpha plane (`w`×`h`), outside treated as transparent.
fn box_blur_h(a: &mut [u8], w: usize, h: usize, r: usize) {
    let div = (2 * r + 1) as u32;
    let mut row = vec![0u8; w];
    for y in 0..h {
        row.copy_from_slice(&a[y * w..(y + 1) * w]);
        let mut sum: u32 = row[..=r.min(w - 1)].iter().map(|v| *v as u32).sum();
        for x in 0..w {
            a[y * w + x] = (sum / div) as u8;
            if x + r + 1 < w {
                sum += row[x + r + 1] as u32;
            }
            if x >= r {
                sum -= row[x - r] as u32;
            }
        }
    }
}

/// One vertical box-blur pass (see [`box_blur_h`]).
fn box_blur_v(a: &mut [u8], w: usize, h: usize, r: usize) {
    let div = (2 * r + 1) as u32;
    let mut col = vec![0u8; h];
    for x in 0..w {
        for y in 0..h {
            col[y] = a[y * w + x];
        }
        let mut sum: u32 = col[..=r.min(h - 1)].iter().map(|v| *v as u32).sum();
        for y in 0..h {
            a[y * w + x] = (sum / div) as u8;
            if y + r + 1 < h {
                sum += col[y + r + 1] as u32;
            }
            if y >= r {
                sum -= col[y - r] as u32;
            }
        }
    }
}

/// Stroke a Lucide icon's outline(s) centred in the box, scaled to `size` (physical px), in `color`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_icon(pm: &mut sk::Pixmap, name: &str, x: f32, y: f32, w: f32, h: f32, size: f32, color: Rgba, clip: Option<&sk::Mask>) {
    let Some(paths) = icon_paths(name) else { return };
    let scale = size / 24.0;
    let tf = sk::Transform::from_row(scale, 0.0, 0.0, scale, x + (w - size) / 2.0, y + (h - size) / 2.0);
    // Lucide: a 2-unit stroke on the 24 grid, round caps and joins (scaled with the transform).
    let stroke = sk::Stroke { width: 2.0, line_cap: sk::LineCap::Round, line_join: sk::LineJoin::Round, ..Default::default() };
    let paint = color.paint();
    for d in paths {
        if let Some(path) = BezPath::from_svg(d).ok().and_then(|b| kurbo_to_skia(&b)) {
            pm.stroke_path(&path, &paint, &stroke, tf, clip);
        }
    }
}

fn kurbo_to_skia(b: &BezPath) -> Option<sk::Path> {
    let mut pb = sk::PathBuilder::new();
    for el in b.elements() {
        match *el {
            PathEl::MoveTo(p) => pb.move_to(p.x as f32, p.y as f32),
            PathEl::LineTo(p) => pb.line_to(p.x as f32, p.y as f32),
            PathEl::QuadTo(a, p) => pb.quad_to(a.x as f32, a.y as f32, p.x as f32, p.y as f32),
            PathEl::CurveTo(a, c, p) => {
                pb.cubic_to(a.x as f32, a.y as f32, c.x as f32, c.y as f32, p.x as f32, p.y as f32)
            }
            PathEl::ClosePath => pb.close(),
        }
    }
    pb.finish()
}

// ── Text ────────────────────────────────────────────────────────────────────────────────────────────────

/// The ink colour for text with no `ForeColor`.
const INK: Rgba = Rgba::rgb(0x1a, 0x1a, 0x1a);

/// Collects a glyph's outline into a tiny-skia path, at a pen position (font units are y-up, the pixmap y-down).
struct SkiaPen<'a> {
    pb: &'a mut sk::PathBuilder,
    dx: f32,
    dy: f32,
}

impl OutlinePen for SkiaPen<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        self.pb.move_to(self.dx + x, self.dy - y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.pb.line_to(self.dx + x, self.dy - y);
    }
    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        self.pb.quad_to(self.dx + cx0, self.dy - cy0, self.dx + x, self.dy - y);
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        self.pb.cubic_to(self.dx + cx0, self.dy - cy0, self.dx + cx1, self.dy - cy1, self.dx + x, self.dy - y);
    }
    fn close(&mut self) {
        self.pb.close();
    }
}

/// Draw one line of text with its left edge at `x` and its baseline at `baseline`. Characters the font lacks
/// (e.g. emoji) are skipped rather than drawn as a `.notdef` box.
#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_text(
    pm: &mut sk::Pixmap,
    font: Option<&FontHandle>,
    text: &str,
    x: f32,
    baseline: f32,
    px: f32,
    color: Rgba,
    bold: bool,
    clip: Option<&sk::Mask>,
) {
    let Some(font) = font else { return };
    let Ok(fr) = FontRef::from_index(font.data(bold), 0) else { return };
    let size = FontSize::new(px);
    let loc = LocationRef::default();
    let charmap = fr.charmap();
    let metrics = fr.glyph_metrics(size, loc);
    let outlines = fr.outline_glyphs();
    let mut pb = sk::PathBuilder::new();
    let mut pen_x = x;
    for c in text.chars() {
        let Some(gid) = charmap.map(c).filter(|g| g.to_u32() != 0) else {
            pen_x += px * 0.3;
            continue;
        };
        if let Some(glyph) = outlines.get(gid) {
            let mut pen = SkiaPen { pb: &mut pb, dx: pen_x, dy: baseline };
            let _ = glyph.draw(DrawSettings::unhinted(size, loc), &mut pen);
        }
        pen_x += metrics.advance_width(gid).unwrap_or(px * 0.5);
    }
    if let Some(path) = pb.finish() {
        let paint = color.paint();
        pm.fill_path(&path, &paint, sk::FillRule::Winding, sk::Transform::identity(), clip);
        // Faux bold: with no real bold face, stroke the glyph outlines to thicken them.
        if bold && !font.has_bold() {
            let stroke = sk::Stroke { width: (px * 0.045).max(0.6), ..Default::default() };
            pm.stroke_path(&path, &paint, &stroke, sk::Transform::identity(), clip);
        }
    }
}

/// The advance width of `text` at `px` (physical), in the regular or bold face.
pub(crate) fn text_width(font: Option<&FontHandle>, text: &str, px: f32, bold: bool) -> f32 {
    let fallback = || text.chars().count() as f32 * px * 0.5;
    let Some(font) = font else { return fallback() };
    let Ok(fr) = FontRef::from_index(font.data(bold), 0) else { return fallback() };
    let charmap = fr.charmap();
    let metrics = fr.glyph_metrics(FontSize::new(px), LocationRef::default());
    text.chars()
        .map(|c| match charmap.map(c).filter(|g| g.to_u32() != 0) {
            Some(gid) => metrics.advance_width(gid).unwrap_or(px * 0.5),
            None => px * 0.3,
        })
        .sum()
}

/// Ascent and descent (both positive) at `px` (regular face; the bold face shares the line box).
fn vmetrics(font: Option<&FontHandle>, px: f32) -> (f32, f32) {
    font.and_then(|f| FontRef::from_index(f.data(false), 0).ok())
        .map(|fr| {
            let m = fr.metrics(FontSize::new(px), LocationRef::default());
            (m.ascent, -m.descent)
        })
        .unwrap_or((px * 0.8, px * 0.2))
}

/// Greedy word wrap to `limit` (physical px); `None` keeps the explicit line breaks only.
fn wrap_lines(font: Option<&FontHandle>, text: &str, px: f32, limit: Option<f32>, bold: bool) -> Vec<String> {
    let Some(limit) = limit else { return text.split('\n').map(str::to_string).collect() };
    let mut out = Vec::new();
    for para in text.split('\n') {
        let mut cur = String::new();
        for word in para.split(' ').filter(|w| !w.is_empty()) {
            let candidate = if cur.is_empty() { word.to_string() } else { format!("{cur} {word}") };
            if cur.is_empty() || text_width(font, &candidate, px, bold) <= limit + 0.5 {
                cur = candidate;
            } else {
                out.push(std::mem::take(&mut cur));
                cur = word.to_string();
            }
        }
        out.push(cur);
    }
    out
}

/// `text` shortened with a trailing ellipsis so it fits in `max_w` (unchanged when it already fits).
fn ellipsize(font: Option<&FontHandle>, text: &str, px: f32, max_w: f32, bold: bool) -> String {
    if text_width(font, text, px, bold) <= max_w + 1.0 {
        return text.to_string();
    }
    let mut chars: Vec<char> = text.chars().collect();
    while chars.pop().is_some() {
        let candidate = format!("{}…", chars.iter().collect::<String>().trim_end());
        if text_width(font, &candidate, px, bold) <= max_w + 0.5 {
            return candidate;
        }
    }
    "…".to_string()
}

/// Whether a control's `FontWeight` reads as bold (SemiBold and up; Medium stays regular to avoid over-bolding).
fn is_bold(el: &Element) -> bool {
    matches!(attr(el, "FontWeight").as_deref(), Some("SemiBold" | "Bold" | "ExtraBold" | "Black"))
}

// ── Vocabulary → pixels ─────────────────────────────────────────────────────────────────────────────────

/// Logical font size (px) of a `Label` role - the Kubuno typography scale (theme values, like the web).
fn role_px(role: Option<&str>) -> f32 {
    match role.unwrap_or("Body") {
        "Micro" => 10.5,
        "Meta" | "Caption" => 12.0,
        "Badge" => 11.0,
        "Body" => 13.5,
        "Heading" => 15.5,
        "Subtitle" => 16.0,
        "Title" => 21.5,
        "Display" => 24.0,
        _ => 13.5,
    }
}

fn button_font_px(size: Option<&str>) -> f32 {
    match size.unwrap_or("Md") {
        "Sm" => 12.5,
        "Lg" => 15.0,
        _ => 13.5,
    }
}

fn button_height(size: Option<&str>) -> f32 {
    match size.unwrap_or("Md") {
        "Sm" => 28.0,
        "Lg" => 44.0,
        _ => 36.0,
    }
}

/// A button's (background, foreground) for its `Variant`, as the default Kubuno theme renders them.
fn variant_colors(variant: Option<&str>) -> (Rgba, Rgba) {
    match variant.unwrap_or("Primary") {
        "Secondary" => (Rgba::rgb(0xee, 0xee, 0xf2), Rgba::rgb(0x1e, 0x1e, 0x1e)),
        "Danger" => (Rgba::rgb(0xd9, 0x30, 0x25), Rgba::WHITE),
        "Ghost" | "Text" => (Rgba(0, 0, 0, 0), Rgba::rgb(0x1a, 0x73, 0xe8)),
        // Primary (default): the theme accent, white label.
        _ => (Rgba::rgb(0x1a, 0x73, 0xe8), Rgba::WHITE),
    }
}

/// The elevation level of an `Elevation` value (drives the shadow's blur, offset and opacity).
fn elevation_level(elevation: Option<&str>) -> Option<f32> {
    match elevation? {
        "Sm" => Some(3.0),
        "Md" => Some(7.0),
        "Lg" => Some(13.0),
        _ => None,
    }
}

/// A theme surface colour (`Surface` property), as a fallback when no `BackColor` is given.
fn surface_color(surface: Option<&str>) -> Option<Rgba> {
    Some(match surface? {
        "Card" | "Raised" => Rgba::WHITE,
        "Layer" => Rgba::rgb(0xf5, 0xf5, 0xf7),
        "Well" => Rgba::rgb(0xee, 0xee, 0xf2),
        _ => return None,
    })
}

/// Resolve a Kubuno colour value: a theme token (default-theme values) or a literal `#RRGGBB`/`#AARRGGBB`.
fn attr_color(el: &Element, name: &str) -> Option<Rgba> {
    let v = attr(el, name)?;
    let v = v.trim();
    if v.starts_with('#') {
        return parse_hex_color(v);
    }
    // The token may carry an opacity suffix (`Token/NN`); ignore it for now.
    Some(match v.split('/').next().unwrap_or(v) {
        "Background" => Rgba::rgb(0x12, 0x12, 0x16),
        "Surface" | "Surface0" => Rgba::WHITE,
        "Surface1" => Rgba::rgb(0xf5, 0xf5, 0xf7),
        "Surface2" => Rgba::rgb(0xee, 0xee, 0xf2),
        "Surface3" => Rgba::rgb(0xe4, 0xe4, 0xea),
        "Primary" => Rgba::rgb(0x0e, 0x70, 0xc0),
        "PrimaryLight" => Rgba::rgb(0xd6, 0xe6, 0xf7),
        "OnPrimary" => Rgba::WHITE,
        "Success" => Rgba::rgb(0x1e, 0x8e, 0x3e),
        "Danger" => Rgba::rgb(0xd9, 0x30, 0x25),
        "Warning" => Rgba::rgb(0xe3, 0x74, 0x00),
        "TextPrimary" => Rgba::rgb(0x1a, 0x1a, 0x1a),
        "TextSecondary" => Rgba::rgb(0x5f, 0x5f, 0x5f),
        "TextTertiary" => Rgba::rgb(0x90, 0x90, 0x90),
        "Border" => Rgba::rgb(0xcc, 0xce, 0xd3),
        _ => return None,
    })
}

fn parse_hex_color(s: &str) -> Option<Rgba> {
    let s = s.trim().strip_prefix('#')?;
    let byte = |i: usize| u8::from_str_radix(s.get(i..i + 2)?, 16).ok();
    match s.len() {
        6 => Some(Rgba::rgb(byte(0)?, byte(2)?, byte(4)?)),
        8 => Some(Rgba(byte(2)?, byte(4)?, byte(6)?, byte(0)?)),
        _ => None,
    }
}

/// Up to two uppercase initials from a display name (split on space, `@`, `.`); `?` when empty.
fn initials(name: &str) -> String {
    let s: String = name
        .split(|c: char| c.is_whitespace() || c == '@' || c == '.')
        .filter(|p| !p.is_empty())
        .take(2)
        .filter_map(|p| p.chars().next())
        .flat_map(|c| c.to_uppercase())
        .collect();
    if s.is_empty() {
        "?".to_string()
    } else {
        s
    }
}

/// A stable avatar background colour hashed from a name, matching the Kubuno avatar palette (the same eight
/// tints the web/desktop avatars use), so a list of people reads as distinct dots rather than a wall of grey.
fn avatar_color(name: &str) -> Rgba {
    const PALETTE: &[Rgba] = &[
        Rgba::rgb(0x1a, 0x73, 0xe8),
        Rgba::rgb(0xd9, 0x30, 0x25),
        Rgba::rgb(0x1e, 0x8e, 0x3e),
        Rgba::rgb(0x93, 0x34, 0xe6),
        Rgba::rgb(0xe8, 0x71, 0x0a),
        Rgba::rgb(0x12, 0xb5, 0xcb),
        Rgba::rgb(0xd0, 0x18, 0x84),
        Rgba::rgb(0xf9, 0xab, 0x00),
    ];
    let hash = name.bytes().fold(0u32, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u32));
    PALETTE[(hash as usize) % PALETTE.len()]
}

// ── Attribute helpers ───────────────────────────────────────────────────────────────────────────────────

pub(crate) fn attr(el: &Element, name: &str) -> Option<String> {
    el.attribute(name).and_then(|a| a.value())
}

fn attr_f32(el: &Element, name: &str) -> Option<f32> {
    attr(el, name).and_then(|v| v.trim().parse::<f32>().ok())
}

fn label_text(el: &Element) -> String {
    attr(el, "Text").unwrap_or_else(|| el.text().trim().to_string())
}

/// The edge a `Panel` child docks to, if any (`Fill` / none = fills the remaining area).
fn dock_edge(el: &Element) -> Option<&'static str> {
    match attr(el, "Dock").as_deref() {
        Some("Top") => Some("Top"),
        Some("Bottom") => Some("Bottom"),
        Some("Left") => Some("Left"),
        Some("Right") => Some("Right"),
        _ => None,
    }
}

/// A four-sided attribute (`Padding` / `Margin`) as physical px (left, top, right, bottom): one value (all
/// sides), two (vertical, horizontal) or four.
fn four(el: &Element, name: &str, dpr: f32) -> (f32, f32, f32, f32) {
    let Some(v) = attr(el, name) else { return (0.0, 0.0, 0.0, 0.0) };
    let parts: Vec<f32> = v.split(',').filter_map(|p| p.trim().parse::<f32>().ok()).map(|p| p * dpr).collect();
    match parts.as_slice() {
        [all] => (*all, *all, *all, *all),
        [l, t, r, b] => (*l, *t, *r, *b),
        [v0, h0] => (*h0, *v0, *h0, *v0),
        _ => (0.0, 0.0, 0.0, 0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hex_and_tokens() {
        assert_eq!(parse_hex_color("#6e59f0"), Some(Rgba::rgb(0x6e, 0x59, 0xf0)));
        assert_eq!(parse_hex_color("#806e59f0"), Some(Rgba(0x6e, 0x59, 0xf0, 0x80)));
        assert!(role_px(Some("Display")) > role_px(Some("Body")));
    }

    #[test]
    fn hits_carry_names_and_events_and_hit_test_finds_the_topmost() {
        let src = r#"<Panel xmlns="https://kubuno.com/views" xmlns:x="https://kubuno.com/views/x" Layout="Absolute">
            <Stack x:Name="go" OnClick="do_go" X="20" Y="100" Width="120" Height="48"/>
            <Stack x:Name="stop" OnClick="do_stop" OnLongPress="hold" X="20" Y="200" Width="120" Height="48"/>
          </Panel>"#;
        let hits = view_hits(src, 390, 400, None, Some((0.0, 0.0)));
        // Both tappable elements are collected, with their handlers (and the unnamed root Panel is not).
        let go = hits.iter().find(|h| h.name.as_deref() == Some("go")).expect("go hit");
        assert_eq!(go.events, vec![("Click".to_string(), "do_go".to_string())]);
        let stop = hits.iter().find(|h| h.name.as_deref() == Some("stop")).expect("stop hit");
        assert!(stop.events.contains(&("Click".to_string(), "do_stop".to_string())));
        assert!(stop.events.contains(&("LongPress".to_string(), "hold".to_string())));
        // A tap inside a box resolves to it; a tap on empty space (only the nameless Panel) resolves to nothing.
        assert_eq!(hit_test(&hits, 80.0, 120.0).and_then(|h| h.name.as_deref()), Some("go"));
        assert_eq!(hit_test(&hits, 80.0, 220.0).and_then(|h| h.name.as_deref()), Some("stop"));
        assert!(hit_test(&hits, 300.0, 380.0).is_none());
    }

    #[test]
    fn input_controls_declare_their_field_kind_from_the_shared_attributes() {
        let src = r#"<Panel xmlns="https://kubuno.com/views" xmlns:x="https://kubuno.com/views/x" Layout="Absolute">
            <TextField x:Name="login" X="0" Y="0" Width="200" Height="40" TabIndex="1" Text="zoe"/>
            <TextField x:Name="password" InputType="Password" MaxLength="64" X="0" Y="50" Width="200" Height="40"/>
            <TextField x:Name="pin" PasswordChar="*" X="0" Y="100" Width="200" Height="40"/>
            <TextField x:Name="locked" ReadOnly="true" X="0" Y="150" Width="200" Height="40"/>
            <SearchField x:Name="query" OnSearch="run" X="0" Y="200" Width="200" Height="40"/>
          </Panel>"#;
        let hits = view_hits(src, 390, 400, None, Some((0.0, 0.0)));
        let spec = |n: &str| hits.iter().find(|h| h.name.as_deref() == Some(n)).and_then(|h| h.field.clone());
        let login = spec("login").expect("login is editable");
        assert!(!login.masked);
        assert_eq!(login.tab_index, Some(1));
        let password = spec("password").expect("password is editable");
        assert!(password.masked && password.mask == '•' && password.max_len == Some(64));
        assert_eq!(spec("pin").map(|s| (s.masked, s.mask)), Some((true, '*')));
        assert!(spec("locked").is_none(), "ReadOnly is not editable");
        assert_eq!(spec("query").map(|s| s.control), Some("SearchField".to_string()));
        let login_hit = hits.iter().find(|h| h.name.as_deref() == Some("login")).expect("hit");
        assert_eq!(login_hit.text.as_deref(), Some("zoe"), "the static Text seeds the value");
        // A password field paints its mask, never the text.
        crate::text_input::set_value("password", "secret");
        assert!(render_view(src, 390, 400, None, Some((0.0, 0.0))).is_some());
    }

    #[test]
    fn repeater_expands_per_item_and_bindings_resolve() {
        use crate::{set_data, Scope};
        assert_eq!(binding_path("{Bind name}"), Some("name"));
        assert_eq!(binding_path("{Binding Path=title}"), Some("title"));
        assert_eq!(binding_path("{Binding detail}"), Some("detail"));
        assert_eq!(binding_path("plain text"), None);
        set_data(
            Scope::new().set("title", "Résultats").list(
                "rows",
                vec![Scope::new().set("name", "A"), Scope::new().set("name", "B"), Scope::new().set("name", "C")],
            ),
        );
        let src = r#"<Panel xmlns="https://kubuno.com/views" xmlns:x="https://kubuno.com/views/x">
            <Repeater Items="rows">
                <Stack x:Name="row" OnClick="pick" Width="200" Height="40"><Label Text="{Bind name}"/></Stack>
            </Repeater>
          </Panel>"#;
        // The template is built once per item, with each item scope active for its `{Bind name}`.
        let hits = view_hits(src, 390, 800, None, Some((0.0, 0.0)));
        assert_eq!(hits.iter().filter(|h| h.name.as_deref() == Some("row")).count(), 3);
        assert!(render_view(src, 390, 800, None, Some((0.0, 0.0))).is_some());
    }

    #[test]
    fn renders_the_sample_and_an_empty_view_without_panicking() {
        assert!(render_view(crate::SAMPLE_KBVIEW, 1080, 2340, None, None).is_some());
        assert!(render_view("", 100, 100, None, None).is_some());
    }

    #[test]
    fn an_image_registered_by_the_app_fills_its_box() {
        // A box naming `Image="swatch"` shows the white page until the app registers a JPEG under that key.
        const SAMPLE_JPEG: &[u8] = include_bytes!("../tests/fixtures/sample.jpg");
        let src = r#"<Panel xmlns="https://kubuno.com/views" Layout="Absolute">
            <Stack X="0" Y="0" Width="100" Height="100" Image="swatch"/>
          </Panel>"#;
        let white = |pm: &sk::Pixmap| {
            (10..90).step_by(8).all(|i| {
                let p = pm.pixel(i, i).expect("pixel");
                (p.red(), p.green(), p.blue()) == (0xff, 0xff, 0xff)
            })
        };
        let before = render_view(src, 390, 400, None, Some((0.0, 0.0))).expect("render");
        assert!(white(&before), "no image registered yet: the page shows");
        crate::register_image("swatch", SAMPLE_JPEG);
        let after = render_view(src, 390, 400, None, Some((0.0, 0.0))).expect("render");
        assert!(!white(&after), "the registered image covers its box");
    }

    #[test]
    fn stack_fill_splits_a_row_evenly() {
        // Four Stack.Fill tiles in a row share the width equally (the Photos grid).
        let src = r#"<Panel xmlns="https://kubuno.com/views" Layout="Dock">
            <Stack Dock="Top" Direction="LeftToRight" Gap="2">
              <Stack Stack.Fill="true" Height="90"/><Stack Stack.Fill="true" Height="90"/>
              <Stack Stack.Fill="true" Height="90"/><Stack Stack.Fill="true" Height="90"/>
            </Stack></Panel>"#;
        let root = Document::cast(parse(src).syntax()).and_then(|d| d.root_element()).expect("root");
        let mut b = Builder {
            tree: TaffyTree::new(),
            els: HashMap::new(),
            font: None,
            dpr: 1.0,
            bottom: 0.0,
            hosts: RefCell::new(Vec::new()),
            item_stack: Vec::new(),
            texts: HashMap::new(),
        };
        let node = b.build_el(&root, Slot::Flow).expect("node");
        let mut style = b.tree.style(node).expect("style").clone();
        style.size = Size { width: length(390.0_f32), height: length(800.0_f32) };
        b.tree.set_style(node, style).expect("set");
        b.compute(node, 390.0, 800.0);
        let widths: Vec<f32> = b
            .els
            .iter()
            .filter(|(_, e)| attr(e, "Stack.Fill").is_some())
            .map(|(n, _)| b.tree.layout(*n).expect("layout").size.width)
            .collect();
        assert_eq!(widths.len(), 4);
        for w in &widths {
            assert!((w - (390.0 - 6.0) / 4.0).abs() < 0.5, "tile width {w}");
        }
    }

    /// A test host control: fills the whole surface red (as a full-bleed background) and stamps a blue overlay
    /// square at the top-left, counting its paints.
    struct Probe(std::rc::Rc<std::cell::Cell<u32>>);

    impl crate::HostControl for Probe {
        fn is_background(&self) -> bool {
            true
        }
        fn paint(&self, canvas: &mut HostCanvas<'_, '_>, el: &HostElement<'_>, _rect: HostRect) {
            assert_eq!(el.attr("Tone").as_deref(), Some("red"));
            let (w, h) = (canvas.width(), canvas.height());
            canvas.fill_rect(0.0, 0.0, w, h, 0.0, Rgba::rgb(0xff, 0x00, 0x00));
            self.0.set(self.0.get() + 1);
        }
        fn paint_overlay(&self, canvas: &mut HostCanvas<'_, '_>) {
            canvas.fill_rect(0.0, 0.0, 4.0, 4.0, 0.0, Rgba::rgb(0x00, 0x00, 0xff));
        }
    }

    #[test]
    fn host_control_paints_behind_docked_content_and_draws_its_overlay() {
        let paints = std::rc::Rc::new(std::cell::Cell::new(0));
        crate::register_host_control("ProbeView", Probe(paints.clone()));
        // The probe is a background layer under a white bar docked at the top.
        let src = r##"<Panel xmlns="https://kubuno.com/views">
            <ProbeView Tone="red"/>
            <Stack Dock="Top" Height="40" BackColor="#ffffff"/>
          </Panel>"##;
        // 390 px wide = 1 physical px per design px, so the bar is exactly 40 px tall.
        let pm = render_view(src, 390, 800, None, Some((0.0, 0.0))).expect("render");
        assert_eq!(paints.get(), 1, "the host control paints once");
        let px = |x: u32, y: u32| pm.pixel(x, y).expect("pixel");
        let (overlay, bar, map) = (px(1, 1), px(195, 20), px(195, 600));
        assert_eq!((overlay.red(), overlay.blue()), (0x00, 0xff), "overlay drawn last, on top");
        assert_eq!((bar.red(), bar.green(), bar.blue()), (0xff, 0xff, 0xff), "docked bar over the layer");
        assert_eq!((map.red(), map.green(), map.blue()), (0xff, 0x00, 0x00), "layer fills the rest");
    }
}
