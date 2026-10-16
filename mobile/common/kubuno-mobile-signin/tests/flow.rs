//! The shared sign-in screens driven like a user would - typing into the fields, pressing Enter, tapping - against the
//! mock Kubuno core of the account layer, with a UI loop that drains the tasks the network calls post back.

#[path = "../../kubuno-mobile-account/tests/mock/mod.rs"]
mod mock;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use kubuno_mobile_render::{input_key, input_value, render_view, run_ui_tasks, InputKey, TapEvent};
use kubuno_mobile_signin::{handle, start, step, view_index, Step, VIEWS};

static SIGNED_IN: Mutex<Option<String>> = Mutex::new(None);

fn done(session: kubuno_mobile_account::Session) {
    *SIGNED_IN.lock().unwrap() = Some(session.account.label);
}

/// Lay out the screen on show (so the text input knows its fields), like the shell does each frame.
fn frame() {
    let hits = kubuno_mobile_render::view_hits(VIEWS[view_index()], 390, 844, None, Some((0.0, 0.0)));
    kubuno_mobile_render::register_input_fields(&hits);
    assert!(render_view(VIEWS[view_index()], 390, 844, None, Some((0.0, 0.0))).is_some());
}

/// Type `text` into field `name` (tap it, then keys), then press Enter; hand the raised events to the flow.
fn type_and_enter(name: &str, text: &str) {
    kubuno_mobile_render::input_focus(name);
    for ev in input_key(InputKey::Text(text.into())) {
        handle(&ev);
    }
    for ev in input_key(InputKey::Enter) {
        handle(&ev);
    }
}

fn tap(handler: &str) {
    handle(&TapEvent { name: None, handler: handler.into(), x: 0.0, y: 0.0, text: None, key: None });
}

fn pump_until(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        run_ui_tasks();
        frame();
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_user_signs_in_through_the_shared_screens() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (addr, _mock) = rt.block_on(mock::serve("127.0.0.1:0", 900, 900));

    start("Kubuno Test", done);
    frame();
    assert_eq!(step(), Step::Server);

    // A wrong address first: an error, still on the server screen.
    type_and_enter("signin_server_url", "a b");
    assert_eq!(step(), Step::Server);

    kubuno_mobile_render::input_set_value("signin_server_url", "");
    type_and_enter("signin_server_url", &format!("http://{addr}"));
    pump_until("the credentials screen", || step() == Step::Login);
    frame();

    // Enter in the identifier moves to the password (TabIndex); Enter there signs in.
    assert_eq!(kubuno_mobile_render::input_focused().as_deref(), Some("signin_login"));
    for ev in input_key(InputKey::Text("zoe@kubuno.test".into())) {
        handle(&ev);
    }
    for ev in input_key(InputKey::Enter) {
        handle(&ev);
    }
    assert_eq!(kubuno_mobile_render::input_focused().as_deref(), Some("signin_password"));
    for ev in input_key(InputKey::Text(mock::PASSWORD.into())) {
        handle(&ev);
    }
    for ev in input_key(InputKey::Enter) {
        handle(&ev);
    }
    pump_until("the session", || SIGNED_IN.lock().unwrap().is_some());
    assert_eq!(SIGNED_IN.lock().unwrap().as_deref(), Some("Zoé Test"));
    assert!(input_value("signin_password").is_none(), "the password is forgotten once signed in");

    // Signing in again with a second factor: the code screen, then the session.
    *SIGNED_IN.lock().unwrap() = None;
    start("Kubuno Test", done);
    frame();
    tap("signin_server_next"); // prefilled with the last server
    pump_until("the credentials screen", || step() == Step::Login);
    frame();
    kubuno_mobile_render::input_set_value("signin_login", "totp@kubuno.test");
    kubuno_mobile_render::input_set_value("signin_password", mock::PASSWORD);
    tap("signin_submit");
    pump_until("the code screen", || step() == Step::Totp);
    frame();
    type_and_enter("signin_code", mock::TOTP_CODE);
    pump_until("the second session", || SIGNED_IN.lock().unwrap().is_some());
    assert_eq!(SIGNED_IN.lock().unwrap().as_deref(), Some("Toto Totp"));
}

#[test]
fn every_sign_in_screen_renders() {
    for v in VIEWS {
        assert!(render_view(v, 1080, 2340, None, None).is_some());
    }
}
