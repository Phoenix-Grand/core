//! The system file dialogs, one after the other, each answer printed:
//! `cargo run -p kubuno-desktop --example file_dialogs`.

// A windowed app: no console window behind the dialogs.
#![windows_subsystem = "windows"]

use kubuno_desktop::prelude::*;
use kubuno_desktop::safe_file_name;

fn main() {
    let mut open = OpenFileDialog::new();
    open.title = "Kubuno - open a file".into();
    open.filter = "Text files (*.txt;*.md)|*.txt;*.md|All files (*.*)|*.*".into();
    println!("open: {:?} {:?}", open.show_dialog(), open.file_name);

    let mut save = SaveFileDialog::new();
    save.title = "Kubuno - save a file".into();
    save.filter = "PDF (*.pdf)|*.pdf".into();
    save.default_ext = "pdf".into();
    save.file_name = Some(safe_file_name("Q3: plan / budget?", "document").into());
    println!("save: {:?} {:?}", save.show_dialog(), save.file_name);

    let mut folder = FolderBrowserDialog::new();
    folder.description = "Kubuno - choose a folder".into();
    println!("folder: {:?} {:?}", folder.show_dialog(), folder.selected_path);
}
