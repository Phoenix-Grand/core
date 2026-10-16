//! Kubuno Desktop for Windows (`kubuno-desktop.exe`) - `Program.cs`: the portable app of desktop/common
//! (`kubuno_desktop_shell_common::app::run`) with the Windows platform registered and the Win32 window as its
//! user interface. Everything else is in the library (`lib.rs`) and in the common app.
//!
//! `kubuno-desktop.exe [--background] [--sample|--live] [--light|--dark] [--culture fr|en] [--no-splash]
//! [--page launcher|settings|accounts|activity|labels|login|admin[:<section>]] [--dev-instance <name>]`
//!
//! One Kubuno Desktop per user session: a second launch hands its command line to the running one (which comes to
//! the front, on the page asked for) and exits. `--dev-instance <name>` (debug builds only) runs a developer instance
//! next to it (`kubuno_desktop_shell_common::instance`).
//!
//! `--background` is the start at logon (the `Run` key): hidden in the notification area, no
//! splash screen. `--sample` shows the offline sample: fixed data, no server, nothing read from or
//! written to the configuration, nothing registered with the system. A Debug build started under a
//! debugger (F5) runs the sample by default; `--live` opts out.

// A GUI application: no console window, in Debug too (like a Windows Forms `WinExe`). Its logs,
// `println!`s and panics go to the debugger's Output window or to %LOCALAPPDATA%\Kubuno\logs.
#![windows_subsystem = "windows"]

fn main() {
    // The log file first: a second launch (handed to the running Kubuno Desktop, one per user session) exits before
    // any window, and what it did must still be in the log file (`%LOCALAPPDATA%\Kubuno\logs`).
    kubuno_desktop::ui::diagnostics::install(&kubuno_desktop::ui::diagnostics::exe_name(), true);
    kubuno_desktop::ui::diagnostics::set_display_name("Kubuno Desktop");
    let ui = kubuno_desktop_shell::platform::ui_host::WindowsUi::from_args();
    let code = kubuno_desktop_shell_common::app::run(kubuno_desktop_shell::platform::system::windows_platform(), &ui);
    std::process::exit(code);
}
