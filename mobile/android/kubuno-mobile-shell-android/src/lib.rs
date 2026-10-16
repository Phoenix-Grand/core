//! The Kubuno Android shell: a pure-Rust `NativeActivity` (no Java/Kotlin, no Tauri/webview), shared by every
//! module's Android app.
//!
//! It owns the Android window and the GPU: it builds a `wgpu` surface straight from the NDK `NativeWindow`, loads
//! a device font, turns touches into gestures and drives the portable renderer ([`kubuno_mobile_render`]). It holds
//! no app: a module's Android crate (e.g. `maps/mobile/android/kubuno-maps-mobile-android`) defines the
//! `android_main` of its APK and calls [`run`] with its [`App`]. The `standalone` feature (on by default) keeps a
//! demo `android_main` showing the renderer's sample screen, to try the engine and this shell without any module; a
//! module's crate depends on this shell with `default-features = false`.

mod secret_store;

pub use secret_store::AndroidSecretStore;

use std::sync::Arc;

use android_activity::input::{Keycode, MetaState};
use android_activity::{AndroidApp, MainEvent, PollEvent};
use kubuno_mobile_render::{
    gesture_pan, gesture_zoom, input_focused, input_key, App, FontHandle, InputKey, Painter, Tap,
};
use raw_window_handle::{
    AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle,
};
use std::time::Duration;

/// Touch-gesture state kept across poll iterations: one finger drags (pan), two fingers pinch (zoom), a quick tap
/// (no drag) advances to the next screen.
#[derive(Default)]
struct Touch {
    down: bool,
    moved: bool,
    pinch: bool,
    reseed: bool,
    last: (f32, f32),
    down_pos: (f32, f32),
    pinch_dist: f32,
}

fn dist(a: (f32, f32), b: (f32, f32)) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// Everything that only exists once the surface (NativeWindow) is available.
struct Gpu {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    painter: Painter,
    font: Option<FontHandle>,
}

/// The standalone demo APK: the renderer's sample screen. A module's own Android crate disables this feature and
/// provides its own `android_main`.
#[cfg(feature = "standalone")]
#[no_mangle]
fn android_main(app: AndroidApp) {
    run(app, kubuno_mobile_render::SAMPLE_APP);
}

/// Run `kubuno_app` in this NativeActivity until the activity is destroyed. A module's `android_main` calls it.
pub fn run(app: AndroidApp, kubuno_app: App) {
    android_logger::init_once(
        android_logger::Config::default().with_max_level(log::LevelFilter::Info),
    );
    log::info!("KUBUNO: {} started (pure-Rust NativeActivity shell)", kubuno_app.label);
    // The OS secret store (Android Keystore) for the account layer, before the app restores its session in `setup`.
    match app.internal_data_path().map(|d| AndroidSecretStore::new(d.join("kubuno-secrets"))) {
        Some(Ok(store)) => kubuno_mobile_account::set_platform_store(Arc::new(store)),
        Some(Err(e)) => log::error!("KUBUNO: no secret store: {e}"),
        None => log::error!("KUBUNO: no internal data path: no secret store"),
    }
    // Register the app's host controls before the first frame.
    (kubuno_app.setup)();
    // Background work (network calls) posts its result to the UI thread; its waker nudges this loop so the result is
    // applied at once instead of waiting for the next poll.
    let waker = app.create_waker();
    kubuno_mobile_render::set_waker(move || waker.wake());

    let mut gpu: Option<Gpu> = None;
    let mut quit = false;
    // The app's screens: tap anywhere to advance to the next one.
    let views = kubuno_app.views;
    if views.is_empty() {
        log::error!("KUBUNO: {} has no screen", kubuno_app.label);
        return;
    }
    let mut view_idx: usize = 0;
    let mut touch = Touch::default();
    // Whether the soft keyboard was last asked to show (it follows the text input's focus).
    let mut keyboard_up = false;

    while !quit {
        // Apply any results background work posted back to the UI thread (updates the app's state / data context).
        kubuno_mobile_render::run_ui_tasks();
        // The app chooses the screen from its own state when it is wired (view_index); otherwise the shell cycles.
        let view_now = kubuno_app.view_index.map(|f| f().min(views.len() - 1)).unwrap_or(view_idx);
        let current = views[view_now];
        let (sw, sh) = gpu
            .as_ref()
            .map(|g| (g.config.width as f32, g.config.height as f32))
            .unwrap_or((1080.0, 2340.0));
        app.poll_events(Some(Duration::from_millis(250)), |event| match event {
            PollEvent::Main(MainEvent::InitWindow { .. }) => {
                log::info!("KUBUNO: InitWindow -> creating wgpu surface + renderer");
                match pollster::block_on(Gpu::new(&app)) {
                    Ok(g) => {
                        log::info!("KUBUNO: gpu ready ({}x{})", g.config.width, g.config.height);
                        gpu = Some(g);
                    }
                    Err(e) => log::error!("KUBUNO: gpu init failed: {e}"),
                }
            }
            PollEvent::Main(MainEvent::TerminateWindow { .. }) => {
                log::info!("KUBUNO: TerminateWindow -> dropping surface");
                gpu = None;
            }
            PollEvent::Main(MainEvent::RedrawNeeded { .. }) => {
                if let Some(g) = gpu.as_mut() {
                    g.render(current);
                }
            }
            PollEvent::Main(MainEvent::Destroy) => quit = true,
            _ => {}
        });

        // Gestures: one finger pans, two fingers pinch-zoom (both routed to the app's host controls, e.g. a map), a
        // quick tap advances to the next screen.
        if let Ok(mut iter) = app.input_events_iter() {
            let mut tap: Option<(f32, f32)> = None;
            // Key-down events collected this iteration; applied to the focused field after the loop (the character map
            // lookup needs `app`, which the input closure must not also borrow).
            let mut keys: Vec<(Keycode, MetaState, i32)> = Vec::new();
            const SLOP: f32 = 18.0;
            loop {
                let more = iter.next(|event| {
                    use android_activity::input::{InputEvent, KeyAction, MotionAction};
                    if let InputEvent::KeyEvent(k) = &event {
                        if k.action() == KeyAction::Down {
                            keys.push((k.key_code(), k.meta_state(), k.device_id()));
                        }
                    }
                    if let InputEvent::MotionEvent(m) = event {
                        let n = m.pointer_count();
                        let mut it = m.pointers();
                        let p0 = it.next();
                        let p1 = it.next();
                        let x0 = p0.as_ref().map(|p| p.x()).unwrap_or(0.0);
                        let y0 = p0.as_ref().map(|p| p.y()).unwrap_or(0.0);
                        let x1 = p1.as_ref().map(|p| p.x()).unwrap_or(0.0);
                        let y1 = p1.as_ref().map(|p| p.y()).unwrap_or(0.0);
                        match m.action() {
                            MotionAction::Down => {
                                touch.down = true;
                                touch.moved = false;
                                touch.pinch = false;
                                touch.last = (x0, y0);
                                touch.down_pos = (x0, y0);
                            }
                            MotionAction::PointerDown if n >= 2 => {
                                touch.pinch = true;
                                touch.moved = true;
                                touch.pinch_dist = dist((x0, y0), (x1, y1));
                            }
                            MotionAction::Move => {
                                if n >= 2 {
                                    touch.pinch = true;
                                    touch.moved = true;
                                    let d2 = dist((x0, y0), (x1, y1));
                                    if touch.pinch_dist > 1.0 {
                                        let factor = d2 / touch.pinch_dist;
                                        gesture_zoom(factor, (x0 + x1) / 2.0, (y0 + y1) / 2.0, sw, sh);
                                    }
                                    touch.pinch_dist = d2;
                                } else if touch.down && !touch.pinch {
                                    if touch.reseed {
                                        touch.last = (x0, y0);
                                        touch.reseed = false;
                                    }
                                    gesture_pan(x0 - touch.last.0, y0 - touch.last.1);
                                    touch.last = (x0, y0);
                                    if dist((x0, y0), touch.down_pos) > SLOP {
                                        touch.moved = true;
                                    }
                                }
                            }
                            MotionAction::PointerUp => {
                                // Back to one finger: stop pinching and re-seed the pan anchor on the next move.
                                touch.pinch = false;
                                touch.pinch_dist = 0.0;
                                touch.reseed = true;
                            }
                            MotionAction::Up | MotionAction::Cancel => {
                                if touch.down && !touch.moved && !touch.pinch {
                                    // A quick tap: its position is where the finger went down (it did not move).
                                    tap = Some(touch.down_pos);
                                }
                                touch.down = false;
                                touch.pinch = false;
                                touch.moved = false;
                            }
                            _ => {}
                        }
                    }
                    android_activity::InputStatus::Unhandled
                });
                if !more {
                    break;
                }
            }
            if let Some((tx, ty)) = tap {
                match kubuno_app.on_event {
                    // The app handles the tap: resolve it against the on-screen view and let the app update its state.
                    Some(on_event) => {
                        if let Some(g) = gpu.as_ref() {
                            match g.painter.resolve_tap(tx, ty) {
                                Tap::Event(ev) => {
                                    log::info!("KUBUNO: tap -> {:?} / {}", ev.name, ev.handler);
                                    on_event(&ev);
                                }
                                // Tapping a field always brings the keyboard back (the user may have dismissed it
                                // while the field kept the focus).
                                Tap::Focused => {
                                    log::info!("KUBUNO: tap -> focus text field");
                                    app.show_soft_input(true);
                                    keyboard_up = true;
                                }
                                Tap::Ignored => {}
                            }
                        }
                    }
                    // Not wired yet: the demo advances to the next screen.
                    None => {
                        view_idx = (view_idx + 1) % views.len();
                        log::info!("KUBUNO: tap -> view {}/{}", view_idx + 1, views.len());
                    }
                }
            }

            // Keys while a field is focused: the shell only translates them; the engine edits the field and returns the
            // events the view declared (OnTextChanged, OnSearch, OnKeyDown), which go to the app.
            if input_focused().is_some() {
                use android_activity::input::KeyMapChar;
                for (code, meta, dev) in keys {
                    let key = match code {
                        Keycode::Del => Some(InputKey::Backspace),
                        Keycode::Enter | Keycode::NumpadEnter => Some(InputKey::Enter),
                        Keycode::Escape => Some(InputKey::Escape),
                        // A character, through the device's key-character map (the virtual keyboard, id -1, for
                        // injected / unknown devices).
                        _ => app
                            .device_key_character_map(dev)
                            .or_else(|_| app.device_key_character_map(-1))
                            .ok()
                            .and_then(|m| m.get(code, meta).ok())
                            .and_then(|c| match c {
                                KeyMapChar::Unicode(ch) => Some(InputKey::Text(ch.to_string())),
                                _ => None,
                            }),
                    };
                    for ev in key.map(input_key).unwrap_or_default() {
                        log::info!("KUBUNO: field {:?} -> {} (key {:?})", ev.name, ev.handler, ev.key);
                        if let Some(on_event) = kubuno_app.on_event {
                            on_event(&ev);
                        }
                    }
                }
            }
        }

        // The soft keyboard follows the keyboard focus, whatever moved it: a tap, Enter going to the next field or
        // closing the form, the app, or a network result posted back to the UI thread.
        let want_keyboard = input_focused().is_some();
        if want_keyboard != keyboard_up {
            if want_keyboard {
                app.show_soft_input(true);
            } else {
                app.hide_soft_input(true);
            }
            keyboard_up = want_keyboard;
        }

        if let Some(g) = gpu.as_mut() {
            let view_now = kubuno_app.view_index.map(|f| f().min(views.len() - 1)).unwrap_or(view_idx);
            g.render(views[view_now]);
        }
    }
}

impl Gpu {
    async fn new(app: &AndroidApp) -> Result<Self, Box<dyn std::error::Error>> {
        let window = app.native_window().ok_or("no native window yet")?;
        let width = window.width().max(1) as u32;
        let height = window.height().max(1) as u32;

        // Prefer Vulkan: the emulator's GLES 3.0 backend caps textures at 2048 (< phone height) and lacks
        // the compute features vello needs. Vulkan supports the full size + compute.
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::GL,
            ..Default::default()
        });

        // Build a surface straight from the ANativeWindow pointer (no winit, no Java).
        let rwh = RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(window.ptr().cast()));
        let rdh = RawDisplayHandle::Android(AndroidDisplayHandle::new());
        let surface = unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: rdh,
                raw_window_handle: rwh,
            })?
        };

        let adapters = instance.enumerate_adapters(wgpu::Backends::VULKAN | wgpu::Backends::GL);
        let adapter = adapters
            .iter()
            .find(|a| {
                a.get_info().backend == wgpu::Backend::Vulkan && a.is_surface_supported(&surface)
            })
            .or_else(|| adapters.iter().find(|a| a.is_surface_supported(&surface)))
            .ok_or("no suitable GPU adapter")?;
        log::info!("KUBUNO: adapter = {:?}", adapter.get_info());

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("kubuno-device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: adapter.limits(),
                },
                None,
            )
            .await?;

        let caps = surface.get_capabilities(adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| *f == wgpu::TextureFormat::Rgba8Unorm || *f == wgpu::TextureFormat::Bgra8Unorm)
            .unwrap_or(caps.formats[0]);
        let max = device.limits().max_texture_dimension_2d;
        let (width, height) = (width.min(max), height.min(max));
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let painter = Painter::new(&device, format).map_err(|e| e.to_string())?;
        let font = load_system_font();
        if font.is_none() {
            log::warn!("KUBUNO: no system font found; text will be skipped");
        }

        Ok(Self {
            surface,
            device,
            queue,
            config,
            painter,
            font,
        })
    }

    fn render(&mut self, view: &str) {
        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
            Err(e) => {
                log::warn!("KUBUNO: surface error: {e:?}");
                return;
            }
        };

        if let Err(e) = self.painter.paint_view(
            &self.device,
            &self.queue,
            &frame,
            self.config.width,
            self.config.height,
            self.font.as_ref(),
            view,
        ) {
            log::warn!("KUBUNO: paint failed: {e}");
            return;
        }
        frame.present();
    }
}

/// Load a usable system TTF (Roboto ships on every Android device) and hand its bytes to the renderer.
fn load_system_font() -> Option<FontHandle> {
    const CANDIDATES: &[&str] = &[
        "/system/fonts/Roboto-Regular.ttf",
        "/system/fonts/RobotoFlex-Regular.ttf",
        "/system/fonts/DroidSans.ttf",
        "/system/fonts/NotoSans-Regular.ttf",
    ];
    // Same-family bolds only (a mismatched family looks wrong next to the regular face); if none is a real,
    // distinct file the renderer synthesises bold by stroking the regular outlines.
    const BOLD: &[&str] = &["/system/fonts/Roboto-Bold.ttf", "/system/fonts/RobotoFlex-Bold.ttf"];
    for path in CANDIDATES {
        if let Ok(bytes) = std::fs::read(path) {
            log::info!("KUBUNO: loaded font {path} ({} bytes)", bytes.len());
            let mut font = FontHandle::from_bytes(bytes.clone());
            for bpath in BOLD {
                match std::fs::read(bpath) {
                    // Some device font names (e.g. DroidSans-Bold) are symlinks to the regular face: only use a
                    // bold file that actually differs, otherwise fall back to synthesised (stroked) bold.
                    Ok(bbytes) if bbytes != bytes => {
                        log::info!("KUBUNO: loaded bold font {bpath} ({} bytes)", bbytes.len());
                        font = font.with_bold(bbytes);
                        break;
                    }
                    _ => {}
                }
            }
            return Some(font);
        }
    }
    None
}
