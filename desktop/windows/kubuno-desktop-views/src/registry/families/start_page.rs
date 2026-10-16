//! `<StartPage>` - the home of an editor's backstage (the web's `@ui` `StartPage`,
//! `core/web/src/ui/StartPage.tsx`): on the left the « Recent » column (256 DIP, `bg-surface-1`, a
//! 57 DIP header with the clock and the title, then one row per recent file - the item glyph of
//! 18, the name `text-sm`, the date `text-[11px]`), and on the right the « Browse » tab: every file
//! with the new button (`ModuleFileBrowser`'s toolbar) and the browser's empty state. Part of the
//! `navigation` family, in its own file.
//!
//! The element only draws and reports: the application hands it the lists (`Recents`, `Items`:
//! bindings to a `Shared<Vec<StartItem>>`, or to rows with `Id`, `Title` and `UpdatedAt` fields;
//! from code `kubuno_desktop::forms::StartPage::set_lists`) and turns its `StartCommand`
//! (`open` a click on a row, `menu` a right click on a row, `new` the new button or the empty
//! state's link) into the server calls. A list that is not given (no account) makes its column say
//! so (`SignedOutText`). Every visible word is a property, so one element serves every editor.

#[allow(unused_imports)] // Used by the `component!` invocation below.
use crate::registry::macros::component;

use std::sync::Arc;

use kubuno_desktop_controls::host;
use kubuno_desktop_ui::{Canvas, Rect, Size};
use windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F;

use crate::binding::{BindingSpec, PropSource, Value, ViewModel};
use crate::events::StartCommandEventArgs;
use crate::node::{PaintCx, ViewEventKind, ViewNode};
use crate::props::{BuildError, Props};

/// A file as the lists show it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct StartItem {
    pub id: String,
    pub title: String,
    /// `updated_at` as the server writes it (RFC 3339).
    pub updated_at: String,
}

impl StartItem {
    /// An item of `id`, `title` and `updated_at`.
    pub fn new(id: impl Into<String>, title: impl Into<String>, updated_at: impl Into<String>) -> Self {
        Self { id: id.into(), title: title.into(), updated_at: updated_at.into() }
    }

    /// The item a bound row describes (fields `Id`, `Title`, `UpdatedAt`).
    pub fn from_row(row: &crate::binding::Row) -> Self {
        Self { id: row.text("Id"), title: row.text("Title"), updated_at: row.text("UpdatedAt") }
    }
}

/// The « Recent » column (`RECENT_W_DEFAULT`).
pub const RECENT_W: f32 = 256.0;
/// Both headers (`h-[57px]`).
pub const HEADER_H: f32 = 57.0;
/// A recent row: `py-2` around a `text-sm` line and a `text-[11px]` line.
pub const RECENT_ROW_H: f32 = 52.0;
/// A browser row.
pub const BROWSE_ROW_H: f32 = 40.0;
/// The browser's toolbar.
pub const TOOLBAR_H: f32 = 56.0;
/// The new button (`Button size="sm"`): `h-8`.
const BUTTON_H: f32 = 32.0;
const WHEEL_STEP: f32 = 48.0;

/// What the pointer is over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartHit {
    Recent(usize),
    Browse(usize),
    New,
    EmptyCreate,
}

/// The rectangles of the page in a `w`×`h` box at the origin.
#[derive(Debug, Clone, Copy)]
pub struct StartLayout {
    pub recent: Rect,
    pub browse: Rect,
    pub new_button: Rect,
    /// The browser's list area (below its toolbar).
    pub list: Rect,
    /// The empty state's link.
    pub empty_link: Rect,
}

/// The layout of a `w`×`h` page whose new button's label is `new_label_w` wide.
pub fn start_layout(w: f32, h: f32, new_label_w: f32) -> StartLayout {
    let rw = RECENT_W.min(w * 0.5);
    let recent = Rect::new(0.0, 0.0, rw, h);
    let browse = Rect::new(rw + 1.0, 0.0, w.max(rw + 1.0), h);
    let bw = new_label_w + 12.0 + 14.0 + 6.0 + 12.0;
    let ty = HEADER_H + (TOOLBAR_H - BUTTON_H) / 2.0;
    let new_button = Rect::new(browse.right - 24.0 - bw, ty, browse.right - 24.0, ty + BUTTON_H);
    let list = Rect::new(browse.left, HEADER_H + TOOLBAR_H, browse.right, h);
    let cy = (list.top + list.bottom) / 2.0;
    let empty_link = Rect::new((list.left + list.right) / 2.0 - 120.0, cy + 34.0, (list.left + list.right) / 2.0 + 120.0, cy + 58.0);
    StartLayout { recent, browse, new_button, list, empty_link }
}

/// The `i`-th recent row, scrolled by `scroll`.
pub fn recent_row(i: usize, l: &StartLayout, scroll: f32) -> Rect {
    let top = HEADER_H + 4.0 + i as f32 * RECENT_ROW_H - scroll;
    Rect::new(l.recent.left, top, l.recent.right, top + RECENT_ROW_H)
}

/// The `i`-th browser row, scrolled by `scroll`.
pub fn browse_row(i: usize, l: &StartLayout, scroll: f32) -> Rect {
    let top = l.list.top + 8.0 + i as f32 * BROWSE_ROW_H - scroll;
    Rect::new(l.list.left + 16.0, top, l.list.right - 16.0, top + BROWSE_ROW_H)
}

/// `formatDate(…, { day: 'numeric', month: 'short' })` of an RFC 3339 date: `format` (`{day}`,
/// `{month}`) with the month's short name from `months` (twelve names separated by commas).
pub fn short_date(rfc3339: &str, months: &str, format: &str) -> String {
    let mut it = rfc3339.get(..10).unwrap_or("").split('-');
    let (Some(_), Some(m), Some(d)) = (it.next(), it.next(), it.next()) else { return String::new() };
    let (Ok(m), Ok(d)) = (m.parse::<usize>(), d.parse::<u32>()) else { return String::new() };
    let months: Vec<&str> = months.split(',').map(str::trim).collect();
    let Some(month) = m.checked_sub(1).and_then(|i| months.get(i)) else { return String::new() };
    format.replace("{day}", &d.to_string()).replace("{month}", month)
}

/// How far a list of `rows` rows of `row_h` scrolls in an `area` tall.
pub fn max_scroll(rows: usize, row_h: f32, area: f32) -> f32 {
    (rows as f32 * row_h + 16.0 - area).max(0.0)
}

fn with_alpha(c: D2D1_COLOR_F, a: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F { a: c.a * a, ..c }
}

/// The default short month names (`MonthsShort`).
const MONTHS_EN: &str = "Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec";

component! {
    mod_name: start_page,
    name: "StartPage",
    // Note: The backstage home of the Office editors (Diagrams/Presentations `StartPage`), generic: the glyph and every word are properties; see the file's module doc.
    doc: "The home page of an editor: the recent files on the left, every file on the right with a button to create one. A click opens a file, a right click asks for its menu.",
    ctor: kubuno_desktop_ui::display::Icon::new("Home"),
    children: ChildrenModel::None,
    default_event: "OnStartCommand",
    props: [
        PropertyMeta::new("Recents", PropKind::String, "", "The recent files: a binding to a list of start items, or to rows with Id, Title and UpdatedAt fields. Not set: the user is signed out.").category("Data").editor("object").bindable(),
        PropertyMeta::new("Items", PropKind::String, "", "Every file of the browser: a binding to a list of start items, or to rows with Id, Title and UpdatedAt fields.").category("Data").editor("object").bindable(),
        PropertyMeta::new("ItemIcon", PropKind::String, "FileText", "The icon of a file in the lists and of the empty states: a name of the Kubuno icon set.").editor("icon").category("Appearance"),
        PropertyMeta::new("NewText", PropKind::String, "New", "The label of the button that creates a file.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("RecentText", PropKind::String, "Recent", "The title of the recent files column.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("RecentEmptyText", PropKind::String, "Use the Browse tab to access your files.", "The hint of the recent files column when it is empty.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("BrowseText", PropKind::String, "Browse", "The name of the browser's tab.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("BrowseTitle", PropKind::String, "Files", "The title of the browser's toolbar.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("EmptyTitle", PropKind::String, "No files", "The title of the browser when it has no file.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("EmptyCreate", PropKind::String, "Create your first file", "The link of the empty browser, which creates a file.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("SignedOutText", PropKind::String, "Sign in to Kubuno Desktop to see your files.", "The hint of the recent files column when the user is signed out.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("UntitledText", PropKind::String, "Untitled", "The name shown for a file without a title.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("MonthsShort", PropKind::String, "Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec", "The short names of the twelve months, separated by commas, for the dates of the files.").category("Appearance").localizable().bindable(),
        PropertyMeta::new("DateShort", PropKind::String, "{month} {day}", "How the date of a file is written: {day} and {month} are replaced by the day and the month's short name.").category("Appearance").localizable().bindable(),
    ],
    events: [
        EventMeta::new("OnStartCommand", "Occurs when the user opens a file, asks for its menu with a right click, or asks for a new file.").category(crate::registry::EventCategory::Action).args::<crate::events::StartCommandEventArgs>(),
    ],
    smoke: |i| { i },
    build: |props, _cx| {
        crate::registry::families::navigation::start_page::build_start_page(props)
    },
}

/// A bound list of the page (`Recents` or `Items`).
struct ListSource {
    spec: Option<BindingSpec>,
    /// The rows last converted, by their stamp (a `Rows` list is converted when it changes only).
    rows: Option<(u64, Arc<Vec<StartItem>>)>,
}

impl ListSource {
    fn read(props: &Props<'_>, name: &str) -> Result<Self, BuildError> {
        Ok(Self { spec: props.str(name, "")?.binding().cloned(), rows: None })
    }

    /// The list this frame; `None` when nothing is given (signed out).
    fn resolve(&mut self, vm: &dyn ViewModel) -> Option<Arc<Vec<StartItem>>> {
        let spec = self.spec.as_ref()?;
        match vm.get(&spec.path)? {
            Value::Object(o) => o.downcast_arc::<Vec<StartItem>>().or_else(|| o.downcast_ref::<Option<Vec<StartItem>>>().and_then(|l| l.clone().map(Arc::new))),
            Value::List(rows) => {
                if let Some((stamp, items)) = &self.rows {
                    if *stamp == rows.stamp() {
                        return Some(items.clone());
                    }
                }
                let items = Arc::new(rows.iter().map(StartItem::from_row).collect::<Vec<_>>());
                self.rows = Some((rows.stamp(), items.clone()));
                Some(items)
            }
            _ => None,
        }
    }
}

pub(crate) fn build_start_page(props: &Props<'_>) -> Result<Box<dyn ViewNode>, BuildError> {
    Ok(Box::new(StartPageNode {
        recents: ListSource::read(props, "Recents")?,
        items: ListSource::read(props, "Items")?,
        item_icon: props.str("ItemIcon", "FileText")?,
        new_text: props.str("NewText", "New")?,
        recent_text: props.str("RecentText", "Recent")?,
        recent_empty: props.str("RecentEmptyText", "Use the Browse tab to access your files.")?,
        browse_text: props.str("BrowseText", "Browse")?,
        browse_title: props.str("BrowseTitle", "Files")?,
        empty_title: props.str("EmptyTitle", "No files")?,
        empty_create: props.str("EmptyCreate", "Create your first file")?,
        signed_out: props.str("SignedOutText", "Sign in to Kubuno Desktop to see your files.")?,
        untitled: props.str("UntitledText", "Untitled")?,
        months: props.str("MonthsShort", MONTHS_EN)?,
        date_short: props.str("DateShort", "{month} {day}")?,
        focus_id: props.focus_id(),
        on_start_command: props.event("OnStartCommand"),
        state: StartState::default(),
    }))
}

/// A list as shown: `None` when it was not given.
type ShownList = Option<Arc<Vec<StartItem>>>;

/// What `<StartPage>` keeps across frames.
#[derive(Default)]
struct StartState {
    hot: Option<StartHit>,
    pressed: Option<StartHit>,
    recent_scroll: f32,
    browse_scroll: f32,
    was_down: bool,
    was_right_down: bool,
    /// The lists last shown: a new content scrolls both back to the top.
    shown: (ShownList, ShownList),
}

/// `<StartPage>`'s live node.
pub struct StartPageNode {
    recents: ListSource,
    items: ListSource,
    item_icon: PropSource<String>,
    new_text: PropSource<String>,
    recent_text: PropSource<String>,
    recent_empty: PropSource<String>,
    browse_text: PropSource<String>,
    browse_title: PropSource<String>,
    empty_title: PropSource<String>,
    empty_create: PropSource<String>,
    signed_out: PropSource<String>,
    untitled: PropSource<String>,
    months: PropSource<String>,
    date_short: PropSource<String>,
    focus_id: Option<kubuno_desktop_ui::FocusId>,
    on_start_command: Option<String>,
    state: StartState,
}

fn same_list(a: &ShownList, b: &ShownList) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => Arc::ptr_eq(a, b) || **a == **b,
        _ => false,
    }
}

/// The hit at `(x, y)` (page coordinates) of a page laid out as `l` showing `recents` and `all`.
fn hit_at(l: &StartLayout, recents: &[StartItem], all: &[StartItem], recent_scroll: f32, browse_scroll: f32, x: f32, y: f32) -> Option<StartHit> {
    if l.new_button.contains(x, y) {
        return Some(StartHit::New);
    }
    if l.recent.contains(x, y) && y >= HEADER_H {
        return (0..recents.len()).find(|&i| recent_row(i, l, recent_scroll).contains(x, y)).map(StartHit::Recent);
    }
    if l.list.contains(x, y) {
        if all.is_empty() {
            return l.empty_link.contains(x, y).then_some(StartHit::EmptyCreate);
        }
        return (0..all.len()).find(|&i| browse_row(i, l, browse_scroll).contains(x, y)).map(StartHit::Browse);
    }
    None
}

fn item_of<'a>(h: StartHit, recents: &'a [StartItem], all: &'a [StartItem]) -> Option<&'a StartItem> {
    match h {
        StartHit::Recent(i) => recents.get(i),
        StartHit::Browse(i) => all.get(i),
        _ => None,
    }
}

impl StartPageNode {
    fn name_of(&self, vm: &dyn ViewModel, item: &StartItem) -> String {
        if item.title.is_empty() {
            self.untitled.resolve(vm)
        } else {
            item.title.clone()
        }
    }

    fn date_of(&self, vm: &dyn ViewModel, item: &StartItem) -> String {
        short_date(&item.updated_at, &self.months.resolve(vm), &self.date_short.resolve(vm))
    }

    fn fire(&mut self, cx: &mut PaintCx<'_>, command: &str, id: String, x: f32, y: f32, bounds: Rect) {
        let client = crate::common::to_client(Rect::new(bounds.left + x, bounds.top + y, bounds.left + x, bounds.top + y));
        let mut args = StartCommandEventArgs { command: command.to_string(), id, x, y, client_x: client.left, client_y: client.top };
        let kind = ViewEventKind::Other { name: "StartCommand", args: std::rc::Rc::new(args.clone()) };
        cx.fire("OnStartCommand", self.focus_id, self.on_start_command.as_deref(), kind, &mut args);
    }

    /// The pointer over the page: hover, click (press and release over the same target), right
    /// click on a row, wheel over a column.
    fn interact(&mut self, cx: &mut PaintCx<'_>, bounds: Rect, l: &StartLayout, recents: &[StartItem], all: &[StartItem]) {
        let frame = cx.frame;
        let (x, y) = (frame.mouse.0 - bounds.left, frame.mouse.1 - bounds.top);
        let over = !frame.pointer_outside() && bounds.contains(frame.mouse.0, frame.mouse.1);
        let s = &mut self.state;
        let h = if over { hit_at(l, recents, all, s.recent_scroll, s.browse_scroll, x, y) } else { None };
        s.hot = h;
        let down = frame.mouse_down;
        let pressed_now = down && !s.was_down;
        let released = !down && s.was_down;
        s.was_down = down;
        let right_now = frame.right_down && !s.was_right_down;
        s.was_right_down = frame.right_down;
        if pressed_now {
            s.pressed = h;
        }
        // The wheel scrolls the column under the pointer.
        let (_, wy) = frame.wheel_dip();
        if over && wy != 0.0 && !host::wheel_claimed() {
            let step = frame.wheel.1 * WHEEL_STEP;
            if x < l.recent.right {
                let max = max_scroll(recents.len(), RECENT_ROW_H, l.recent.bottom - HEADER_H);
                s.recent_scroll = (s.recent_scroll + step).clamp(0.0, max);
            } else {
                let max = max_scroll(all.len(), BROWSE_ROW_H, l.list.bottom - l.list.top);
                s.browse_scroll = (s.browse_scroll + step).clamp(0.0, max);
            }
            host::claim_wheel();
        }
        let mut command: Option<(&str, String)> = None;
        if right_now {
            // `onContextMenu`: the row's actions (open, duplicate, trash).
            s.pressed = None;
            if let Some(it) = h.and_then(|h| item_of(h, recents, all)) {
                command = Some(("menu", it.id.clone()));
            }
        } else if released {
            if let Some(p) = s.pressed.take().filter(|p| Some(*p) == h) {
                command = match p {
                    StartHit::New | StartHit::EmptyCreate => Some(("new", String::new())),
                    StartHit::Recent(_) | StartHit::Browse(_) => item_of(p, recents, all).map(|it| ("open", it.id.clone())),
                };
            }
        }
        if let Some((name, id)) = command {
            self.fire(cx, name, id, x, y, bounds);
        }
    }

    /// The tooltip of the row under the pointer and the page's parts in the accessibility tree.
    fn offer_services(&self, cx: &mut PaintCx<'_>, bounds: Rect, l: &StartLayout, recents: &[StartItem], all: &[StartItem]) {
        let Some((slot, _)) = cx.sender.clone() else { return };
        let vm: &dyn ViewModel = &*cx.vm;
        let at = |r: Rect| Rect::new(bounds.left + r.left, bounds.top + r.top, bounds.left + r.right, bounds.top + r.bottom);
        let s = &self.state;
        let tip = s.hot.and_then(|h| item_of(h, recents, all)).map(|it| self.name_of(vm, it));
        use host::access::AccessRole;
        let mut parts = vec![(self.new_text.resolve(vm), AccessRole::Button, l.new_button)];
        parts.extend(recents.iter().enumerate().map(|(i, it)| (self.name_of(vm, it), AccessRole::ListItem, recent_row(i, l, s.recent_scroll))));
        parts.extend(all.iter().enumerate().map(|(i, it)| (self.name_of(vm, it), AccessRole::ListItem, browse_row(i, l, s.browse_scroll))));
        if all.is_empty() {
            parts.push((self.empty_create.resolve(vm), AccessRole::Button, l.empty_link));
        }
        let Some(services) = cx.services.as_deref_mut() else { return };
        if let Some(tip) = tip.filter(|t| !t.trim().is_empty()) {
            services.offer_tooltip(tip, crate::clip::visible_client(crate::common::to_client(bounds)), &slot.id);
        }
        let parent = crate::common::access_id(&slot.id);
        for (i, (name, role, r)) in parts.into_iter().enumerate() {
            let c = crate::clip::visible_client(crate::common::to_client(at(r)));
            services.access.push(host::access::AccessNode {
                id: crate::common::access_id(&format!("{}/part{i}", slot.id)),
                parent: Some(parent),
                role,
                name,
                description: String::new(),
                value: None,
                bounds: (c.left, c.top, c.right, c.bottom),
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

impl ViewNode for StartPageNode {
    fn measure(&self, _c: &dyn Canvas, _vm: &dyn ViewModel) -> Size {
        Size::new(900.0, 600.0)
    }

    fn paint(&mut self, cx: &mut PaintCx<'_>, bounds: Rect) {
        let recents_list = self.recents.resolve(&*cx.vm);
        let all_list = self.items.resolve(&*cx.vm);
        let shown = (recents_list.clone(), all_list.clone());
        if !same_list(&self.state.shown.0, &shown.0) || !same_list(&self.state.shown.1, &shown.1) {
            self.state.recent_scroll = 0.0;
            self.state.browse_scroll = 0.0;
            self.state.hot = None;
            self.state.shown = shown;
        }
        let recents: &[StartItem] = recents_list.as_deref().map(Vec::as_slice).unwrap_or(&[]);
        let all: &[StartItem] = all_list.as_deref().map(Vec::as_slice).unwrap_or(&[]);
        let c: &dyn Canvas = cx.canvas;
        let f = c.formats();
        let (w, h) = (bounds.right - bounds.left, bounds.bottom - bounds.top);
        let new_text = self.new_text.resolve(&*cx.vm);
        let l = start_layout(w, h, c.measure(&new_text, &f.body_strong));
        let designing = cx.design.is_some();
        if designing {
            self.state.hot = None;
            self.state.pressed = None;
        } else if !crate::common::is_disabled() {
            self.interact(cx, bounds, &l, recents, all);
        }
        let vm: &dyn ViewModel = &*cx.vm;
        let t = c.theme();
        let at = |r: Rect| Rect::new(bounds.left + r.left, bounds.top + r.top, bounds.left + r.right, bounds.top + r.bottom);
        let icon = |name: &'static str, x: f32, y: f32, size: f32, ink: &D2D1_COLOR_F| {
            c.vector_icon(name, &Rect::new(x - size / 2.0, y - size / 2.0, x + size / 2.0, y + size / 2.0), size, ink);
        };
        let item_icon = crate::icon::resolve_or(&self.item_icon.resolve(vm), "FileText");
        let s = &self.state;
        c.fill_rounded(&bounds, 0.0, &t.card_background);

        // ── « Recent » ──
        let rc = at(l.recent);
        c.fill_rounded(&rc, 0.0, &t.layer_background);
        icon("Clock", rc.left + 16.0 + 7.5, rc.top + HEADER_H / 2.0, 15.0, &t.text_tertiary);
        c.text(&self.recent_text.resolve(vm), &Rect::new(rc.left + 16.0 + 15.0 + 8.0, rc.top, rc.right - 16.0, rc.top + HEADER_H), &f.body_strong, &t.text_primary, false);
        c.fill_rounded(&Rect::new(rc.left, rc.top + HEADER_H - 1.0, rc.right, rc.top + HEADER_H), 0.0, &t.divider);
        let body = Rect::new(rc.left, rc.top + HEADER_H, rc.right, rc.bottom);
        match recents_list.as_deref() {
            Some(items) if !items.is_empty() => {
                c.push_clip(&body);
                for (i, it) in items.iter().enumerate() {
                    let row = at(recent_row(i, &l, s.recent_scroll));
                    if row.bottom < body.top || row.top > body.bottom {
                        continue;
                    }
                    if s.hot == Some(StartHit::Recent(i)) {
                        c.fill_rounded(&row, 0.0, &t.surface_2);
                    }
                    let cy = (row.top + row.bottom) / 2.0;
                    icon(item_icon, row.left + 12.0 + 9.0, cy, 18.0, &t.text_tertiary);
                    let tl = row.left + 12.0 + 18.0 + 10.0;
                    c.text_ellipsis(&self.name_of(vm, it), &Rect::new(tl, row.top + 8.0, row.right - 12.0, row.top + 28.0), &f.body, &t.text_primary);
                    c.text_ellipsis(&self.date_of(vm, it), &Rect::new(tl, row.top + 28.0, row.right - 12.0, row.top + 44.0), &f.role_caption, &t.text_tertiary);
                }
                c.pop_clip();
            }
            other => {
                // `recentEmpty`: the glyph at 30 % and the hint (or, signed out, why there is none).
                let cy = (body.top + body.bottom) / 2.0;
                icon(item_icon, (body.left + body.right) / 2.0, cy - 18.0, 32.0, &with_alpha(t.text_tertiary, 0.3));
                let hint = if other.is_some() { self.recent_empty.resolve(vm) } else { self.signed_out.resolve(vm) };
                c.text(&hint, &Rect::new(body.left + 16.0, cy + 4.0, body.right - 16.0, cy + 44.0), &f.caption, &t.text_tertiary, true);
            }
        }
        // The column's edge (the resize handle's line).
        c.fill_rounded(&Rect::new(rc.right, rc.top, rc.right + 1.0, rc.bottom), 0.0, &t.divider);

        // ── « Browse » ──
        let br = at(l.browse);
        let browse = self.browse_text.resolve(vm);
        let tab_w = c.measure(&browse, &f.body_strong);
        let tab = Rect::new(br.left + 24.0, br.top, br.left + 24.0 + tab_w, br.top + HEADER_H);
        c.text(&browse, &tab, &f.body_strong, &t.accent, false);
        c.fill_rounded(&Rect::new(tab.left, tab.bottom - 2.0, tab.right, tab.bottom), 1.0, &t.accent);
        c.fill_rounded(&Rect::new(br.left, br.top + HEADER_H - 1.0, br.right, br.top + HEADER_H), 0.0, &t.divider);
        // The browser's toolbar: its title and the new button.
        c.text(&self.browse_title.resolve(vm), &Rect::new(br.left + 24.0, br.top + HEADER_H, br.right - 200.0, br.top + HEADER_H + TOOLBAR_H), &f.heading, &t.text_primary, false);
        let nb = at(l.new_button);
        let fill = if s.hot == Some(StartHit::New) { t.accent_hover } else { t.accent };
        c.fill_rounded(&nb, 6.0, &fill);
        icon("Plus", nb.left + 12.0 + 7.0, (nb.top + nb.bottom) / 2.0, 14.0, &t.accent_foreground);
        c.text(&new_text, &Rect::new(nb.left + 12.0 + 14.0 + 6.0, nb.top, nb.right - 8.0, nb.bottom), &f.body_strong, &t.accent_foreground, false);
        let list = at(l.list);
        match all_list.as_deref() {
            Some(items) if !items.is_empty() => {
                c.push_clip(&list);
                for (i, it) in items.iter().enumerate() {
                    let row = at(browse_row(i, &l, s.browse_scroll));
                    if row.bottom < list.top || row.top > list.bottom {
                        continue;
                    }
                    if s.hot == Some(StartHit::Browse(i)) {
                        c.fill_rounded(&row, 6.0, &t.row_hover);
                    }
                    let cy = (row.top + row.bottom) / 2.0;
                    icon(item_icon, row.left + 12.0 + 8.0, cy, 16.0, &t.text_tertiary);
                    c.text_ellipsis(&self.name_of(vm, it), &Rect::new(row.left + 44.0, row.top, row.right - 140.0, row.bottom), &f.body, &t.text_primary);
                    c.text_ellipsis(&self.date_of(vm, it), &Rect::new(row.right - 128.0, row.top, row.right - 12.0, row.bottom), &f.caption, &t.text_tertiary);
                }
                c.pop_clip();
            }
            _ => {
                // The browser's `emptyState`.
                let cy = (list.top + list.bottom) / 2.0;
                let cx_ = (list.left + list.right) / 2.0;
                icon(item_icon, cx_, cy - 36.0, 48.0, &with_alpha(t.text_tertiary, 0.3));
                c.text(&self.empty_title.resolve(vm), &Rect::new(list.left, cy, list.right, cy + 26.0), &f.body_strong, &t.text_secondary, true);
                let link = at(l.empty_link);
                let create = self.empty_create.resolve(vm);
                c.text(&create, &link, &f.body, &t.accent, true);
                if s.hot == Some(StartHit::EmptyCreate) {
                    let tw = c.measure(&create, &f.body);
                    let lx = (link.left + link.right - tw) / 2.0;
                    c.fill_rounded(&Rect::new(lx, link.bottom - 3.0, lx + tw, link.bottom - 2.0), 0.0, &t.accent);
                }
            }
        }
        if !designing {
            self.offer_services(cx, bounds, &l, recents, all);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_date_reads_day_and_short_month_in_the_given_culture() {
        let d = short_date("2026-10-07T06:23:30.292289Z", MONTHS_EN, "{month} {day}");
        assert_eq!(d, "Oct 7");
        let fr = short_date("2026-10-07T06:23:30Z", "janv.,févr.,mars,avr.,mai,juin,juil.,août,sept.,oct.,nov.,déc.", "{day} {month}");
        assert_eq!(fr, "7 oct.");
        assert_eq!(short_date("garbage", MONTHS_EN, "{month} {day}"), "");
        assert_eq!(short_date("2026-13-01T00:00:00Z", MONTHS_EN, "{month} {day}"), "");
    }

    #[test]
    fn the_recent_column_keeps_the_webs_width_and_the_rows_follow_the_header() {
        let l = start_layout(1200.0, 700.0, 120.0);
        assert_eq!(l.recent.right, RECENT_W);
        assert_eq!(recent_row(0, &l, 0.0).top, HEADER_H + 4.0);
        assert_eq!(recent_row(2, &l, 0.0).top, HEADER_H + 4.0 + 2.0 * RECENT_ROW_H);
        assert_eq!(l.list.top, HEADER_H + TOOLBAR_H);
        assert!(l.new_button.right <= l.browse.right - 24.0 + 0.01);
        // A narrow page gives the column at most half of it.
        assert_eq!(start_layout(400.0, 300.0, 120.0).recent.right, 200.0);
    }

    #[test]
    fn a_click_reports_the_row_and_the_new_button() {
        let item = |id: &str| StartItem::new(id, id.to_uppercase(), "2026-10-07T00:00:00Z");
        let (recents, all) = (vec![item("a"), item("b")], vec![item("c")]);
        let l = start_layout(1000.0, 600.0, 120.0);
        let r = recent_row(1, &l, 0.0);
        assert_eq!(hit_at(&l, &recents, &all, 0.0, 0.0, 20.0, r.top + 5.0), Some(StartHit::Recent(1)));
        assert_eq!(item_of(StartHit::Recent(1), &recents, &all).map(|i| i.id.as_str()), Some("b"));
        let b = browse_row(0, &l, 0.0);
        assert_eq!(hit_at(&l, &recents, &all, 0.0, 0.0, b.left + 4.0, b.top + 4.0), Some(StartHit::Browse(0)));
        assert_eq!(item_of(StartHit::Browse(0), &recents, &all).map(|i| i.id.as_str()), Some("c"));
        let n = l.new_button;
        assert_eq!(hit_at(&l, &recents, &all, 0.0, 0.0, n.left + 2.0, n.top + 2.0), Some(StartHit::New));
        // An empty browser offers its link instead of rows.
        let e = l.empty_link;
        assert_eq!(hit_at(&l, &recents, &[], 0.0, 0.0, (e.left + e.right) / 2.0, e.top + 2.0), Some(StartHit::EmptyCreate));
    }

    #[test]
    fn a_list_scrolls_no_further_than_its_rows() {
        assert_eq!(max_scroll(3, RECENT_ROW_H, 600.0), 0.0);
        assert_eq!(max_scroll(20, BROWSE_ROW_H, 400.0), 20.0 * BROWSE_ROW_H + 16.0 - 400.0);
    }

    #[test]
    fn rows_describe_items_and_lists_compare_by_content() {
        let row = crate::binding::Row::new().with("Id", Value::Str("d1".into())).with("Title", Value::Str("Plan".into())).with("UpdatedAt", Value::Str("2026-01-02T00:00:00Z".into()));
        assert_eq!(StartItem::from_row(&row), StartItem::new("d1", "Plan", "2026-01-02T00:00:00Z"));
        let a = Some(Arc::new(vec![StartItem::new("x", "", "")]));
        let b = Some(Arc::new(vec![StartItem::new("x", "", "")]));
        assert!(same_list(&a, &b) && !same_list(&a, &None) && same_list(&None, &None));
    }

    #[test]
    fn start_pages_compile() {
        let src = r#"<Panel><StartPage Recents="{Binding Recents}" Items="{Binding All}" ItemIcon="Network" NewText="New diagram" OnStartCommand="start_command"/><StartPage/></Panel>"#;
        assert!(crate::compile::compile(src).is_ok(), "{:?}", crate::compile::compile(src).err());
        let bad = r#"<Panel><StartPage Recents="a, b"/></Panel>"#;
        assert!(crate::compile::compile(bad).is_err(), "Recents takes a binding only");
    }
}
