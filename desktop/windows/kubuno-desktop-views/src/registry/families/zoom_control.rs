//! `<ZoomControl>` - the zoom cluster at the right of an editor's status bar (the web's
//! `shell/StatusBar.tsx` zoom and `DocStatusBar` zoom): « - », a slider, « + » and the percentage,
//! which resets the zoom to 100 %. Part of the `navigation` family (next to `<StatusBar>`), in its
//! own file.
//!
//! One element for the copies the Office editors used to carry (`StatusZoom` of Diagrams,
//! Whiteboard and Spreadsheets, `ZoomSlider` of Documents):
//!
//! * the slider is either **linear** (`Scale="Linear"`: `SliderMinimum`..`SliderMaximum` by steps of
//!   `SliderStep`, 50-200 % by tens by default - a zoom outside parks the thumb at the end of the
//!   rail, as the web's `RangeSlider` does) or **centred on 100 %** (`Scale="Centered100"`: the
//!   left half runs linearly from `SliderMinimum` to 100 %, the right half from 100 % to
//!   `SliderMaximum`, as in Word - Documents uses 10-500 %);
//! * « - » / « + » move by `ButtonStep` points (rounded to a whole percent), or with
//!   `ButtonSnap="true"` to the next multiple of `ButtonStep` that way (Documents);
//! * every change is clamped to `Minimum`..`Maximum` (25-300 % by default).
//!
//! The parts are right-aligned in the element's box, in the web's order, and the slider paints
//! through the design system's own `kubuno_desktop_ui::range::Slider`, so the rail and the thumb
//! are the shared ones. Each part has its tooltip and its node in the accessibility tree.

#[allow(unused_imports)] // Used by the `component!` invocation below.
use crate::registry::macros::component;

use kubuno_desktop_controls::host;
use kubuno_desktop_ui::range::Slider as KSlider;
use kubuno_desktop_ui::{Canvas, Rect, Size, Widget, WidgetState};

use crate::binding::{PropSource, Value, ViewModel};
use crate::events::{ChangeSource, NumericValueChangedEventArgs};
use crate::node::{InteractCx, PaintCx, ViewEventKind, ViewNode};
use crate::props::{BuildError, Props};

/// The resolution of the centred slider (positions `0..=CENTERED_TRACK`).
const CENTERED_TRACK: i32 = 1000;

/// The slider's mapping (`Scale`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ZoomScale {
    /// `min..=max` by steps of `step`.
    Linear { min: f32, max: f32, step: f32 },
    /// `min..100` on the left half, `100..max` on the right half, rounded to `step`.
    Centered100 { min: f32, max: f32, step: f32 },
}

impl ZoomScale {
    /// The scale `Scale`/`SliderMinimum`/`SliderMaximum`/`SliderStep` describe. A centred scale
    /// whose range does not hold 100 % falls back to a linear one.
    pub fn new(centered: bool, a: f32, b: f32, step: f32) -> Self {
        let (min, max) = if a <= b { (a, b) } else { (b, a) };
        let step = if step > 0.0 { step } else { 1.0 };
        if centered && min < 100.0 && max > 100.0 {
            Self::Centered100 { min, max, step }
        } else {
            Self::Linear { min, max, step }
        }
    }

    /// Where `percent` sits on the slider, `0..=1`.
    pub fn position_of(self, percent: f32) -> f32 {
        match self {
            Self::Linear { min, max, step } => {
                if max <= min {
                    return 0.0;
                }
                let v = ((percent.clamp(min, max) - min) / step).round() * step + min;
                ((v - min) / (max - min)).clamp(0.0, 1.0)
            }
            Self::Centered100 { min, max, .. } => {
                let p = percent.clamp(min, max);
                if p <= 100.0 {
                    (p - min) / (100.0 - min) * 0.5
                } else {
                    0.5 + (p - 100.0) / (max - 100.0) * 0.5
                }
            }
        }
    }

    /// The percentage at slider position `t` (`0..=1`), rounded to the step.
    pub fn percent_at(self, t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Self::Linear { min, max, step } => {
                let v = min + t * (max - min);
                (((v - min) / step).round() * step + min).clamp(min, max)
            }
            Self::Centered100 { min, max, step } => {
                let p = if t <= 0.5 { min + t / 0.5 * (100.0 - min) } else { 100.0 + (t - 0.5) / 0.5 * (max - 100.0) };
                ((p / step).round() * step).clamp(min, max)
            }
        }
    }

    /// The slider widget's integer range and value for `percent`: a linear slider counts in
    /// percent, a centred one in `CENTERED_TRACK` positions.
    fn track(self, percent: f32) -> (i32, i32, i32) {
        match self {
            Self::Linear { min, max, step } => {
                let v = ((percent.clamp(min, max) - min) / step).round() * step + min;
                (min.round() as i32, max.round() as i32, v.round() as i32)
            }
            Self::Centered100 { .. } => (0, CENTERED_TRACK, (self.position_of(percent) * CENTERED_TRACK as f32).round() as i32),
        }
    }

    /// The percentage of the slider widget's integer value `value`.
    fn percent_of_track(self, value: i32) -> f32 {
        match self {
            Self::Linear { min, max, .. } => self.percent_at(if max > min { (value as f32 - min) / (max - min) } else { 0.0 }),
            Self::Centered100 { .. } => self.percent_at(value as f32 / CENTERED_TRACK as f32),
        }
    }
}

/// One « - » (`dir` = -1) or « + » (1) from `percent`: `step` points that way rounded to a whole
/// percent, or with `snap` the next multiple of `step` that way; clamped to `min..=max`.
pub fn stepped(percent: f32, dir: f32, step: f32, snap: bool, min: f32, max: f32) -> f32 {
    let step = if step > 0.0 { step } else { 1.0 };
    let next = if snap {
        let base = (percent / step).round() * step;
        if (base - percent).abs() > 0.5 && (base - percent).signum() == dir.signum() {
            base
        } else {
            base + dir * step
        }
    } else {
        (percent + dir * step).round()
    };
    next.clamp(min.min(max), max.max(min))
}

/// The parts of the control, in the web's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZoomPart {
    Minus,
    Track,
    Plus,
    Percent,
}

/// The parts' rectangles in `bounds`, right-aligned (a wider element keeps them at its end).
pub fn zoom_parts(bounds: Rect, button_w: f32, slider_w: f32, percent_w: f32) -> [(ZoomPart, Rect); 4] {
    let total = 2.0 * button_w + slider_w + percent_w;
    let x = (bounds.right - total).max(bounds.left);
    let r = |l: f32, w: f32| Rect::new(l, bounds.top, l + w, bounds.bottom);
    [
        (ZoomPart::Minus, r(x, button_w)),
        (ZoomPart::Track, r(x + button_w, slider_w)),
        (ZoomPart::Plus, r(x + button_w + slider_w, button_w)),
        (ZoomPart::Percent, r(x + 2.0 * button_w + slider_w, percent_w)),
    ]
}

/// The percentage as shown: `format` with `{0}` replaced by the rounded zoom (`100 %`).
pub fn percent_text(format: &str, percent: f32) -> String {
    let n = (percent.round() as i32).to_string();
    if format.contains("{0}") {
        format.replace("{0}", &n)
    } else {
        format!("{n}{format}")
    }
}

component! {
    mod_name: zoom_control,
    name: "ZoomControl",
    // Note: The status bar's zoom cluster of the Office editors (Diagrams/Whiteboard/Spreadsheets `StatusZoom`, Documents `ZoomSlider`), painting through `kubuno_desktop_ui::range::Slider`; see the file's module doc.
    doc: "The zoom of a status bar: a zoom-out button, a slider, a zoom-in button and the percentage, which resets the zoom to 100 %.",
    ctor: kubuno_desktop_ui::range::Slider::new(),
    children: ChildrenModel::None,
    default_event: "OnValueChanged",
    props: [
        PropertyMeta::new("Value", PropKind::F32, "100", "The zoom, in percent, usually bound in both directions.").category("Behavior").bindable(),
        PropertyMeta::new("Minimum", PropKind::F32, "25", "The smallest zoom the buttons and the slider can set, in percent.").category("Behavior"),
        PropertyMeta::new("Maximum", PropKind::F32, "300", "The largest zoom the buttons and the slider can set, in percent.").category("Behavior"),
        PropertyMeta::new("SliderMinimum", PropKind::F32, "50", "The zoom at the left end of the slider, in percent.").category("Behavior"),
        PropertyMeta::new("SliderMaximum", PropKind::F32, "200", "The zoom at the right end of the slider, in percent.").category("Behavior"),
        PropertyMeta::new("SliderStep", PropKind::F32, "10", "The zoom set by the slider is rounded to a multiple of this step, in percent.").category("Behavior"),
        PropertyMeta::new("ButtonStep", PropKind::F32, "10", "How many points the zoom-out and zoom-in buttons change the zoom by.").category("Behavior"),
        PropertyMeta::new("ButtonSnap", PropKind::Bool, "false", "The zoom-out and zoom-in buttons go to the next multiple of ButtonStep instead of adding it.").category("Behavior"),
        PropertyMeta::new("Scale", PropKind::Enum(&["Linear", "Centered100"]), "Linear", "Linear: the slider runs evenly from SliderMinimum to SliderMaximum. Centered100: 100 % is in the middle of the slider, its left half runs to SliderMinimum and its right half to SliderMaximum.").category("Behavior"),
        PropertyMeta::new("ZoomOutText", PropKind::String, "Zoom out", "The tooltip and accessible name of the zoom-out button.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("ZoomInText", PropKind::String, "Zoom in", "The tooltip and accessible name of the zoom-in button.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("ZoomResetText", PropKind::String, "Reset to 100%", "The tooltip and accessible name of the percentage, which resets the zoom to 100 %.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("ZoomLabelText", PropKind::String, "Zoom", "The word written before the percentage in the slider's tooltip and accessible name.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("PercentFormat", PropKind::String, "{0} %", "How the percentage is written: {0} is replaced by the zoom.").category("Appearance").localizable(),
        PropertyMeta::new("ButtonWidth", PropKind::F32, "26", "The width of the zoom-out and zoom-in buttons, in DIP.").category("Layout"),
        PropertyMeta::new("SliderWidth", PropKind::F32, "120", "The width of the slider, in DIP.").category("Layout"),
        PropertyMeta::new("PercentWidth", PropKind::F32, "56", "The width of the percentage, in DIP.").category("Layout"),
        PropertyMeta::new("PreferredHeight", PropKind::F32, "28", "The height the control asks for when it is laid out by its content, in DIP.").category("Layout"),
        PropertyMeta::new("HoverRadius", PropKind::F32, "0", "The corner radius of the highlight under the pointer, in DIP.").category("Appearance"),
    ],
    events: [
        EventMeta::new("OnValueChanged", "Occurs when the user changes the zoom with a button, the slider or the percentage.").category(crate::registry::EventCategory::Action).args::<crate::events::NumericValueChangedEventArgs>(),
    ],
    smoke: |mut s| {
        s.set_minimum(50);
        s.set_maximum(200);
        s.set_value_clamped(100);
        s
    },
    build: |props, _cx| {
        crate::registry::families::navigation::zoom_control::build_zoom_control(props)
    },
}

pub(crate) fn build_zoom_control(props: &Props<'_>) -> Result<Box<dyn ViewNode>, BuildError> {
    Ok(Box::new(ZoomControlNode {
        value: props.f32("Value", 100.0)?,
        minimum: props.f32("Minimum", 25.0)?,
        maximum: props.f32("Maximum", 300.0)?,
        slider_minimum: props.f32("SliderMinimum", 50.0)?,
        slider_maximum: props.f32("SliderMaximum", 200.0)?,
        slider_step: props.f32("SliderStep", 10.0)?,
        button_step: props.f32("ButtonStep", 10.0)?,
        button_snap: props.bool("ButtonSnap", false)?,
        scale: props.enum_("Scale", "Linear")?,
        zoom_out: props.str("ZoomOutText", "Zoom out")?,
        zoom_in: props.str("ZoomInText", "Zoom in")?,
        zoom_reset: props.str("ZoomResetText", "Reset to 100%")?,
        zoom_label: props.str("ZoomLabelText", "Zoom")?,
        percent_format: props.str("PercentFormat", "{0} %")?,
        button_w: props.f32("ButtonWidth", 26.0)?,
        slider_w: props.f32("SliderWidth", 120.0)?,
        percent_w: props.f32("PercentWidth", 56.0)?,
        height: props.f32("PreferredHeight", 28.0)?,
        hover_radius: props.f32("HoverRadius", 0.0)?,
        focus_id: props.focus_id(),
        on_value_changed: props.event("OnValueChanged"),
        local: None,
        pressed: None,
        hot: None,
        was_down: false,
    }))
}

/// `<ZoomControl>`'s live node.
pub struct ZoomControlNode {
    value: PropSource<f32>,
    minimum: PropSource<f32>,
    maximum: PropSource<f32>,
    slider_minimum: PropSource<f32>,
    slider_maximum: PropSource<f32>,
    slider_step: PropSource<f32>,
    button_step: PropSource<f32>,
    button_snap: PropSource<bool>,
    scale: PropSource<String>,
    zoom_out: PropSource<String>,
    zoom_in: PropSource<String>,
    zoom_reset: PropSource<String>,
    zoom_label: PropSource<String>,
    percent_format: PropSource<String>,
    button_w: PropSource<f32>,
    slider_w: PropSource<f32>,
    percent_w: PropSource<f32>,
    height: PropSource<f32>,
    hover_radius: PropSource<f32>,
    focus_id: Option<kubuno_desktop_ui::FocusId>,
    on_value_changed: Option<String>,
    /// The zoom the user set while `Value` is a literal (nothing to write back to).
    local: Option<f32>,
    /// The part pressed (a button acts when released over it; the slider drags).
    pressed: Option<ZoomPart>,
    /// The part under the pointer.
    hot: Option<ZoomPart>,
    /// The left button at the previous frame (a press is its rising edge).
    was_down: bool,
}

impl ZoomControlNode {
    fn current(&self, vm: &dyn ViewModel) -> f32 {
        match (&self.value, self.local) {
            (PropSource::Literal(_), Some(local)) => local,
            _ => self.value.resolve(vm),
        }
    }

    fn scale(&self, vm: &dyn ViewModel) -> ZoomScale {
        ZoomScale::new(self.scale.resolve(vm) == "Centered100", self.slider_minimum.resolve(vm), self.slider_maximum.resolve(vm), self.slider_step.resolve(vm))
    }

    fn range(&self, vm: &dyn ViewModel) -> (f32, f32) {
        let (a, b) = (self.minimum.resolve(vm), self.maximum.resolve(vm));
        if a <= b {
            (a, b)
        } else {
            (b, a)
        }
    }

    fn parts(&self, vm: &dyn ViewModel, bounds: Rect) -> [(ZoomPart, Rect); 4] {
        zoom_parts(bounds, self.button_w.resolve(vm).max(0.0), self.slider_w.resolve(vm).max(0.0), self.percent_w.resolve(vm).max(0.0))
    }

    /// The slider's rail: its part inset by the slider's `px-1`.
    fn track_rect(&self, vm: &dyn ViewModel, bounds: Rect) -> Rect {
        let r = self.parts(vm, bounds)[1].1;
        Rect::new(r.left + 4.0, r.top, (r.right - 4.0).max(r.left + 4.0), r.bottom)
    }

    fn slider(&self, vm: &dyn ViewModel, percent: f32) -> KSlider {
        let (lo, hi, v) = self.scale(vm).track(percent);
        let mut s = KSlider::new();
        s.set_minimum(lo);
        s.set_maximum(hi.max(lo));
        s.set_value_clamped(v);
        s
    }

    fn percent_text(&self, vm: &dyn ViewModel, percent: f32) -> String {
        percent_text(&self.percent_format.resolve(vm), percent)
    }

    /// The tooltip and accessible name of `part`.
    fn part_name(&self, vm: &dyn ViewModel, part: ZoomPart, percent: f32) -> String {
        match part {
            ZoomPart::Minus => self.zoom_out.resolve(vm),
            ZoomPart::Plus => self.zoom_in.resolve(vm),
            ZoomPart::Percent => self.zoom_reset.resolve(vm),
            ZoomPart::Track => format!("{} {}", self.zoom_label.resolve(vm), self.percent_text(vm, percent)).trim().to_string(),
        }
    }

    /// Sets the zoom from the user (clamped to `Minimum..=Maximum`): written back to `Value`'s
    /// binding, then `ValueChanged` raised.
    fn change(&mut self, ix: &mut InteractCx<'_>, percent: f32) {
        let (min, max) = self.range(ix.vm);
        let old = self.current(ix.vm);
        let new = percent.clamp(min, max);
        if (new - old).abs() < 0.01 {
            return;
        }
        match self.value.binding() {
            Some(spec) => {
                if spec.mode.writes_back() {
                    spec.update_source(ix.vm, Value::F32(new));
                }
            }
            None => self.local = Some(new),
        }
        let mut args = NumericValueChangedEventArgs::new(old, new, ChangeSource::User);
        ix.fire("OnValueChanged", self.focus_id, self.on_value_changed.as_deref(), ViewEventKind::Changed(new.to_string()), &mut args);
    }

    fn drag(&mut self, ix: &mut InteractCx<'_>, bounds: Rect) {
        let (mx, my) = ix.frame.mouse;
        let percent = self.current(ix.vm);
        let mut s = self.slider(ix.vm, percent);
        s.drag_to(self.track_rect(ix.vm, bounds), mx, my);
        let next = self.scale(ix.vm).percent_of_track(s.value());
        self.change(ix, next);
    }

    /// The pointer over the parts: hover, press, release over the pressed button, slider drag.
    pub(crate) fn interact(&mut self, ix: &mut InteractCx<'_>, bounds: Rect) {
        let (mx, my) = ix.frame.mouse;
        let over = !ix.frame.pointer_outside() && bounds.contains(mx, my);
        let part = if over { self.parts(ix.vm, bounds).into_iter().find(|(_, r)| r.contains(mx, my)).map(|(p, _)| p) } else { None };
        self.hot = part;
        let down = ix.frame.mouse_down;
        let pressed_now = down && !self.was_down;
        self.was_down = down;
        if pressed_now {
            self.pressed = part;
        }
        if down {
            if self.pressed == Some(ZoomPart::Track) {
                self.drag(ix, bounds);
            }
            return;
        }
        let percent = self.current(ix.vm);
        let (min, max) = self.range(ix.vm);
        let step = self.button_step.resolve(ix.vm);
        let snap = self.button_snap.resolve(ix.vm);
        match self.pressed.take() {
            Some(ZoomPart::Minus) if part == Some(ZoomPart::Minus) => self.change(ix, stepped(percent, -1.0, step, snap, min, max)),
            Some(ZoomPart::Plus) if part == Some(ZoomPart::Plus) => self.change(ix, stepped(percent, 1.0, step, snap, min, max)),
            Some(ZoomPart::Percent) if part == Some(ZoomPart::Percent) => self.change(ix, 100.0),
            _ => {}
        }
    }

    /// The tooltip of the part under the pointer and one accessibility node per part, under the
    /// element's own (as a custom control's `tool_tip_at` / `accessible_parts`).
    fn offer_services(&self, cx: &mut PaintCx<'_>, bounds: Rect, percent: f32, enabled: bool) {
        let Some((slot, _)) = cx.sender.clone() else { return };
        let vm: &dyn ViewModel = &*cx.vm;
        let parts = self.parts(vm, bounds);
        let names: Vec<String> = parts.iter().map(|(p, _)| self.part_name(vm, *p, percent)).collect();
        let Some(services) = cx.services.as_deref_mut() else { return };
        if let Some(i) = self.hot.and_then(|h| parts.iter().position(|(p, _)| *p == h)) {
            if !names[i].trim().is_empty() {
                services.offer_tooltip(names[i].clone(), crate::clip::visible_client(crate::common::to_client(parts[i].1)), &slot.id);
            }
        }
        let parent = crate::common::access_id(&slot.id);
        for (i, ((part, r), name)) in parts.iter().zip(names).enumerate() {
            let c = crate::clip::visible_client(crate::common::to_client(*r));
            let role = if *part == ZoomPart::Track { host::access::AccessRole::Slider } else { host::access::AccessRole::Button };
            services.access.push(host::access::AccessNode {
                id: crate::common::access_id(&format!("{}/part{i}", slot.id)),
                parent: Some(parent),
                role,
                name,
                description: String::new(),
                value: (*part == ZoomPart::Track).then(|| self.percent_text(vm, percent)),
                bounds: (c.left, c.top, c.right, c.bottom),
                focusable: false,
                disabled: !enabled,
                checked: None,
                clickable: false,
                read_only: true,
                access_key: None,
                expanded: None,
            });
        }
    }
}

impl ViewNode for ZoomControlNode {
    fn measure(&self, _c: &dyn Canvas, vm: &dyn ViewModel) -> Size {
        let w = 2.0 * self.button_w.resolve(vm).max(0.0) + self.slider_w.resolve(vm).max(0.0) + self.percent_w.resolve(vm).max(0.0);
        Size::new(w, self.height.resolve(vm).max(0.0))
    }

    fn intrinsic_width(&self, c: &dyn Canvas, vm: &dyn ViewModel) -> Option<f32> {
        Some(self.measure(c, vm).width)
    }

    fn paint(&mut self, cx: &mut PaintCx<'_>, bounds: Rect) {
        let designing = cx.design.is_some();
        let enabled = !crate::common::is_disabled();
        if designing || !enabled {
            self.hot = None;
            self.pressed = None;
            self.was_down = cx.frame.mouse_down;
        } else {
            let mut ix = cx.interact_cx();
            self.interact(&mut ix, bounds);
        }
        // Re-resolved after `interact`: a write-back shows in the same frame.
        let vm: &dyn ViewModel = &*cx.vm;
        let percent = self.current(vm);
        let c: &dyn Canvas = cx.canvas;
        let t = c.theme();
        let dark = t.mode == kubuno_desktop_ui::ThemeMode::Dark;
        // `hover:bg-black/5`, and its dark-theme counterpart.
        let hover = if dark { kubuno_desktop_ui::graphics::Color::rgba_f(1.0, 1.0, 1.0, 0.08) } else { kubuno_desktop_ui::graphics::Color::rgba_f(0.0, 0.0, 0.0, 0.05) }.to_d2d();
        let ink = t.text_secondary;
        let radius = self.hover_radius.resolve(vm).max(0.0);
        for (part, r) in self.parts(vm, bounds) {
            if part != ZoomPart::Track && (self.hot == Some(part) || self.pressed == Some(part)) {
                c.fill_rounded(&r, radius, &hover);
            }
            match part {
                ZoomPart::Minus | ZoomPart::Plus => {
                    let name = if part == ZoomPart::Minus { "Minus" } else { "Plus" };
                    let (x, y) = ((r.left + r.right) / 2.0, (r.top + r.bottom) / 2.0);
                    c.vector_icon(name, &Rect::new(x - 7.0, y - 7.0, x + 7.0, y + 7.0), 14.0, &ink);
                }
                ZoomPart::Track => {
                    let state = WidgetState::REST.hot(self.hot == Some(ZoomPart::Track)).pressed(self.pressed == Some(ZoomPart::Track)).disabled(!enabled);
                    self.slider(vm, percent).paint(c, self.track_rect(vm, bounds), state);
                }
                ZoomPart::Percent => c.text(&self.percent_text(vm, percent), &r, &c.formats().caption, &ink, true),
            }
        }
        if !designing {
            self.offer_services(cx, bounds, percent, enabled);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_buttons_add_ten_points_and_stop_at_the_range() {
        assert_eq!(stepped(100.0, 1.0, 10.0, false, 25.0, 300.0), 110.0);
        assert_eq!(stepped(100.0, -1.0, 10.0, false, 25.0, 300.0), 90.0);
        assert_eq!(stepped(132.0, 1.0, 10.0, false, 25.0, 300.0), 142.0);
        assert_eq!(stepped(30.0, -1.0, 10.0, false, 25.0, 300.0), 25.0);
        assert_eq!(stepped(295.0, 1.0, 10.0, false, 25.0, 300.0), 300.0);
    }

    #[test]
    fn snapping_buttons_step_to_the_next_ten() {
        assert_eq!(stepped(100.0, 1.0, 10.0, true, 10.0, 500.0), 110.0);
        assert_eq!(stepped(100.0, -1.0, 10.0, true, 10.0, 500.0), 90.0);
        assert_eq!(stepped(104.0, 1.0, 10.0, true, 10.0, 500.0), 110.0);
        assert_eq!(stepped(104.0, -1.0, 10.0, true, 10.0, 500.0), 100.0);
        assert_eq!(stepped(10.0, -1.0, 10.0, true, 10.0, 500.0), 10.0);
        assert_eq!(stepped(500.0, 1.0, 10.0, true, 10.0, 500.0), 500.0);
    }

    #[test]
    fn the_linear_slider_covers_50_to_200_by_tens() {
        let s = ZoomScale::new(false, 50.0, 200.0, 10.0);
        assert_eq!(s.track(10.0), (50, 200, 50));
        assert_eq!(s.track(400.0), (50, 200, 200));
        assert_eq!(s.track(134.0).2, 130);
        assert_eq!(s.track(136.0).2, 140);
        assert_eq!(s.percent_at(0.0), 50.0);
        assert_eq!(s.percent_at(1.0), 200.0);
        assert_eq!(s.percent_at(0.34), 100.0);
        assert_eq!(s.percent_of_track(137), 140.0);
    }

    #[test]
    fn the_middle_of_the_centred_slider_is_one_hundred_percent() {
        let s = ZoomScale::new(true, 10.0, 500.0, 1.0);
        assert_eq!(s.position_of(100.0), 0.5);
        assert_eq!(s.percent_at(0.5), 100.0);
        assert_eq!(s.percent_at(0.0), 10.0);
        assert_eq!(s.percent_at(1.0), 500.0);
        assert_eq!(s.position_of(5000.0), 1.0, "clamped");
        for p in [10.0, 25.0, 50.0, 75.0, 100.0, 150.0, 200.0, 333.0, 500.0] {
            assert_eq!(s.percent_at(s.position_of(p)), p);
        }
        // The left half is finer than the right one.
        assert!(s.position_of(110.0) - s.position_of(100.0) < s.position_of(100.0) - s.position_of(90.0));
        assert_eq!(s.percent_of_track(CENTERED_TRACK / 2), 100.0);
        // A range without 100 % cannot be centred on it.
        assert!(matches!(ZoomScale::new(true, 120.0, 300.0, 10.0), ZoomScale::Linear { .. }));
    }

    #[test]
    fn the_parts_are_right_aligned_in_the_webs_order() {
        let p = zoom_parts(Rect::new(0.0, 0.0, 300.0, 28.0), 26.0, 120.0, 56.0);
        assert_eq!(p[3].1.right, 300.0);
        assert_eq!(p[0].1.left, 300.0 - 228.0);
        assert_eq!(p.map(|(k, _)| k), [ZoomPart::Minus, ZoomPart::Track, ZoomPart::Plus, ZoomPart::Percent]);
    }

    #[test]
    fn the_percentage_follows_its_format() {
        assert_eq!(percent_text("{0} %", 99.6), "100 %");
        assert_eq!(percent_text("{0}%", 75.0), "75%");
        assert_eq!(percent_text("", 50.0), "50");
    }

    #[test]
    fn zoom_controls_compile() {
        let src = r#"<Panel><ZoomControl Value="{Binding Zoom, Mode=TwoWay}" Scale="Centered100" SliderMinimum="10" SliderMaximum="500" SliderStep="1" Minimum="10" Maximum="500" ButtonSnap="true" ZoomOutText="Zoom arrière" OnValueChanged="zoom_changed"/><ZoomControl/></Panel>"#;
        assert!(crate::compile::compile(src).is_ok(), "{:?}", crate::compile::compile(src).err());
        let bad = r#"<Panel><ZoomControl Scale="Log"/></Panel>"#;
        assert!(crate::compile::compile(bad).is_err(), "Scale is a closed list");
    }
}
