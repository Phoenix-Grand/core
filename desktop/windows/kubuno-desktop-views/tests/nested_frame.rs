//! A handler that runs another view's frames before it returns - a modal dialog's nested loop
//! (`ShowDialog`) opened from a click - paints that view as if no other frame were running: nothing
//! of the owner's frame in progress (the clip of the container the clicked control sits in, a
//! disabled ancestor, the drawings deferred to the end of the frame) reaches the dialog, and the
//! owner's frame finds its own state again when the handler returns.

use std::cell::RefCell;

use kubuno_desktop_controls::host::{self, Frame, Modifiers};
use kubuno_desktop_ui::graphics::testing::RecordingCanvas;
use kubuno_desktop_ui::Rect;
use kubuno_desktop_views::binding::{HandlerTable, MapViewModel, Value, ViewModel};
use kubuno_desktop_views::runtime::Runtime;

const OWNER: Rect = Rect { left: 0.0, top: 0.0, right: 800.0, bottom: 600.0 };
const DIALOG: Rect = Rect { left: 0.0, top: 0.0, right: 400.0, bottom: 300.0 };

/// The owner: a band (a ribbon's place, 32–146) holding the button whose click opens the dialog.
const OWNER_VIEW: &str = r#"<Panel DesignWidth="800" DesignHeight="600">
  <Panel x:Name="band" X="0" Y="32" Width="800" Height="114">
    <Button x:Name="open" Text="Open" OnClick="open_click" X="10" Y="40" Width="100" Height="30"/>
  </Panel>
  <Label x:Name="below" Text="Below the band" X="10" Y="300" Width="200" Height="22"/>
</Panel>"#;

/// The dialog: a first control above the band, a button below it.
const DIALOG_VIEW: &str = r#"<Panel DesignWidth="400" DesignHeight="300">
  <Label x:Name="first" Text="First control" X="16" Y="8" Width="200" Height="22"/>
  <Button x:Name="ok" Text="Bottom button" X="16" Y="250" Width="140" Height="32"/>
</Panel>"#;

thread_local! {
    /// What the dialog's frames painted (each frame's calls).
    static DIALOG_CALLS: RefCell<Vec<Vec<String>>> = const { RefCell::new(Vec::new()) };
}

fn frame_at(size: Rect, mouse: Option<(f32, f32)>, down: bool) -> Frame {
    let (x, y) = mouse.unwrap_or((host::POINTER_AWAY, host::POINTER_AWAY));
    Frame {
        size: (size.right, size.bottom),
        mouse: (x, y),
        mouse_down: down,
        right_down: false,
        middle_down: false,
        dismiss: false,
        scale: 1.0,
        client_origin: (0.0, 0.0),
        work_area: (0.0, 0.0, size.right, size.bottom),
        chrome_top: 0.0,
        mods: Modifiers::NONE,
        wheel: (0.0, 0.0),
        click_count: 1,
        window_focused: true,
    }
}

fn runtime(view: &str) -> Runtime {
    let mut rt = Runtime::new();
    assert!(rt.reload_from_text(view), "{:?}", rt.diagnostics());
    rt
}

/// The rectangle a recorded call names (`fill_rounded(1,2,3,4 r=2)` → 1,2,3,4).
fn rect_of(call: &str) -> Option<Rect> {
    call.split(['(', ')', ' ']).find_map(|token| {
        let v: Vec<f32> = token.split(',').map(|n| n.parse::<f32>()).collect::<Result<_, _>>().ok()?;
        (v.len() == 4).then(|| Rect::new(v[0], v[1], v[2], v[3]))
    })
}

/// The part of the call containing `needle` left visible by the clips in force when it was made.
fn visible(calls: &[String], needle: &str) -> Option<Rect> {
    let mut clips: Vec<Rect> = Vec::new();
    for call in calls {
        if call.starts_with("push_clip(") {
            clips.push(rect_of(call).unwrap_or(DIALOG));
            continue;
        }
        if call == "pop_clip" {
            clips.pop();
            continue;
        }
        if !call.contains(needle) {
            continue;
        }
        let r = rect_of(call)?;
        let v = clips.iter().fold(r, |v, c| Rect::new(v.left.max(c.left), v.top.max(c.top), v.right.min(c.right), v.bottom.min(c.bottom)));
        return Some(v);
    }
    None
}

/// Runs the dialog's frames, as a nested loop would, from inside the owner's click handler.
fn open_dialog(_vm: &mut dyn ViewModel, _value: Value) {
    let mut rt = runtime(DIALOG_VIEW);
    let mut vm = MapViewModel::new();
    let mut handlers = HandlerTable::new();
    for _ in 0..2 {
        let canvas = RecordingCanvas::new();
        rt.frame(&canvas, &frame_at(DIALOG, None, false), &mut vm, &mut handlers, DIALOG);
        DIALOG_CALLS.with(|c| c.borrow_mut().push(canvas.calls()));
    }
}

#[test]
fn a_dialog_opened_from_a_click_paints_whole_and_the_owner_frame_resumes() {
    DIALOG_CALLS.with(|c| c.borrow_mut().clear());
    let mut owner = runtime(OWNER_VIEW);
    let mut vm = MapViewModel::new();
    let mut handlers = HandlerTable::new();
    handlers.insert("open_click", Box::new(open_dialog));
    let at = Some((60.0, 32.0 + 40.0 + 15.0));
    let mut owner_calls = Vec::new();
    for (mouse, down) in [(at, false), (at, true), (at, false), (None, false)] {
        let canvas = RecordingCanvas::new();
        owner.frame(&canvas, &frame_at(OWNER, mouse, down), &mut vm, &mut handlers, OWNER);
        owner_calls.push(canvas.calls());
    }
    let frames = DIALOG_CALLS.with(|c| c.borrow().clone());
    assert!(!frames.is_empty(), "the click opened the dialog");
    for calls in &frames {
        // Neither the first control (above the owner's band) nor the bottom button (below it) is cut.
        let first = visible(calls, "text(\"First control\"").unwrap_or_else(|| panic!("the first control is painted: {calls:#?}"));
        assert!(first.bottom - first.top > 10.0 && first.top < 32.0, "the first control is cut: {first:?} {calls:#?}");
        let bottom = visible(calls, "text(\"Bottom button\"").unwrap_or_else(|| panic!("the bottom button is painted: {calls:#?}"));
        assert!(bottom.bottom - bottom.top > 10.0 && bottom.top > 146.0, "the bottom button is cut: {bottom:?} {calls:#?}");
    }
    // The owner's frame went on with its own state: what it painted after the click is still there,
    // cut by nothing.
    for calls in &owner_calls {
        let below = visible(calls, "text(\"Below the band\"").unwrap_or_else(|| panic!("the owner paints after the dialog: {calls:#?}"));
        assert!(below.bottom - below.top > 10.0, "{below:?}");
    }
}
