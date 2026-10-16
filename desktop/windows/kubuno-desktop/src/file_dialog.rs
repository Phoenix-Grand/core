//! The system's file dialogs, under their Windows Forms names: [`OpenFileDialog`], [`SaveFileDialog`] and
//! [`FolderBrowserDialog`] (the shell's `IFileOpenDialog` / `IFileSaveDialog`, the modern Explorer dialogs).
//!
//! Like Windows Forms, a dialog is configured through its fields, shown with `show_dialog()` (owned by the active
//! window, else the app's main window) or `show_dialog_owned(owner)`, and answers [`DialogResult::Ok`] with the chosen
//! path in `file_name` (`file_names` for a multi-selection, `selected_path` for a folder) or [`DialogResult::Cancel`].
//! The `filter` uses the Windows Forms syntax: pairs of `label|patterns`, patterns separated by `;`:
//! `"Kubuno document (*.kbdoc)|*.kbdoc|All files (*.*)|*.*"`.
//!
//! ```ignore
//! let mut dialog = SaveFileDialog::new();
//! dialog.filter = "PDF (*.pdf)|*.pdf".into();
//! dialog.default_ext = "pdf".into();
//! dialog.file_name = Some(safe_file_name(&title, "document").into());
//! if dialog.show_dialog_owned(&self.form) == DialogResult::Ok { export(dialog.file_name.unwrap()) }
//! ```

use std::path::{Path, PathBuf};

use kubuno_desktop_controls::host;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
    FileOpenDialog, FileSaveDialog, IFileDialog, IFileOpenDialog, IFileSaveDialog, IShellItem, SHCreateItemFromParsingName,
    FILEOPENDIALOGOPTIONS, FOS_ALLOWMULTISELECT, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST,
    FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetActiveWindow;

use crate::forms::{AsForm, DialogResult};

/// Lets the user choose one file to open (several with `multiselect`).
#[derive(Clone, Debug, Default)]
pub struct OpenFileDialog {
    /// The dialog's title; the system's default when empty.
    pub title: String,
    /// The file types offered, Windows Forms syntax (`"Label|*.a;*.b|All files|*.*"`); every file when empty.
    pub filter: String,
    /// The folder the dialog opens in.
    pub initial_directory: Option<PathBuf>,
    /// The chosen file (also the name proposed when the dialog opens).
    pub file_name: Option<PathBuf>,
    /// Every chosen file (`multiselect`).
    pub file_names: Vec<PathBuf>,
    /// Allow choosing several files.
    pub multiselect: bool,
}

impl OpenFileDialog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Show the dialog, owned by the active window (else the main window).
    pub fn show_dialog(&mut self) -> DialogResult {
        self.run(default_owner())
    }

    /// Show the dialog owned by `owner`.
    pub fn show_dialog_owned(&mut self, owner: &dyn AsForm) -> DialogResult {
        self.run(owner_of(owner))
    }

    fn run(&mut self, owner: Option<HWND>) -> DialogResult {
        let picked = unsafe {
            open_dialog().and_then(|dialog| {
                let mut opts = FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST | FOS_FORCEFILESYSTEM;
                if self.multiselect {
                    opts |= FOS_ALLOWMULTISELECT;
                }
                prepare(&dialog, &self.title, &self.filter, self.initial_directory.as_ref(), self.file_name.as_ref(), opts);
                dialog.Show(owner).ok()?;
                let results = dialog.GetResults().ok()?;
                let count = results.GetCount().ok()?;
                Some((0..count).filter_map(|i| results.GetItemAt(i).ok()).filter_map(|item| path_of(&item)).collect::<Vec<_>>())
            })
        };
        match picked.filter(|paths| !paths.is_empty()) {
            Some(paths) => {
                self.file_name = paths.first().cloned();
                self.file_names = paths;
                DialogResult::Ok
            }
            None => DialogResult::Cancel,
        }
    }
}

/// Lets the user choose where to save a file.
#[derive(Clone, Debug)]
pub struct SaveFileDialog {
    /// The dialog's title; the system's default when empty.
    pub title: String,
    /// The file types offered, Windows Forms syntax (`"Label|*.a|All files|*.*"`).
    pub filter: String,
    /// The extension added when the user types a name without one (`"pdf"`, no dot).
    pub default_ext: String,
    /// The folder the dialog opens in.
    pub initial_directory: Option<PathBuf>,
    /// The chosen path (also the name proposed when the dialog opens: see [`safe_file_name`]).
    pub file_name: Option<PathBuf>,
    /// Ask before replacing an existing file (on by default, as in Windows Forms).
    pub overwrite_prompt: bool,
}

impl Default for SaveFileDialog {
    fn default() -> Self {
        Self {
            title: String::new(),
            filter: String::new(),
            default_ext: String::new(),
            initial_directory: None,
            file_name: None,
            overwrite_prompt: true,
        }
    }
}

impl SaveFileDialog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Show the dialog, owned by the active window (else the main window).
    pub fn show_dialog(&mut self) -> DialogResult {
        self.run(default_owner())
    }

    /// Show the dialog owned by `owner`.
    pub fn show_dialog_owned(&mut self, owner: &dyn AsForm) -> DialogResult {
        self.run(owner_of(owner))
    }

    fn run(&mut self, owner: Option<HWND>) -> DialogResult {
        let picked = unsafe {
            let dialog: Option<IFileSaveDialog> = init_com().and_then(|()| CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER).ok());
            dialog.and_then(|dialog| {
                let mut opts = FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
                if self.overwrite_prompt {
                    opts |= FOS_OVERWRITEPROMPT;
                }
                prepare(&dialog, &self.title, &self.filter, self.initial_directory.as_ref(), self.file_name.as_ref(), opts);
                if !self.default_ext.is_empty() {
                    let _ = dialog.SetDefaultExtension(&HSTRING::from(self.default_ext.trim_start_matches('.')));
                }
                dialog.Show(owner).ok()?;
                path_of(&dialog.GetResult().ok()?)
            })
        };
        match picked {
            Some(path) => {
                self.file_name = Some(path);
                DialogResult::Ok
            }
            None => DialogResult::Cancel,
        }
    }
}

/// Lets the user choose a folder.
#[derive(Clone, Debug, Default)]
pub struct FolderBrowserDialog {
    /// The dialog's title (Windows Forms' `Description`); the system's default when empty.
    pub description: String,
    /// The chosen folder (also the folder the dialog opens in).
    pub selected_path: Option<PathBuf>,
}

impl FolderBrowserDialog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Show the dialog, owned by the active window (else the main window).
    pub fn show_dialog(&mut self) -> DialogResult {
        self.run(default_owner())
    }

    /// Show the dialog owned by `owner`.
    pub fn show_dialog_owned(&mut self, owner: &dyn AsForm) -> DialogResult {
        self.run(owner_of(owner))
    }

    fn run(&mut self, owner: Option<HWND>) -> DialogResult {
        let picked = unsafe {
            open_dialog().and_then(|dialog| {
                prepare(&dialog, &self.description, "", self.selected_path.as_ref(), None, FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
                dialog.Show(owner).ok()?;
                path_of(&dialog.GetResult().ok()?)
            })
        };
        match picked {
            Some(path) => {
                self.selected_path = Some(path);
                DialogResult::Ok
            }
            None => DialogResult::Cancel,
        }
    }
}

/// A file name made safe for every file system from free text (a document title): the characters Windows forbids
/// become `_`, surrounding spaces and dots are trimmed, and `fallback` stands in for an empty result. No extension is
/// added (the dialog's `default_ext` does that).
pub fn safe_file_name(text: &str, fallback: &str) -> String {
    let cleaned: String = text.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() { fallback.to_string() } else { trimmed.to_string() }
}

/// Parse a Windows Forms filter (`"label|patterns|label|patterns"`) into its `(label, patterns)` pairs. A trailing
/// label without patterns is dropped.
fn parse_filter(filter: &str) -> Vec<(String, String)> {
    let parts: Vec<&str> = filter.split('|').collect();
    parts.chunks(2).filter(|p| p.len() == 2 && !p[1].trim().is_empty()).map(|p| (p[0].trim().to_string(), p[1].trim().to_string())).collect()
}

unsafe fn init_com() -> Option<()> {
    // The UI thread is already in an apartment (S_FALSE / RPC_E_CHANGED_MODE are fine): the dialog only needs one.
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    Some(())
}

unsafe fn open_dialog() -> Option<IFileOpenDialog> {
    init_com()?;
    CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()
}

/// Title, file types, starting folder, proposed name and options, common to every dialog.
unsafe fn prepare(
    dialog: &IFileDialog,
    title: &str,
    filter: &str,
    folder: Option<&PathBuf>,
    file_name: Option<&PathBuf>,
    extra: FILEOPENDIALOGOPTIONS,
) {
    if !title.is_empty() {
        let _ = dialog.SetTitle(&HSTRING::from(title));
    }
    let owned: Vec<(HSTRING, HSTRING)> = parse_filter(filter).into_iter().map(|(l, s)| (HSTRING::from(l), HSTRING::from(s))).collect();
    if !owned.is_empty() {
        let specs: Vec<COMDLG_FILTERSPEC> =
            owned.iter().map(|(l, s)| COMDLG_FILTERSPEC { pszName: PCWSTR(l.as_ptr()), pszSpec: PCWSTR(s.as_ptr()) }).collect();
        let _ = dialog.SetFileTypes(&specs);
    }
    if let Some(dir) = folder.and_then(|d| shell_item(d.as_path())) {
        let _ = dialog.SetFolder(&dir);
    }
    if let Some(name) = file_name {
        // A full path opens in its folder with its name proposed; a bare name is only proposed.
        if let Some(parent) = name.parent().filter(|p| !p.as_os_str().is_empty()).and_then(shell_item) {
            let _ = dialog.SetFolder(&parent);
        }
        if let Some(leaf) = name.file_name() {
            let _ = dialog.SetFileName(&HSTRING::from(leaf.to_string_lossy().as_ref()));
        }
    }
    if let Ok(opts) = dialog.GetOptions() {
        let _ = dialog.SetOptions(opts | extra);
    }
}

fn shell_item(path: &Path) -> Option<IShellItem> {
    let wide = HSTRING::from(path.as_os_str());
    unsafe { SHCreateItemFromParsingName(&wide, None).ok() }
}

fn path_of(item: &IShellItem) -> Option<PathBuf> {
    unsafe {
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = PCWSTR(name.0).to_string().ok();
        CoTaskMemFree(Some(name.0 as *const _));
        path.map(PathBuf::from)
    }
}

/// The active window of the app, else its main window.
fn default_owner() -> Option<HWND> {
    let active = unsafe { GetActiveWindow() };
    if !active.is_invalid() {
        return Some(active);
    }
    host::main_window().map(|h| HWND(h.0 as *mut _))
}

fn owner_of(owner: &dyn AsForm) -> Option<HWND> {
    owner.as_form().handle().map(|h| HWND(h as *mut _)).or_else(default_owner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_parse_like_windows_forms() {
        assert_eq!(
            parse_filter("Kubuno (*.kbdia)|*.kbdia;*.json|All files (*.*)|*.*"),
            vec![("Kubuno (*.kbdia)".into(), "*.kbdia;*.json".into()), ("All files (*.*)".into(), "*.*".into())]
        );
        assert!(parse_filter("").is_empty());
        assert_eq!(parse_filter("Text|*.txt|Dangling").len(), 1);
    }

    #[test]
    fn file_names_are_made_safe() {
        assert_eq!(safe_file_name("Q3: plan / budget?", "doc"), "Q3_ plan _ budget_");
        assert_eq!(safe_file_name("   ", "document"), "document");
        assert_eq!(safe_file_name("notes.", "x"), "notes");
    }
}
