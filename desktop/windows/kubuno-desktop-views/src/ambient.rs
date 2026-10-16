//! The state a view's frame keeps in thread-locals while it runs - the clip of the container being
//! painted, the disabled ancestors, the drawings deferred to the end of the frame, the menus shown,
//! the `<Repeater>` item being handled… - and how a frame that runs INSIDE another one is kept apart
//! from it.
//!
//! A frame can start while another one is running on the same thread: a handler raised during the
//! paint (a ribbon command, a button's click) opens a modal dialog, whose nested message loop paints
//! the dialog's view before the handler returns (`ShowDialog`). The owner's frame is then stopped in
//! the middle of its paint, with its own clip, disabled scope, deferred drawings… in force. Without
//! this module the dialog would inherit them: laid out against the clip of the container the
//! command came from (a dialog opened from a ribbon showed only the ribbon's 32–146 DIP band), its
//! late drawings flushed by the owner, the owner's menu requests taken by the dialog.
//!
//! [`FrameScope::enter`] makes every frame of a [`crate::runtime::Runtime`] see only its own state:
//! a frame that starts while another is running swaps the running frame's state out of the
//! thread-locals and its own state (kept by its runtime between its frames) in, and swaps them back
//! when it ends - even on a panic. A frame that runs alone (the common case) touches nothing: what
//! the caller set for it (the designer's window band) and what a view keeps from one frame to the
//! next are read in place, exactly as before.

use std::cell::{Cell, RefCell};
use std::thread::LocalKey;

use kubuno_desktop_controls::host::Frame;
use kubuno_desktop_ui::Rect;

thread_local! {
    /// How many view frames are running on this thread (more than one: a nested loop).
    static DEPTH: Cell<u32> = const { Cell::new(0) };
}

fn swap_ref<T>(key: &'static LocalKey<RefCell<T>>, value: &mut T) {
    key.with(|c| {
        if let Ok(mut slot) = c.try_borrow_mut() {
            std::mem::swap(&mut *slot, value);
        }
    });
}

fn swap_cell<T: Default>(key: &'static LocalKey<Cell<T>>, value: &mut T) {
    key.with(|c| {
        let installed = c.replace(std::mem::take(value));
        *value = installed;
    });
}

/// Everything a frame keeps in thread-locals (see the module documentation).
#[derive(Default)]
pub(crate) struct Ambient {
    clip: Vec<Rect>,
    disabled: u32,
    design: bool,
    top_layer_hold: Vec<Option<Rect>>,
    real_frame: Option<Frame>,
    node_holds: Vec<Option<Rect>>,
    late: Vec<crate::virtual_regions::Late>,
    design_chrome: Option<crate::window::DesignChrome>,
    declared_slots: kubuno_desktop_controls::window_chrome::SlotWidths,
    menu_requests: Vec<crate::window::MenuRequest>,
    open_menu: Option<String>,
    bar: crate::menus::BarState,
    run_items: Vec<(String, String)>,
    type_slots: Vec<crate::menus::TypeSlot>,
    design_view: Option<Rect>,
    rows: Vec<crate::menus::MenuRow>,
    current_item: Option<crate::binding::ItemContext>,
    sink: Option<std::ptr::NonNull<crate::scope::SinkFn<'static>>>,
    owner_draw: kubuno_desktop_ui::graphics::owner_draw::LentHandlers,
}

impl Ambient {
    /// Exchanges this state with the one in the thread-locals: what was installed comes out, this
    /// state goes in. Its own inverse.
    fn swap(&mut self) {
        swap_ref(&crate::clip::STACK, &mut self.clip);
        swap_cell(&crate::common::DISABLED, &mut self.disabled);
        swap_cell(&crate::common::DESIGN, &mut self.design);
        swap_ref(&crate::node::TOP_LAYER_HOLD, &mut self.top_layer_hold);
        swap_cell(&crate::node::REAL_FRAME, &mut self.real_frame);
        swap_ref(&crate::node::NODE_HOLDS, &mut self.node_holds);
        swap_ref(&crate::virtual_regions::LATE, &mut self.late);
        swap_ref(&crate::window::DESIGN_CHROME, &mut self.design_chrome);
        swap_cell(&crate::window::DECLARED_SLOTS, &mut self.declared_slots);
        swap_ref(&crate::window::MENU_REQUESTS, &mut self.menu_requests);
        swap_ref(&crate::window::OPEN_MENU, &mut self.open_menu);
        swap_ref(&crate::menus::BAR, &mut self.bar);
        swap_ref(&crate::menus::RUN_ITEMS, &mut self.run_items);
        swap_ref(&crate::menus::TYPE_SLOTS, &mut self.type_slots);
        swap_cell(&crate::menus::DESIGN_VIEW, &mut self.design_view);
        swap_ref(&crate::menus::ROWS, &mut self.rows);
        swap_ref(&crate::binding::CURRENT_ITEM, &mut self.current_item);
        swap_cell(&crate::scope::SINK, &mut self.sink);
        kubuno_desktop_ui::graphics::owner_draw::swap_lent(&mut self.owner_draw);
    }
}

/// A view's frame in progress (see the module documentation). Keep it for the whole frame.
pub(crate) struct FrameScope {
    /// The state of the frame this one runs inside of, swapped out while this one runs; `None` for a
    /// frame that runs alone.
    outer: Option<Ambient>,
}

impl FrameScope {
    /// Starts a frame. `own` is the state the runtime kept from its previous nested frame: it is
    /// installed when another frame is running (that frame's state is set aside), and left alone
    /// otherwise.
    pub(crate) fn enter(own: &mut Ambient) -> Self {
        let depth = DEPTH.with(|d| {
            let n = d.get();
            d.set(n + 1);
            n
        });
        if depth == 0 {
            return Self { outer: None };
        }
        let mut state = std::mem::take(own);
        state.swap();
        Self { outer: Some(state) }
    }

    /// Ends the frame; `own` receives what the runtime keeps for its next nested frame.
    pub(crate) fn leave(mut self, own: &mut Ambient) {
        if let Some(mut outer) = self.outer.take() {
            outer.swap();
            *own = outer;
        }
    }
}

impl Drop for FrameScope {
    fn drop(&mut self) {
        // Unwinding without `leave`: the running frame gets its state back all the same.
        if let Some(mut outer) = self.outer.take() {
            outer.swap();
        }
        DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
    }
}
