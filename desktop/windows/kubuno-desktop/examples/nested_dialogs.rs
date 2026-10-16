//! Modal dialogs opened from inside a frame: a ribbon command, a button in a dock panel, a button
//! of the page. Each opens a tall dialog (a first control at its top, an action bar at its bottom)
//! that must paint whole wherever it was opened from - a nested frame never inherits the clip of
//! the container the command came from. A named `<DockPanel>` keeps its literal title, and its
//! title can be changed from code.
//!
//! `cargo run -p kubuno-desktop --example nested_dialogs [-- --topmost]`
#![windows_subsystem = "windows"]

use kubuno_desktop::prelude::*;

#[kubuno_desktop::view(xml = r#"
<Panel DesignWidth="900" DesignHeight="600" Title="Nested dialogs">
  <Command x:Name="cmd_open" Label="Ouvrir la boîte" SmallIcon="Printer" OnExecute="open_execute"/>
  <Ribbon x:Name="ribbon" Dock="Top">
    <RibbonTab x:Name="tab_home" Header="Accueil">
      <RibbonGroup x:Name="grp_dialogs" Header="Boîtes de dialogue">
        <RibbonButton Command="cmd_open" Size="Large"/>
      </RibbonGroup>
    </RibbonTab>
  </Ribbon>
  <DockArea Dock="Fill">
    <DockPanel x:Name="tools" Title="Outils" Side="Left" Closable="false">
      <Panel>
        <Button x:Name="from_dock" Text="Depuis le panneau" OnClick="dock_click" X="12" Y="12" Width="180" Height="32"/>
        <Button x:Name="rename" Text="Renommer le panneau" OnClick="rename_click" X="12" Y="56" Width="180" Height="32"/>
      </Panel>
    </DockPanel>
    <Panel>
      <Button x:Name="from_page" Text="Depuis la page" OnClick="page_click" X="24" Y="24" Width="160" Height="32"/>
      <Label x:Name="last" Text="Aucune boîte ouverte." X="24" Y="72" Width="400" Height="24"/>
      <Button x:Name="full" Text="Plein écran" OnClick="full_click" X="24" Y="120" Width="160" Height="32"/>
      <Button x:Name="cover" Text="Couvrir l'écran (SetWindowPos)" OnClick="cover_click" X="200" Y="120" Width="260" Height="32"/>
      <Label x:Name="frames" Text="" X="24" Y="168" Width="400" Height="24"/>
    </Panel>
  </DockArea>
</Panel>"#)]
pub struct MainView;

#[kubuno_desktop::view(xml = r#"
<Panel DesignWidth="560" DesignHeight="520" WindowKind="Dialog" Title="Grande boîte" AcceptButton="ok" CancelButton="cancel">
  <Label x:Name="first" Text="Premier contrôle (en haut)" X="16" Y="8" Width="520" Height="24"/>
  <TextField x:Name="f1" Placeholder="Champ 1" X="16" Y="48" Width="520" Height="36"/>
  <TextField x:Name="f2" Placeholder="Champ 2" X="16" Y="140" Width="520" Height="36"/>
  <TextField x:Name="f3" Placeholder="Champ 3" X="16" Y="240" Width="520" Height="36"/>
  <TextField x:Name="f4" Placeholder="Champ 4" X="16" Y="340" Width="520" Height="36"/>
  <Label x:Name="bottom" Text="Dernier contrôle (en bas)" X="16" Y="430" Width="520" Height="24"/>
  <Button x:Name="ok" ActionBar.Region="Right" Text="OK" Variant="Primary" Width="96" Height="36" OnClick="ok_click"/>
  <Button x:Name="cancel" ActionBar.Region="Right" Text="Annuler" Variant="Secondary" Width="96" Height="36" OnClick="cancel_click"/>
</Panel>"#)]
pub struct BigDialog;

impl BigDialog {
    fn ask(owner: &dyn AsForm, from: &str) -> DialogResult {
        let mut d = Self::default();
        d.initialize_component();
        d.set_text(format!("Grande boîte - {from}"));
        d.show_dialog(owner)
    }

    fn ok_click(&mut self) {
        self.set_dialog_result(DialogResult::Ok);
        self.close();
    }

    fn cancel_click(&mut self) {
        self.set_dialog_result(DialogResult::Cancel);
        self.close();
    }
}

impl MainView {
    fn report(&mut self, from: &str) {
        let result = BigDialog::ask(self, from);
        self.last.set_text(format!("{from} : {result:?}"));
    }

    fn open_execute(&mut self) {
        self.report("ruban");
    }

    fn dock_click(&mut self) {
        self.report("panneau");
    }

    fn page_click(&mut self) {
        self.report("page");
    }

    fn rename_click(&mut self) {
        self.tools.set_property("Title", "Outils (renommé)");
    }

    /// The framework's full screen: the window covers its monitor, then comes back where it was.
    fn full_click(&mut self) {
        let on = !self.is_full_screen();
        self.set_full_screen(on);
        self.frames.set_text(format!("Plein écran : {on}"));
    }

    /// An application resizing its window itself, synchronously, from a handler (inside the frame):
    /// the window must keep painting at its new size.
    fn cover_click(&mut self) {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOP, SWP_FRAMECHANGED};
        let Some(hwnd) = self.form().handle() else { return };
        let hwnd = HWND(hwnd as *mut core::ffi::c_void);
        // SAFETY: plain window calls on this example's own window, from its UI thread.
        unsafe {
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info).as_bool() {
                let r = info.rcMonitor;
                let _ = SetWindowPos(hwnd, Some(HWND_TOP), r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_FRAMECHANGED);
            }
        }
        self.frames.set_text("Fenêtre redimensionnée depuis le gestionnaire");
    }
}

fn main() -> kubuno_desktop::Result {
    let mut view = MainView::default();
    view.initialize_component();
    if std::env::args().any(|a| a == "--topmost") {
        view.form().root().set_property("TopMost", true);
    }
    Application::run(view)
}
