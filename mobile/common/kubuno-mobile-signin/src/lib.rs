//! The Kubuno mobile sign-in, shared by every app.
//!
//! Three screens built from the shared controls — server, credentials, two-step verification ([`VIEWS`]) — and the
//! flow that drives them over the account layer: check the server (`GET /health`), sign in natively, verify the
//! second factor when the account has one, then hand the app a [`Session`]. An app adds [`VIEWS`] to its own screens,
//! shows `VIEWS[`[`view_index`]`()]` while signing in, passes its events to [`handle`], and receives the session in the
//! callback it gave to [`start`].
//!
//! Network calls run on the account layer's background runtime; their results come back to the UI thread through the
//! renderer's `post_ui`. A result that arrives after the user went back a step is dropped. The password never outlives
//! the sign-in: the typed values are cleared once the session is open.

use std::cell::RefCell;

use kubuno_mobile_account::{
    accounts, device_key, login as request_login, normalize_server, platform_store, probe_server, spawn,
    verify_totp, AccountError, ApiError, LoginOptions, LoginOutcome, NativeTokens, Session, TotpPending,
};
use kubuno_mobile_render::{input_clear, input_focus, input_set_value, input_value, post_ui, set_data, Scope, TapEvent};

/// The server screen.
pub const SERVER: &str = include_str!("views/signin_server.kbview");
/// The credentials screen.
pub const LOGIN: &str = include_str!("views/signin_login.kbview");
/// The two-step verification screen.
pub const TOTP: &str = include_str!("views/signin_totp.kbview");
/// The sign-in screens, in [`Step`] order: an app appends them to its own screens.
pub const VIEWS: &[&str] = &[SERVER, LOGIN, TOTP];

/// Where the sign-in stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Server,
    Login,
    Totp,
}

struct Flow {
    step: Step,
    app: String,
    server: String,
    device_key: String,
    pending: Option<TotpPending>,
    error: String,
    busy: String,
    done: Option<fn(Session)>,
    /// Bumped whenever the step changes, so a late network result for an abandoned step is ignored.
    generation: u64,
}

thread_local! {
    static FLOW: RefCell<Flow> = RefCell::new(Flow {
        step: Step::Server,
        app: String::new(),
        server: String::new(),
        device_key: String::new(),
        pending: None,
        error: String::new(),
        busy: String::new(),
        done: None,
        generation: 0,
    });
}

/// Start (or restart) the sign-in for the app named `app_label`; `done` receives the session once it is open (on the
/// UI thread). The server field is prefilled with the last server used on this phone.
pub fn start(app_label: &str, done: fn(Session)) {
    let store = platform_store();
    let key = device_key(store.as_ref()).unwrap_or_else(|e| {
        log::error!("KUBUNO: no device key ({e}); using a temporary one");
        format!("temporary-{}", std::process::id())
    });
    // The first characters of the device key (an inventory identifier, not a secret): the same prefix across launches
    // shows the OS secret store keeps what it is given.
    log::info!("KUBUNO: sign-in, device key {}...", key.chars().take(8).collect::<String>());
    let last_server = accounts(store.as_ref()).ok().and_then(|a| a.first().map(|a| a.server.clone()));
    FLOW.with(|f| {
        let mut f = f.borrow_mut();
        f.step = Step::Server;
        f.app = app_label.to_string();
        f.server = last_server.clone().unwrap_or_default();
        f.device_key = key;
        f.pending = None;
        f.error.clear();
        f.busy.clear();
        f.done = Some(done);
        f.generation += 1;
    });
    input_clear();
    if let Some(server) = last_server {
        input_set_value("signin_server_url", &server);
    }
    publish();
}

/// The current step.
pub fn step() -> Step {
    FLOW.with(|f| f.borrow().step)
}

/// The index into [`VIEWS`] of the screen to show now.
pub fn view_index() -> usize {
    match step() {
        Step::Server => 0,
        Step::Login => 1,
        Step::Totp => 2,
    }
}

/// Handle an event of the sign-in screens. Returns `false` for an event that is not the sign-in's.
pub fn handle(ev: &TapEvent) -> bool {
    match ev.handler.as_str() {
        "signin_server_next" => server_next(),
        "signin_submit" => submit(),
        "signin_verify" => verify(),
        "signin_change_server" | "signin_back" => back(),
        _ => return false,
    }
    true
}

/// The data the sign-in screens bind to.
fn publish() {
    let scope = FLOW.with(|f| {
        let f = f.borrow();
        let host = f.server.split_once("://").map(|(_, h)| h.to_string()).unwrap_or_else(|| f.server.clone());
        Scope::new()
            .set("signin_app", f.app.clone())
            .set("signin_host", host)
            .set("signin_error", f.error.clone())
            .set("signin_busy", f.busy.clone())
    });
    set_data(scope);
}

/// Enter a busy state for a network call; returns the generation the result must still match and the device key.
fn begin(busy: &str) -> Option<(u64, String)> {
    FLOW.with(|f| {
        let mut f = f.borrow_mut();
        if !f.busy.is_empty() {
            return None;
        }
        f.busy = busy.to_string();
        f.error.clear();
        Some((f.generation, f.device_key.clone()))
    })
    .inspect(|_| publish())
}

/// Whether a result for `generation` still belongs to the step on screen.
fn current(generation: u64) -> bool {
    FLOW.with(|f| f.borrow().generation == generation)
}

fn set_error(message: String) {
    FLOW.with(|f| {
        let mut f = f.borrow_mut();
        f.error = message;
        f.busy.clear();
    });
    publish();
}

fn go(step: Step) {
    FLOW.with(|f| {
        let mut f = f.borrow_mut();
        f.step = step;
        f.busy.clear();
        f.error.clear();
        f.generation += 1;
    });
    publish();
}

fn fail(e: &AccountError) {
    log::warn!("KUBUNO: sign-in step failed: {e}");
    set_error(message(e));
}

fn server_next() {
    let typed = input_value("signin_server_url").unwrap_or_default();
    let server = match normalize_server(&typed) {
        Ok(s) => s,
        Err(e) => return fail(&e),
    };
    let Some((generation, device_key)) = begin("Vérification du serveur…") else { return };
    spawn(async move {
        let result = probe_server(&server, &device_key).await;
        post_ui(move || {
            if !current(generation) {
                return;
            }
            match result {
                Ok(version) => {
                    log::info!("KUBUNO: Kubuno server {server} (version {version})");
                    FLOW.with(|f| f.borrow_mut().server = server);
                    go(Step::Login);
                    input_focus("signin_login");
                }
                Err(e) => fail(&e),
            }
        });
    });
}

fn submit() {
    let login = input_value("signin_login").unwrap_or_default().trim().to_string();
    let password = input_value("signin_password").unwrap_or_default();
    if login.is_empty() || password.is_empty() {
        return set_error("Saisissez votre identifiant et votre mot de passe.".into());
    }
    let Some((generation, device_key)) = begin("Connexion…") else { return };
    let (server, app) = FLOW.with(|f| (f.borrow().server.clone(), f.borrow().app.clone()));
    let opts = LoginOptions {
        server,
        device_key,
        device_name: format!("{app} ({})", std::env::consts::OS),
        login,
        password,
    };
    spawn(async move {
        let result = request_login(opts).await;
        post_ui(move || {
            if !current(generation) {
                return;
            }
            match result {
                Ok(LoginOutcome::Tokens(tokens)) => finish(tokens),
                Ok(LoginOutcome::TotpRequired(pending)) => {
                    FLOW.with(|f| f.borrow_mut().pending = Some(pending));
                    go(Step::Totp);
                    input_focus("signin_code");
                }
                Err(e) => fail(&e),
            }
        });
    });
}

fn verify() {
    let code = input_value("signin_code").unwrap_or_default().trim().to_string();
    if code.is_empty() {
        return set_error("Saisissez le code.".into());
    }
    let Some(pending) = FLOW.with(|f| f.borrow().pending.clone()) else { return go(Step::Login) };
    let Some((generation, _)) = begin("Vérification…") else { return };
    spawn(async move {
        let result = verify_totp(&pending, &code).await;
        post_ui(move || {
            if !current(generation) {
                return;
            }
            match result {
                Ok(tokens) => finish(tokens),
                Err(e) => fail(&e),
            }
        });
    });
}

fn back() {
    match step() {
        Step::Totp => {
            FLOW.with(|f| f.borrow_mut().pending = None);
            go(Step::Login);
        }
        Step::Login | Step::Server => go(Step::Server),
    }
}

/// Open the session, forget what was typed (the password above all) and hand the session to the app.
fn finish(tokens: NativeTokens) {
    let (server, device_key, done) = FLOW.with(|f| {
        let f = f.borrow();
        (f.server.clone(), f.device_key.clone(), f.done)
    });
    match Session::adopt(platform_store(), &server, &device_key, tokens) {
        Ok(session) => {
            log::info!("KUBUNO: signed in to {server} as {}", session.account.label);
            input_clear();
            FLOW.with(|f| {
                let mut f = f.borrow_mut();
                f.busy.clear();
                f.error.clear();
                f.pending = None;
                f.generation += 1;
            });
            if let Some(done) = done {
                done(session);
            }
        }
        Err(e) => fail(&e),
    }
}

/// What to tell the user about a failed step.
pub fn message(e: &AccountError) -> String {
    match e {
        AccountError::InvalidServer => "Adresse de serveur invalide.".into(),
        AccountError::NotKubuno => "Cette adresse ne répond pas comme un serveur Kubuno.".into(),
        AccountError::Secret(_) => "Impossible d'enregistrer la session sur cet appareil.".into(),
        AccountError::Protocol(_) => "Réponse inattendue du serveur.".into(),
        AccountError::Api(api) => match api.status() {
            Some(401) | Some(403) => "Identifiant, mot de passe ou code incorrect.".into(),
            Some(429) => "Trop de tentatives. Réessayez dans une minute.".into(),
            Some(s) if s >= 500 => "Le serveur rencontre un problème. Réessayez plus tard.".into(),
            Some(s) => format!("Le serveur a refusé la demande (HTTP {s})."),
            None => match api {
                ApiError::Network { .. } => "Serveur injoignable. Vérifiez l'adresse et votre connexion.".into(),
                _ => "Réponse inattendue du serveur.".into(),
            },
        },
    }
}
