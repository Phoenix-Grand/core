//! The Windows integration: the Cloud Files API (`cloudfiles`, status overlays), the Explorer
//! navigation pane (`explorer`), the notification-area icon (`tray`),
//! the network's connectivity changes (`network`) and what the shell opens outside itself (`actions`:
//! the browser, Explorer); the Windows
//! implementations of the portable app's extension points (`system`) and its user interface (`ui_host`).

pub mod actions;
pub mod cloudfiles;
pub mod explorer;
pub mod network;
pub mod system;
pub mod tray;
pub mod ui_host;
