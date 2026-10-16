//! What code sets on a named control replaces what the view gives it (Windows Forms: the code's value
//! replaces the designer's), whatever the view wrote - a literal, a resource (`{Res key}`) - and a
//! named element accepts the literals of its view (a `<DockPanel>`'s `Title`).

use kubuno_desktop::prelude::*;
use kubuno_desktop::views::binding::{Value, ViewModel};
use kubuno_desktop::views::runtime::Runtime;
use kubuno_desktop::controls::host::{self, Frame, Modifiers};
use kubuno_desktop::ui::graphics::testing::RecordingCanvas;
use kubuno_desktop::ui::Rect;

#[kubuno_desktop::view(xml = r#"
<Panel DesignWidth="400" DesignHeight="120" Title="Answers">
  <Button x:Name="answer" Text="{Res review_prev}" X="16" Y="16" Width="160" Height="32"/>
</Panel>"#)]
pub struct Answers;

#[kubuno_desktop::view(xml = r#"
<Panel DesignWidth="600" DesignHeight="400">
  <DockArea X="0" Y="0" Width="600" Height="400">
    <DockPanel x:Name="shapes" Title="Formes" Side="Left" Closable="false"><Label Text="shapes body"/></DockPanel>
    <Panel/>
  </DockArea>
</Panel>"#)]
pub struct Docked;

/// The attribute `attr` of the element named `name` in `text`.
fn attribute(text: &str, name: &str, attr: &str) -> Option<String> {
    let start = text.find(&format!("x:Name=\"{name}\""))?;
    let line_start = text[..start].rfind('<')?;
    let element = &text[line_start..];
    let element = &element[..element.find('>')?];
    let at = element.find(&format!(" {attr}=\""))? + attr.len() + 3;
    element[at..].split('"').next().map(str::to_string)
}

fn frame() -> Frame {
    Frame {
        size: (600.0, 400.0),
        mouse: (host::POINTER_AWAY, host::POINTER_AWAY),
        mouse_down: false,
        right_down: false,
        middle_down: false,
        dismiss: false,
        scale: 1.0,
        client_origin: (0.0, 0.0),
        work_area: (0.0, 0.0, 600.0, 400.0),
        chrome_top: 0.0,
        mods: Modifiers::NONE,
        wheel: (0.0, 0.0),
        click_count: 0,
        window_focused: true,
    }
}

/// Composes `view`'s form, compiles it and paints one frame; returns the canvas calls.
fn paint<V: View>(view: &mut V) -> Vec<String> {
    let text = kubuno_desktop::__private::compose_text(view.form());
    let mut runtime = Runtime::new();
    assert!(runtime.reload_from_text(&text), "{text}\n{:?}", runtime.diagnostics());
    let canvas = RecordingCanvas::new();
    for _ in 0..2 {
        runtime.frame_model(&canvas, &frame(), view, Rect::new(0.0, 0.0, 600.0, 400.0));
    }
    canvas.calls()
}

#[test]
fn text_set_from_code_replaces_a_resource_of_the_view() {
    // Set before the view is shown (a dialog's constructor).
    let mut view = Answers::default();
    view.initialize_component();
    view.answer.set_text("Garder ma version");
    let text = kubuno_desktop::__private::compose_text(view.form());
    let bound = attribute(&text, "answer", "Text").expect("Text");
    assert!(bound.starts_with("{Binding __kb."), "bound to the control's value, not to the resource: {text}");
    let path = bound.trim_start_matches("{Binding ").split(',').next().map(str::to_string).expect("path");
    assert_eq!(view.form().get(&path), Some(Value::Str("Garder ma version".into())));
    assert_eq!(view.answer.get_text(), "Garder ma version");

    // Set again while it is shown: still the code's.
    view.answer.set_text("Prendre la leur");
    let text = kubuno_desktop::__private::compose_text(view.form());
    let bound = attribute(&text, "answer", "Text").expect("Text");
    let path = bound.trim_start_matches("{Binding ").split(',').next().map(str::to_string).expect("path");
    assert_eq!(view.form().get(&path), Some(Value::Str("Prendre la leur".into())));
}

#[test]
fn a_resource_the_code_never_replaced_stays_bound_to_the_resource() {
    let mut view = Answers::default();
    view.initialize_component();
    let text = kubuno_desktop::__private::compose_text(view.form());
    assert_eq!(attribute(&text, "answer", "Text").as_deref(), Some("{Res review_prev}"), "{text}");
}

#[test]
fn a_named_dock_panel_keeps_its_title_and_code_can_change_it() {
    let mut view = Docked::default();
    view.initialize_component();
    let calls = paint(&mut view);
    assert!(calls.iter().any(|c| c.contains("\"Formes\"")), "the literal title shows: {calls:#?}");
    view.shapes.set_property("Title", "Shapes");
    let calls = paint(&mut view);
    assert!(calls.iter().any(|c| c.contains("\"Shapes\"")), "the title set from code shows: {calls:#?}");
    assert!(!calls.iter().any(|c| c.contains("\"Formes\"")), "{calls:#?}");
}
