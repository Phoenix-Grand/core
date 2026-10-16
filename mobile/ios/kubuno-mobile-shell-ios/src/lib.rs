//! The Kubuno iOS shell: a pure-Rust app host (no Swift/Objective-C of our own, no UIKit written by hand), shared
//! by every module's iOS app.
//!
//! winit owns the `UIWindow` and the run loop; it hands us a `CAMetalLayer`-backed surface that `wgpu` renders into
//! with the Metal backend, driving the portable renderer ([`kubuno_mobile_render`]) over the app's `.kbview` screens
//! — the very same files the Android shell renders. It holds no app: a module's iOS crate (e.g.
//! `maps/mobile/ios/kubuno-maps-mobile-ios`) calls [`run`] with its [`App`]. The `standalone` feature (on by
//! default) keeps a demo binary showing the renderer's sample screen. Packaged into a
//! `.app` bundle and run in the iOS Simulator or on an iPhone from a Mac. Tap anywhere to advance to the next screen.

use std::sync::Arc;

use kubuno_mobile_render::{App, FontHandle, Painter};
use winit::application::ApplicationHandler;
use winit::event::{Touch, TouchPhase, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowId};

/// Everything that only exists once a window (and its Metal layer) is available.
struct Gpu {
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    painter: Painter,
    font: Option<FontHandle>,
}

/// The winit application: the GPU once the window exists, the app (its screens, event handling and screen choice)
/// and the shell's own cycling index (used only until the app is wired with `view_index`).
struct Shell {
    gpu: Option<Gpu>,
    app: App,
    idx: usize,
}

impl ApplicationHandler for Shell {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.gpu.is_some() {
            return;
        }
        let window = match event_loop.create_window(Window::default_attributes()) {
            Ok(w) => Arc::new(w),
            Err(e) => {
                log::error!("KUBUNO: create_window failed: {e}");
                return;
            }
        };
        match pollster::block_on(Gpu::new(window)) {
            Ok(g) => {
                log::info!("KUBUNO: gpu ready ({}x{})", g.config.width, g.config.height);
                g.window.request_redraw();
                self.gpu = Some(g);
            }
            Err(e) => log::error!("KUBUNO: gpu init failed: {e}"),
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                if let Some(g) = self.gpu.as_mut() {
                    g.resize(size.width, size.height);
                    g.window.request_redraw();
                }
            }
            // A tap (down edge of a touch): the app resolves and handles it when wired, else the demo advances.
            WindowEvent::Touch(Touch { phase: TouchPhase::Started, location, .. }) => {
                let (x, y) = (location.x as f32, location.y as f32);
                match self.app.on_event {
                    Some(on_event) => {
                        if let Some(ev) = self.gpu.as_ref().and_then(|g| g.painter.resolve_tap(x, y)) {
                            log::info!("KUBUNO: tap -> {:?} / {}", ev.name, ev.handler);
                            on_event(&ev);
                        }
                    }
                    None => {
                        self.idx = (self.idx + 1) % self.app.views.len();
                        log::info!("KUBUNO: tap -> view {}/{}", self.idx + 1, self.app.views.len());
                    }
                }
                if let Some(g) = self.gpu.as_ref() {
                    g.window.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => {
                // Apply any results background work posted back to the UI thread before drawing.
                kubuno_mobile_render::run_ui_tasks();
                let idx = self.app.view_index.map(|f| f().min(self.app.views.len() - 1)).unwrap_or(self.idx);
                let view = self.app.views[idx];
                if let Some(g) = self.gpu.as_mut() {
                    g.render(view);
                    // Keep presenting so the first frames after launch are not missed.
                    g.window.request_redraw();
                }
            }
            _ => {}
        }
    }

    // A worker thread posted a UI task and woke the loop (through the event-loop proxy): run it and redraw.
    fn user_event(&mut self, _event_loop: &ActiveEventLoop, _event: ()) {
        kubuno_mobile_render::run_ui_tasks();
        if let Some(g) = self.gpu.as_ref() {
            g.window.request_redraw();
        }
    }
}

impl Gpu {
    async fn new(window: Arc<Window>) -> Result<Self, Box<dyn std::error::Error>> {
        let size = window.inner_size();
        let (width, height) = (size.width.max(1), size.height.max(1));

        // iOS runs on Metal.
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::METAL,
            ..Default::default()
        });
        let surface = instance.create_surface(window.clone())?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::default(),
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
            })
            .await
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

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| *f == wgpu::TextureFormat::Bgra8Unorm || *f == wgpu::TextureFormat::Rgba8Unorm)
            .unwrap_or(caps.formats[0]);
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
            log::warn!("KUBUNO: no usable font found; text will be skipped");
        }

        Ok(Self {
            window,
            surface,
            device,
            queue,
            config,
            painter,
            font,
        })
    }

    fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
    }

    fn render(&mut self, view: &str) {
        // Lay the content out between the status bar / notch / Dynamic Island and the home indicator.
        if let Some((top, bottom)) = safe_area_px(&self.window) {
            self.painter.set_safe_area(top, bottom);
        }
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

/// The window's safe-area insets (top, bottom) in physical pixels, read from the UIKit view's `safeAreaInsets`.
#[cfg(target_os = "ios")]
fn safe_area_px(window: &Window) -> Option<(f32, f32)> {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, Encode, Encoding};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct UIEdgeInsets {
        top: f64,
        left: f64,
        bottom: f64,
        right: f64,
    }
    // SAFETY: matches UIKit's `UIEdgeInsets` (four CGFloat = f64 on 64-bit iOS).
    unsafe impl Encode for UIEdgeInsets {
        const ENCODING: Encoding =
            Encoding::Struct("UIEdgeInsets", &[f64::ENCODING, f64::ENCODING, f64::ENCODING, f64::ENCODING]);
    }

    let RawWindowHandle::UiKit(handle) = window.window_handle().ok()?.as_raw() else { return None };
    // SAFETY: winit hands out the live UIView backing this window; `safeAreaInsets` is a plain getter.
    let insets: UIEdgeInsets = unsafe {
        let view: &AnyObject = handle.ui_view.cast::<AnyObject>().as_ref();
        msg_send![view, safeAreaInsets]
    };
    let scale = window.scale_factor() as f32;
    Some((insets.top as f32 * scale, insets.bottom as f32 * scale))
}

#[cfg(not(target_os = "ios"))]
fn safe_area_px(_window: &Window) -> Option<(f32, f32)> {
    None
}

/// Load a usable TTF. The packaging step copies a font next to the executable (the `.app` root), which is the
/// most reliable source inside the sandbox; a few system paths are tried as a fallback.
fn load_system_font() -> Option<FontHandle> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["font.ttf", "Roboto-Regular.ttf"] {
                if let Ok(bytes) = std::fs::read(dir.join(name)) {
                    log::info!("KUBUNO: loaded bundled font {name} ({} bytes)", bytes.len());
                    let mut font = FontHandle::from_bytes(bytes);
                    if let Ok(bold) = std::fs::read(dir.join("font-bold.ttf")) {
                        log::info!("KUBUNO: loaded bundled bold font ({} bytes)", bold.len());
                        font = font.with_bold(bold);
                    }
                    return Some(font);
                }
            }
        }
    }
    const CANDIDATES: &[&str] = &[
        "/System/Library/Fonts/Core/HelveticaNeue.ttc",
        "/System/Library/Fonts/LanguageSupport/NotoSans.ttc",
        "/System/Library/Fonts/Core/Helvetica.ttc",
    ];
    for path in CANDIDATES {
        if let Ok(bytes) = std::fs::read(path) {
            log::info!("KUBUNO: loaded system font {path} ({} bytes)", bytes.len());
            return Some(FontHandle::from_bytes(bytes));
        }
    }
    None
}

/// Run `app` until the window closes. A module's iOS entry point (`fn main`) calls it.
pub fn run(app: App) {
    log::info!("KUBUNO: {} started (iOS shell)", app.label);
    if app.views.is_empty() {
        log::error!("KUBUNO: {} has no screen", app.label);
        return;
    }
    // Register the app's host controls before the first frame.
    (app.setup)();
    // Logs show up in `xcrun simctl spawn booted log stream` / the run output.
    let event_loop = EventLoop::new().expect("create event loop");
    event_loop.set_control_flow(ControlFlow::Wait);
    // Background work posts its result to the UI thread; waking the proxy makes the loop run it at once.
    let proxy = event_loop.create_proxy();
    kubuno_mobile_render::set_waker(move || {
        let _ = proxy.send_event(());
    });
    let mut shell = Shell { gpu: None, app, idx: 0 };
    event_loop.run_app(&mut shell).expect("run app");
}
