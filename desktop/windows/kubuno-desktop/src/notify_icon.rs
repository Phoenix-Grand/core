//! [`NotifyIcon`]: an icon in the notification area of the taskbar, which shows balloon
//! notifications (Windows Forms `NotifyIcon` and its `ShowBalloonTip`) - `Shell_NotifyIcon`, the
//! mechanism the Kubuno desktop shell's own tray icon uses.
//!
//! ```no_run
//! use kubuno_desktop::prelude::*;
//!
//! let icon = NotifyIcon::new().text("Kubuno Calendar");
//! icon.show_balloon_tip("Team meeting", "In 10 minutes, room 2", 10_000);
//! ```
//!
//! Each icon owns a hidden window (the notification area talks to a window, and a message-only
//! window cannot show balloons); dropping the icon removes it from the notification area. An icon
//! lives on the thread that created it (it is not `Send`): a background worker that notifies keeps
//! its own, in a `thread_local!` for instance. On Windows 10 and later, the balloons appear as the
//! system's notifications (toasts).

use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicU32, Ordering};

use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_TIP, NIIF_ERROR, NIIF_INFO, NIIF_NONE, NIIF_WARNING, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW, NOTIFYICONDATAW_0,
    NOTIFY_ICON_INFOTIP_FLAGS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow, LoadIconW, LoadImageW, RegisterClassW, HICON, IDI_APPLICATION, IMAGE_ICON, LR_DEFAULTSIZE, LR_LOADFROMFILE,
    WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
};

/// The icon a balloon shows next to its title (Windows Forms `ToolTipIcon`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToolTipIcon {
    /// No icon.
    None,
    /// The information icon.
    #[default]
    Info,
    /// The warning icon.
    Warning,
    /// The error icon.
    Error,
}

impl ToolTipIcon {
    fn flags(self) -> NOTIFY_ICON_INFOTIP_FLAGS {
        match self {
            Self::None => NIIF_NONE,
            Self::Info => NIIF_INFO,
            Self::Warning => NIIF_WARNING,
            Self::Error => NIIF_ERROR,
        }
    }
}

/// The longest tooltip the notification area shows (`szTip`, its NUL included).
pub const MAX_TEXT: usize = 127;

/// Copies `s` into the fixed UTF-16 field `dst`, truncated and NUL-terminated.
fn put(dst: &mut [u16], s: &str) {
    let Some(room) = dst.len().checked_sub(1) else { return };
    let w: Vec<u16> = s.encode_utf16().take(room).collect();
    dst[..w.len()].copy_from_slice(&w);
    for c in &mut dst[w.len()..] {
        *c = 0;
    }
}

extern "system" fn wndproc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    // SAFETY: forwarding the message the system handed this window procedure, unchanged.
    unsafe { DefWindowProcW(h, msg, w, l) }
}

const CLASS_NAME: PCWSTR = w!("KubunoNotifyIcon");

/// The id of the next icon (unique in the process, as the notification area keys an icon by its
/// window and id).
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// An icon in the notification area (see the module doc).
pub struct NotifyIcon {
    hwnd: HWND,
    id: u32,
    icon: Cell<HICON>,
    /// The icon was loaded from a file by this object (destroyed with it).
    owns_icon: Cell<bool>,
    text: RefCell<String>,
    visible: Cell<bool>,
}

impl NotifyIcon {
    /// A new icon, not shown yet ([`Self::set_visible`], or the first balloon, shows it): the
    /// application's icon (the `app_icon` resource of the executable), else the system's.
    pub fn new() -> Self {
        // SAFETY: plain Win32 calls with initialised arguments; the class name is a static wide
        // string and the window created here is destroyed in `Drop`.
        let (hwnd, icon) = unsafe {
            let instance = GetModuleHandleW(None).unwrap_or_default();
            let class = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance.into(), lpszClassName: CLASS_NAME, ..Default::default() };
            // Fails harmlessly when the class is already registered (a second icon).
            RegisterClassW(&class);
            // A hidden top-level window owns the icon (a message-only window cannot show balloons).
            let hwnd = CreateWindowExW(WINDOW_EX_STYLE(0), CLASS_NAME, PCWSTR::null(), WINDOW_STYLE(0), 0, 0, 0, 0, None, None, Some(instance.into()), None).unwrap_or_default();
            let icon = LoadIconW(Some(instance.into()), w!("app_icon")).or_else(|_| LoadIconW(None, IDI_APPLICATION)).unwrap_or_default();
            (hwnd, icon)
        };
        if hwnd.is_invalid() {
            tracing::warn!("NotifyIcon: the window of the notification icon could not be created");
        }
        Self { hwnd, id: NEXT_ID.fetch_add(1, Ordering::Relaxed), icon: Cell::new(icon), owns_icon: Cell::new(false), text: RefCell::new(String::new()), visible: Cell::new(false) }
    }

    /// Builder: its tooltip (`Text`, at most [`MAX_TEXT`] characters).
    pub fn text(self, text: &str) -> Self {
        self.set_text(text);
        self
    }

    /// Builder: shown or not (`Visible`).
    pub fn visible(self, visible: bool) -> Self {
        self.set_visible(visible);
        self
    }

    /// Builder: its icon from an `.ico` file ([`Self::set_icon_file`]).
    pub fn icon_file(self, path: &str) -> Self {
        self.set_icon_file(path);
        self
    }

    /// Its tooltip.
    pub fn get_text(&self) -> String {
        self.text.borrow().clone()
    }

    /// Sets its tooltip (shown when the pointer rests on the icon).
    pub fn set_text(&self, text: &str) {
        *self.text.borrow_mut() = text.chars().take(MAX_TEXT).collect();
        if self.visible.get() {
            self.notify(NIM_MODIFY, None);
        }
    }

    /// Whether it is in the notification area.
    pub fn is_visible(&self) -> bool {
        self.visible.get()
    }

    /// Adds it to the notification area, or removes it.
    pub fn set_visible(&self, visible: bool) {
        if visible == self.visible.get() {
            return;
        }
        if visible {
            self.visible.set(self.notify(NIM_ADD, None));
        } else {
            self.notify(NIM_DELETE, None);
            self.visible.set(false);
        }
    }

    /// Takes its icon from an `.ico` file (at the system's small icon size); `false` when the
    /// file cannot be read (the icon is kept).
    pub fn set_icon_file(&self, path: &str) -> bool {
        let path = HSTRING::from(path);
        // SAFETY: `path` outlives the call; the handle returned is owned here and destroyed when
        // replaced or in `Drop`.
        let loaded = unsafe { LoadImageW(None, &path, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE) };
        let Ok(handle) = loaded else { return false };
        self.release_icon();
        self.icon.set(HICON(handle.0));
        self.owns_icon.set(true);
        if self.visible.get() {
            self.notify(NIM_MODIFY, None);
        }
        true
    }

    /// Shows a balloon with the information icon (Windows Forms `ShowBalloonTip(timeout, title,
    /// text, ToolTipIcon.Info)`): `title` in bold over `text`, for about `timeout_ms` milliseconds
    /// (the system decides in the end). Shows the icon first when it is not.
    pub fn show_balloon_tip(&self, title: &str, text: &str, timeout_ms: u32) {
        self.show_balloon_tip_with_icon(title, text, timeout_ms, ToolTipIcon::Info);
    }

    /// [`Self::show_balloon_tip`] with the balloon's icon.
    pub fn show_balloon_tip_with_icon(&self, title: &str, text: &str, timeout_ms: u32, icon: ToolTipIcon) {
        if !self.visible.get() {
            self.set_visible(true);
        }
        self.notify(NIM_MODIFY, Some((title, text, timeout_ms, icon)));
    }

    /// Sends the icon's state to the notification area (with a balloon); whether it was accepted.
    fn notify(&self, message: windows::Win32::UI::Shell::NOTIFY_ICON_MESSAGE, balloon: Option<(&str, &str, u32, ToolTipIcon)>) -> bool {
        if self.hwnd.is_invalid() {
            return false;
        }
        let mut data = NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: self.hwnd,
            uID: self.id,
            uFlags: NIF_ICON | NIF_TIP,
            hIcon: self.icon.get(),
            ..Default::default()
        };
        put(&mut data.szTip, &self.text.borrow());
        if let Some((title, text, timeout, icon)) = balloon {
            data.uFlags |= NIF_INFO;
            data.Anonymous = NOTIFYICONDATAW_0 { uTimeout: timeout };
            data.dwInfoFlags = icon.flags();
            put(&mut data.szInfoTitle, title);
            put(&mut data.szInfo, text);
        }
        // SAFETY: `data` is a fully initialised NOTIFYICONDATAW living across the call.
        unsafe { Shell_NotifyIconW(message, &data).as_bool() }
    }

    fn release_icon(&self) {
        if self.owns_icon.replace(false) {
            // SAFETY: an icon this object loaded itself (`set_icon_file`), no longer used.
            unsafe {
                let _ = DestroyIcon(self.icon.get());
            }
        }
    }
}

impl Default for NotifyIcon {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for NotifyIcon {
    fn drop(&mut self) {
        if self.visible.get() {
            self.notify(NIM_DELETE, None);
        }
        self.release_icon();
        if !self.hwnd.is_invalid() {
            // SAFETY: the hidden window this object created, destroyed once.
            unsafe {
                let _ = DestroyWindow(self.hwnd);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texts_are_truncated_and_terminated() {
        let mut field = [0xFFFFu16; 8];
        put(&mut field, "Kubuno Calendar");
        assert_eq!(&field[..7], "Kubuno ".encode_utf16().collect::<Vec<_>>().as_slice());
        assert_eq!(field[7], 0);
        put(&mut field, "ab");
        assert_eq!(&field[..3], &[u16::from(b'a'), u16::from(b'b'), 0]);
        assert!(field[3..].iter().all(|c| *c == 0), "the rest is cleared");
        put(&mut [], "nothing to write into");
    }

    #[test]
    fn balloon_icons_map_to_the_shell_flags() {
        assert_eq!(ToolTipIcon::default(), ToolTipIcon::Info);
        assert_eq!(ToolTipIcon::Warning.flags(), NIIF_WARNING);
        assert_eq!(ToolTipIcon::None.flags(), NIIF_NONE);
    }

    #[test]
    fn an_icon_keeps_its_text_and_ids_are_unique() {
        let a = NotifyIcon::new().text(&"x".repeat(200));
        let b = NotifyIcon::new();
        assert_eq!(a.get_text().chars().count(), MAX_TEXT);
        assert_ne!(a.id, b.id);
        assert!(!a.is_visible(), "not in the notification area until shown");
    }
}
