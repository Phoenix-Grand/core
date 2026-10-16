//! The shared questions, each answer printed: `cargo run -p kubuno-desktop --example dialogs`.

// A windowed app: no console window behind the dialogs.
#![windows_subsystem = "windows"]

use kubuno_desktop::prelude::*;

fn main() {
    let restore = ConfirmBox::new("Document", "A copy of this document was kept on this PC after the app closed unexpectedly. Restore it?")
        .confirm("Restore the copy")
        .decline("Discard it")
        .other("Decide later")
        .show();
    println!("confirm: {restore:?}");

    let delete = ConfirmBox::new("Delete", "Delete the page « Plan B » and everything on it?")
        .confirm("Delete")
        .decline("Keep")
        .icon(MessageBoxIcon::Danger)
        .width(420.0)
        .show();
    println!("danger: {delete:?}");

    let name = InputBox::new("Rename").message("New name of the sheet").value("Sheet1").cancel("Cancel").ask();
    println!("input: {name:?}");
}
