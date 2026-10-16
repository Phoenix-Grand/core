//! Starting Kubuno Desktop: what every OS entry point does, in one place.
//!
//! An entry point (`desktop/windows/kubuno-desktop-shell`, `desktop/linux/…`, `desktop/macos/…`) is a few lines: it
//! builds its [`Platform`] (the portable defaults, with what that OS overrides) and its [`UiHost`], and calls
//! [`run`].

use crate::instance;
use crate::platform::{self, Platform, StartStep, UiHost};
use crate::services::{backend, session};

/// The command-line flag of a start at logon: the shell starts hidden, with no splash screen.
pub const BACKGROUND_FLAG: &str = "--background";

/// What the command line asked for, as far as the portable app is concerned (an interface reads the rest of the
/// command line itself: the page, the theme, the language).
///
/// - `--background`: a start at logon, hidden until the user opens the shell;
/// - `--sample`: the offline sample, fixed data with no server, nothing read from or written to the configuration
///   and nothing registered with the system; `--live` opts out of the sample a debugging session runs by default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Launch {
    pub background: bool,
    pub sample: bool,
}

impl Launch {
    /// Reads `args` (program name excluded). `debugging`: a Debug build under a debugger, which runs the sample
    /// unless `--live` says otherwise.
    pub fn parse_for(args: impl IntoIterator<Item = String>, debugging: bool) -> Launch {
        let args: Vec<String> = args.into_iter().collect();
        let has = |flag: &str| args.iter().any(|a| a == flag);
        Launch { background: has(BACKGROUND_FLAG), sample: has("--sample") || (debugging && !has("--live")) }
    }

    /// The arguments of this process, as a start without a debugger reads them.
    pub fn from_env() -> Launch {
        Launch::parse_for(std::env::args().skip(1), false)
    }
}

/// Registers `platform`, loads the accounts (outside the sample) and runs `ui` until it closes; returns the exit
/// code.
pub fn run(platform: Platform, ui: &dyn UiHost) -> i32 {
    let name = platform.name;
    if !platform::install(platform) {
        tracing::warn!("[shell] a platform was already registered; `{name}` is ignored");
    }
    let launch = ui.launch();
    // One Kubuno Desktop per user session (`crate::instance`): a second launch hands its command line to the running
    // one and exits here, before any splash screen or account is touched.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let instance::Claim::Exit(code) = instance::claim(&args, launch.sample) {
        return code;
    }
    ui.prepare(&launch);
    backend::set_sample(launch.sample);
    if launch.sample {
        tracing::info!("[shell] offline sample (--sample, or a Debug build under a debugger; --live opts out)");
    } else {
        ui.step(StartStep::Accounts);
        if let Some(dir) = kubuno_desktop_account::paths::sandbox_dir() {
            tracing::info!("[shell] sandboxed profile under {} (no system registration)", dir.display());
        }
        // Legacy single-instance layouts move under instances/<id>/ before anything reads them.
        let _ = kubuno_desktop_sync::migrate_legacy();
        // The accounts: plaintext creds.json moved into the OS credential store, the token owner, the file sync's
        // tokens, and the token broker the apps borrow from.
        match session::start() {
            Ok(s) if s.client_mode => tracing::warn!("[shell] another Kubuno Desktop owns the accounts: borrowing its tokens"),
            Ok(_) => {}
            Err(e) => tracing::error!("[shell] the accounts could not be started: {e}"),
        }
        // A start-at-logon entry written by an older version gets its current command.
        platform::current().integration.refresh_autostart();
    }
    ui.step(StartStep::Window);
    ui.run(&launch)
}

/// The portable user interface: the sync folders and their accounts as text. It is what the app shows on a
/// system without a native window yet, and what tests run.
#[derive(Debug, Default, Clone, Copy)]
pub struct TextUi;

impl TextUi {
    /// The summary as lines of text: a header, then one line per sync folder (id, server, account, folder).
    pub fn render() -> Vec<String> {
        let instances = backend::list_instances();
        let mut lines = vec![format!(
            "Kubuno Desktop{} - {} sync folder(s)",
            if backend::is_sample() { " (sample)" } else { "" },
            instances.len()
        )];
        for instance in &instances {
            let account = backend::current_user(&instance.id).map(|(user, _)| user.email).unwrap_or_default();
            lines.push(format!("{:<20} {:<36} {:<28} {}", instance.id, instance.server_url, account, instance.sync_root.display()));
        }
        lines
    }
}

impl UiHost for TextUi {
    fn run(&self, _launch: &Launch) -> i32 {
        for line in TextUi::render() {
            println!("{line}");
        }
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_the_background_start_and_the_sample() {
        assert_eq!(Launch::parse_for(args(&["--background"]), false), Launch { background: true, sample: false });
        assert!(Launch::parse_for(args(&["--sample"]), false).sample);
        assert!(Launch::parse_for(args(&[]), true).sample, "a debugging session runs the sample");
        assert!(!Launch::parse_for(args(&["--live"]), true).sample, "--live opts out");
    }

    #[test]
    fn the_text_interface_lists_the_sample_folders() {
        let _guard = backend::SAMPLE_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        backend::set_sample(true);
        let lines = TextUi::render();
        backend::set_sample(false);
        assert!(lines[0].contains("(sample)"));
        assert_eq!(lines.len(), 3, "{lines:?}");
    }
}
