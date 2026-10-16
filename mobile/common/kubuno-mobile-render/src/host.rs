//! Host controls: elements of a `.kbview` the renderer does not draw itself, supplied by the app.
//!
//! The renderer paints the shared control vocabulary (`Panel`, `Stack`, `Label`, `Button`…). A module's app adds its
//! own controls - Maps' `MapView`, for instance - by implementing [`HostControl`] and registering it under the
//! element name it answers to ([`register_host_control`]), from its [`crate::App::setup`]. The renderer then lays
//! the element out like any other, asks the control to paint itself through a [`HostCanvas`], and routes the
//! shell's touch gestures to it ([`pan`], [`zoom`], [`reset`]). The renderer itself stays free of any module's
//! code, data or assets.
//!
//! The registry is per thread: the shells register, render and dispatch gestures on their one UI thread.

use std::cell::RefCell;
use std::rc::Rc;

use kubuno_desktop_views_syntax::ast::Element;
use tiny_skia as sk;

use crate::view::Rgba;
use crate::FontHandle;

/// A control drawn by the app rather than by the renderer (see the module doc).
pub trait HostControl {
    /// Whether the control is a full-bleed background layer: as a child of a `Panel`, it fills the whole panel and
    /// sits behind the docked content, which floats over it (a map under its search bar and sheets).
    fn is_background(&self) -> bool {
        false
    }

    /// Paint the control. `rect` is its laid-out box (physical px); a background control may paint the whole
    /// surface ([`HostCanvas::width`] × [`HostCanvas::height`]) to show behind the system bars too.
    fn paint(&self, canvas: &mut HostCanvas<'_, '_>, el: &HostElement<'_>, rect: HostRect);

    /// Paint once on top of the whole view, after everything else, when the control is on screen (a map's data
    /// attribution, which must stay visible over the floating overlays).
    fn paint_overlay(&self, _canvas: &mut HostCanvas<'_, '_>) {}

    /// A number that changes whenever the control's own state changes, so the painter knows the view must be
    /// re-rasterised even though its source did not change.
    fn version(&self) -> u64 {
        0
    }

    /// Drag by a finger delta (physical px).
    fn pan(&self, _dx: f32, _dy: f32) {}

    /// Pinch-zoom by `factor` about a focus point (physical px); `w`,`h` is the surface size.
    fn zoom(&self, _factor: f32, _focus_x: f32, _focus_y: f32, _w: f32, _h: f32) {}

    /// Back to the initial state (e.g. when the app is entered again).
    fn reset(&self) {}
}

/// A host control's laid-out box, in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HostRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl HostRect {
    /// Whether the point `(px, py)` (physical px) is inside this box.
    pub fn contains(&self, px: f32, py: f32) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }
}

/// Read access to the `.kbview` element a host control is painting.
pub struct HostElement<'a>(pub(crate) &'a Element);

impl HostElement<'_> {
    /// The value of attribute `name`, if the element sets it.
    pub fn attr(&self, name: &str) -> Option<String> {
        crate::view::attr(self.0, name)
    }
}

/// The drawing surface handed to a host control: the view's pixmap plus the renderer's primitives (anti-aliased
/// shapes, scaled images, polylines, Lucide icons and text in the view's font).
pub struct HostCanvas<'p, 'f> {
    pub(crate) pm: &'p mut sk::Pixmap,
    pub(crate) clip: Option<&'p sk::Mask>,
    pub(crate) font: Option<&'f FontHandle>,
    pub(crate) dpr: f32,
    pub(crate) bottom_inset: f32,
}

impl HostCanvas<'_, '_> {
    /// The surface width in physical pixels.
    pub fn width(&self) -> f32 {
        self.pm.width() as f32
    }

    /// The surface height in physical pixels.
    pub fn height(&self) -> f32 {
        self.pm.height() as f32
    }

    /// Physical pixels per design pixel (views are authored ≈ 390 px wide).
    pub fn dpr(&self) -> f32 {
        self.dpr
    }

    /// The bottom safe-area inset (gesture / navigation bar), in physical pixels.
    pub fn bottom_inset(&self) -> f32 {
        self.bottom_inset
    }

    /// Whether a font is loaded (text calls are no-ops otherwise).
    pub fn has_font(&self) -> bool {
        self.font.is_some()
    }

    /// Fill a rectangle `[x0,y0]–[x1,y1]` with rounded corners of `radius`.
    #[allow(clippy::too_many_arguments)]
    pub fn fill_rect(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, radius: f32, color: Rgba) {
        crate::view::fill_rrect(self.pm, x0, y0, x1, y1, radius, color, self.clip);
    }

    /// Fill a circle.
    pub fn fill_circle(&mut self, cx: f32, cy: f32, r: f32, color: Rgba) {
        crate::view::fill_circle(self.pm, cx, cy, r, color, self.clip);
    }

    /// Stroke a polyline with round caps and joins.
    pub fn stroke_polyline(&mut self, pts: &[(f32, f32)], width: f32, color: Rgba) {
        crate::view::stroke_polyline(self.pm, pts, width, color, self.clip);
    }

    /// Draw `img` with its top-left corner at `(sx, sy)`, uniformly scaled by `scale` (bilinear).
    pub fn draw_image(&mut self, img: &sk::Pixmap, sx: f32, sy: f32, scale: f32) {
        crate::view::draw_image_xform(self.pm, img, sx, sy, scale, self.clip);
    }

    /// Draw the Lucide icon `name` (`size` px) centred in the box `[x,y,w,h]`.
    #[allow(clippy::too_many_arguments)]
    pub fn draw_icon(&mut self, name: &str, x: f32, y: f32, w: f32, h: f32, size: f32, color: Rgba) {
        crate::view::draw_icon(self.pm, name, x, y, w, h, size, color, self.clip);
    }

    /// Draw one line of text with its baseline at `baseline`.
    #[allow(clippy::too_many_arguments)]
    pub fn draw_text(&mut self, text: &str, x: f32, baseline: f32, px: f32, color: Rgba, bold: bool) {
        crate::view::draw_text(self.pm, self.font, text, x, baseline, px, color, bold, self.clip);
    }

    /// The advance width of `text` at `px`.
    pub fn text_width(&self, text: &str, px: f32, bold: bool) -> f32 {
        crate::view::text_width(self.font, text, px, bold)
    }
}

thread_local! {
    static HOSTS: RefCell<Vec<(&'static str, Rc<dyn HostControl>)>> = const { RefCell::new(Vec::new()) };
}

/// Register `control` as the implementation of the `.kbview` element `name` (replacing any earlier one). Called from
/// the app's [`crate::App::setup`], on the shell's UI thread, before the first frame.
pub fn register_host_control(name: &'static str, control: impl HostControl + 'static) {
    HOSTS.with(|h| {
        let mut h = h.borrow_mut();
        h.retain(|(n, _)| *n != name);
        h.push((name, Rc::new(control)));
    });
}

/// The host control registered for the element `name`.
pub(crate) fn get(name: &str) -> Option<Rc<dyn HostControl>> {
    HOSTS.with(|h| h.borrow().iter().find(|(n, _)| *n == name).map(|(_, c)| c.clone()))
}

/// Whether `name` is a registered full-bleed background control.
pub(crate) fn is_background(name: &str) -> bool {
    get(name).is_some_and(|c| c.is_background())
}

/// A combined version of every registered control (part of the painter's cache key).
pub(crate) fn version() -> u64 {
    HOSTS.with(|h| h.borrow().iter().fold(0u64, |acc, (_, c)| acc.wrapping_mul(31).wrapping_add(c.version())))
}

/// Shell gesture: a one-finger drag by `dx`,`dy` (physical px), routed to every registered host control.
pub fn pan(dx: f32, dy: f32) {
    for c in all() {
        c.pan(dx, dy);
    }
}

/// Shell gesture: a two-finger pinch by `factor` about `focus` (physical px) over a `w`×`h` surface.
pub fn zoom(factor: f32, focus_x: f32, focus_y: f32, w: f32, h: f32) {
    for c in all() {
        c.zoom(factor, focus_x, focus_y, w, h);
    }
}

/// Reset every registered host control to its initial state.
pub fn reset() {
    for c in all() {
        c.reset();
    }
}

fn all() -> Vec<Rc<dyn HostControl>> {
    HOSTS.with(|h| h.borrow().iter().map(|(_, c)| c.clone()).collect())
}
