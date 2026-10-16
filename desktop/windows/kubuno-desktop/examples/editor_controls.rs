//! The generic editor controls of the core, built in code: a `StartPage` (recent files and a
//! browser), a status bar row with an `AvatarStack` (the people present) and two `ZoomControl`s
//! (the linear 50-200 % slider of Diagrams, and the Documents one centred on 100 %), and a
//! `NotifyIcon` whose balloons report what the start page asked.
//!
//! `cargo run -p kubuno-desktop --example editor_controls`.
#![windows_subsystem = "windows"]

use std::rc::Rc;

use kubuno_desktop::forms::{AvatarStack, StartCommandEventArgs, StartItem, StartPage, ZoomControl};
use kubuno_desktop::prelude::*;

fn sample_items() -> (Vec<StartItem>, Vec<StartItem>) {
    let item = |id: &str, title: &str, date: &str| StartItem::new(id, title, date);
    let recents = vec![
        item("d1", "Network map", "2026-10-07T06:23:30Z"),
        item("d2", "Quarterly plan", "2026-10-02T09:00:00Z"),
        item("d3", "", "2026-09-28T17:45:00Z"),
    ];
    let mut all = recents.clone();
    all.extend((4..=24).map(|i| StartItem::new(format!("d{i}"), format!("Diagram {i}"), format!("2026-08-{:02}T08:00:00Z", (i % 28) + 1))));
    (recents, all)
}

fn main() -> kubuno_desktop::Result {
    let form = Form::new().text("Editor controls").client_size(980.0, 640.0).start_position(StartPosition::CenterScreen);

    let start = StartPage::new().name("start").bounds(0.0, 0.0, 980.0, 588.0).anchor(Anchor::TOP | Anchor::LEFT | Anchor::RIGHT | Anchor::BOTTOM);
    start.set_text_property("ItemIcon", "Network");
    start.set_text_property("NewText", "New diagram");
    start.set_text_property("BrowseTitle", "Diagrams");
    let (recents, all) = sample_items();
    start.set_lists(Some(recents), Some(all));

    let status = Label::new().name("status").text("Click a file, right-click it, or create one.").bounds(16.0, 600.0, 260.0, 28.0).anchor(Anchor::BOTTOM | Anchor::LEFT);
    let signed_out = Button::new().name("signed_out").text("Sign out").bounds(284.0, 598.0, 96.0, 32.0).anchor(Anchor::BOTTOM | Anchor::LEFT);
    let people = AvatarStack::new().name("people").bounds(388.0, 598.0, 132.0, 32.0).anchor(Anchor::BOTTOM | Anchor::RIGHT);
    people.set_users([("Martinien Olinga", "#1a73e8"), ("Ana Lima", ""), ("Bob Martin", "#d93025"), ("Chloé Petit", ""), ("Dan Wu", "#1e8e3e"), ("Eve Adams", ""), ("Frank Li", "")]);
    let zoom = ZoomControl::new().name("zoom").value(100.0).bounds(524.0, 600.0, 228.0, 28.0).anchor(Anchor::BOTTOM | Anchor::RIGHT);
    let page_zoom = ZoomControl::new().name("page_zoom").value(100.0).range(10.0, 500.0).centered(10.0, 500.0).bounds(752.0, 600.0, 228.0, 28.0).anchor(Anchor::BOTTOM | Anchor::RIGHT);
    page_zoom.set_property("ButtonSnap", true);
    form.controls().add_range(&[&start, &status, &signed_out, &people, &zoom, &page_zoom]);

    // The notification area icon: one per application, kept as long as the form.
    let tray = Rc::new(NotifyIcon::new().text("Editor controls"));

    let (label, icon) = (status.clone(), tray.clone());
    start.start_command().subscribe(move |_sender, e: &mut StartCommandEventArgs| {
        let text = match e.command.as_str() {
            "open" => format!("Open {}", e.id),
            "menu" => format!("Menu of {} at {:.0}, {:.0}", e.id, e.x, e.y),
            _ => "New diagram".to_string(),
        };
        label.set_text(text.clone());
        if e.command != "menu" {
            icon.show_balloon_tip("Start page", &text, 5_000);
        }
    });

    let s = start.clone();
    signed_out.click().subscribe(move |_sender, _e| s.set_lists(None, None));

    let label = status.clone();
    zoom.value_changed().subscribe(move |_sender, e: &mut NumericValueChangedEventArgs| label.set_text(format!("Zoom {} %", e.new.round())));
    let label = status.clone();
    page_zoom.value_changed().subscribe(move |_sender, e: &mut NumericValueChangedEventArgs| label.set_text(format!("Page zoom {} %", e.new.round())));

    kubuno_desktop::Application::run(form)
}
