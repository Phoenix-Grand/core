//! An open ribbon drop-down (a menu, a gallery) is light-dismiss, as in Office: while it is open the rest of
//! the view does not see the pointer, so the press that closes it - or picks one of its items over the page -
//! never reaches the control under it, nor does its release.

use std::cell::RefCell;

use kubuno_desktop_controls::host::{self, Frame, Modifiers};
use kubuno_desktop_ui::graphics::testing::RecordingCanvas;
use kubuno_desktop_ui::Rect;
use kubuno_desktop_views::binding::{HandlerTable, MapViewModel, Value, ViewModel};
use kubuno_desktop_views::runtime::Runtime;

const WINDOW: Rect = Rect { left: 0.0, top: 0.0, right: 900.0, bottom: 600.0 };

thread_local! {
    static RAN: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
}

const VIEW: &str = r#"<Panel DesignWidth="900" DesignHeight="600">
  <Ribbon x:Name="ribbon" Dock="Top">
    <RibbonTab Header="Accueil">
      <RibbonGroup Header="Groupe">
        <RibbonMenuButton Label="Menu" Size="Large">
          <RibbonMenuItem Label="Premier" OnClick="picked"/>
        </RibbonMenuButton>
      </RibbonGroup>
    </RibbonTab>
  </Ribbon>
  <Panel Dock="Fill">
    <Button Text="Under" X="0" Y="0" Width="900" Height="400" OnClick="under_click"/>
  </Panel>
</Panel>"#;

fn frame_at(mouse: Option<(f32, f32)>, down: bool) -> Frame {
    let (x, y) = mouse.unwrap_or((host::POINTER_AWAY, host::POINTER_AWAY));
    Frame {
        size: (WINDOW.right, WINDOW.bottom),
        mouse: (x, y),
        mouse_down: down,
        right_down: false,
        middle_down: false,
        dismiss: false,
        scale: 1.0,
        client_origin: (0.0, 0.0),
        work_area: (0.0, 0.0, WINDOW.right, WINDOW.bottom),
        chrome_top: 0.0,
        mods: Modifiers::NONE,
        wheel: (0.0, 0.0),
        click_count: 1,
        window_focused: true,
    }
}

fn rect_of(call: &str) -> Option<Rect> {
    call.split(['(', ')', ' ']).find_map(|token| {
        let v: Vec<f32> = token.split(',').map(|n| n.parse::<f32>()).collect::<Result<_, _>>().ok()?;
        (v.len() == 4).then(|| Rect::new(v[0], v[1], v[2], v[3]))
    })
}

struct Harness {
    rt: Runtime,
    vm: MapViewModel,
    handlers: HandlerTable,
}

impl Harness {
    fn new() -> Self {
        let mut rt = Runtime::new();
        assert!(rt.reload_from_text(VIEW), "{:?}", rt.diagnostics());
        let mut handlers = HandlerTable::new();
        handlers.insert("under_click", Box::new(|_: &mut dyn ViewModel, _: Value| RAN.with(|r| r.borrow_mut().push("under"))));
        handlers.insert("picked", Box::new(|_: &mut dyn ViewModel, _: Value| RAN.with(|r| r.borrow_mut().push("picked"))));
        Self { rt, vm: MapViewModel::new(), handlers }
    }

    fn paint(&mut self, mouse: Option<(f32, f32)>, down: bool) -> Vec<String> {
        let canvas = RecordingCanvas::new();
        self.rt.frame(&canvas, &frame_at(mouse, down), &mut self.vm, &mut self.handlers, WINDOW);
        canvas.calls()
    }

    fn click(&mut self, at: (f32, f32)) -> Vec<String> {
        self.paint(Some(at), false);
        self.paint(Some(at), true);
        self.paint(Some(at), false);
        self.paint(None, false)
    }
}

#[test]
fn the_click_that_closes_a_ribbon_drop_down_does_not_reach_the_page() {
    RAN.with(|r| r.borrow_mut().clear());
    let mut h = Harness::new();
    let calls = h.paint(None, false);
    let under = calls.iter().find(|c| c.contains("text(\"Under\"")).and_then(|c| rect_of(c)).unwrap_or_else(|| panic!("{calls:#?}"));
    let menu = calls.iter().find(|c| c.contains("text(\"Menu\"")).and_then(|c| rect_of(c)).unwrap_or_else(|| panic!("{calls:#?}"));
    // A click on the page alone reaches the button.
    let on_page = ((under.left + under.right) / 2.0, under.bottom - 20.0);
    h.click(on_page);
    assert_eq!(RAN.with(|r| std::mem::take(&mut *r.borrow_mut())), ["under"]);
    // The menu button opens its drop-down; a press on the page then only closes it.
    h.click(((menu.left + menu.right) / 2.0, (menu.top + menu.bottom) / 2.0));
    h.click(on_page);
    assert_eq!(RAN.with(|r| std::mem::take(&mut *r.borrow_mut())), Vec::<&str>::new(), "the dismissing click went through");
    // Closed: the page takes clicks again.
    h.click(on_page);
    assert_eq!(RAN.with(|r| std::mem::take(&mut *r.borrow_mut())), ["under"]);
}
