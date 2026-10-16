//! The portable (OS-neutral) Kubuno mobile renderer.
//!
//! It lays out and paints a `.kbview`/`.kbcontrol` (parsed with the shared Kubuno grammar) into a CPU pixmap —
//! [`taffy`] flexbox layout, [`tiny_skia`] rasterisation (see `view`) — then shows it on a `wgpu` surface with a
//! plain textured full-screen draw. It knows nothing about a window system: the OS shell (`android/`, `ios/`)
//! creates the window, the wgpu device and the surface, loads a font, and calls [`Painter::paint_view`].
//!
//! The presentation step only needs a basic render pipeline (no compute shaders), so it runs on any GPU the
//! shells meet — including the iOS Simulator, whose Metal lacks the indirect compute dispatch a GPU vector
//! renderer needs. The view is re-rasterised only when it (or the surface size) changes.
//!
//! This crate is the *shared* engine every Kubuno mobile app runs on; it holds no module's app. A module ships its
//! mobile app in its own repository (`<module>/mobile`): its screens, its [`App`] descriptor and any control of its
//! own as a [`HostControl`] (e.g. Maps' `MapView`) and the images its screens show ([`register_image`], e.g. the
//! Photos sample photos), handed to the Android / iOS shell by a thin entry point.

mod data;
mod host;
mod icons;
mod images;
mod tasks;
mod view;
pub use data::{set_data, Scope, Value};
pub use tasks::{post_ui, run_ui_tasks, set_waker};
pub use host::{register_host_control, HostCanvas, HostControl, HostElement, HostRect};
pub use images::{decode_jpeg, register_image};
pub use view::{hit_test, render_view, view_hits, Hit, Rgba};

/// The rasteriser the renderer paints with, re-exported so an app's host controls use the very same version.
pub use tiny_skia;

/// Gesture API for the shells: a one-finger drag (`gesture_pan`), a two-finger pinch (`gesture_zoom`) and a reset
/// (`gesture_reset`), routed to the app's host controls. Deltas and focus are in physical pixels; `w`,`h` is the
/// surface size.
pub use host::{pan as gesture_pan, reset as gesture_reset, zoom as gesture_zoom};

/// A mobile app the shells run: a module's app, described by the module itself (e.g.
/// `kubuno_maps_mobile_common::APP` in `maps/mobile`) and handed to the Android / iOS shell by the module's own
/// entry point.
#[derive(Clone, Copy)]
pub struct App {
    /// The lowercase module id (`"maps"`).
    pub id: &'static str,
    /// The display name (`"Kubuno Maps"`).
    pub label: &'static str,
    /// The screens the app shows (the home screen first). Without [`Self::view_index`] the shell cycles through them
    /// on tap (the demo); with it, the app chooses which one is shown from its own state.
    pub views: &'static [&'static str],
    /// Called once on the UI thread before the first frame: registers the app's host controls and seeds its state.
    pub setup: fn(),
    /// Handle a resolved tap — the top-most `x:Name`/evented element under the touch (see [`TapEvent`]) — by mutating
    /// the app's own state. `None` keeps the shell's tap-to-advance demo (for an app not wired yet).
    pub on_event: Option<fn(&TapEvent)>,
    /// The index into [`Self::views`] to show now, read from the app's state after each event. `None` keeps the
    /// shell's own cycling index.
    pub view_index: Option<fn() -> usize>,
}

/// A resolved tap on a view: the top-most element with an `x:Name` or an event under the touch, and its `OnClick`
/// handler (empty if it has a name but no click handler). The shells hand it to [`App::on_event`]; the engine runs
/// no app logic itself.
#[derive(Clone, Debug, PartialEq)]
pub struct TapEvent {
    /// The element's `x:Name`, if any.
    pub name: Option<String>,
    /// Its `OnClick` handler, or empty.
    pub handler: String,
    /// The touch point (physical px).
    pub x: f32,
    pub y: f32,
}

use std::borrow::Cow;
use std::sync::Arc;

/// A loaded font: the regular weight, and optionally a bold weight (read with skrifa for metrics and glyph
/// outlines). The shell reads the files from the device (e.g. Android's `/system/fonts`); when no bold file is
/// given, the renderer synthesises bold by stroking the glyphs.
pub struct FontHandle {
    regular: Arc<Vec<u8>>,
    bold: Option<Arc<Vec<u8>>>,
}

impl FontHandle {
    /// Wrap the regular TTF/OTF bytes. The shell reads them from the device (e.g. Android's /system/fonts).
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self { regular: Arc::new(bytes), bold: None }
    }

    /// Add the bold TTF/OTF bytes, so `FontWeight="SemiBold"`/`"Bold"` uses a real bold face.
    pub fn with_bold(mut self, bold: Vec<u8>) -> Self {
        self.bold = Some(Arc::new(bold));
        self
    }

    /// The font bytes for a weight: the bold face when `bold` and one was given, else the regular face.
    pub(crate) fn data(&self, bold: bool) -> &[u8] {
        match (bold, &self.bold) {
            (true, Some(b)) => b,
            _ => &self.regular,
        }
    }

    /// Whether a real bold face is loaded (otherwise bold is faked by stroking the outlines).
    pub(crate) fn has_bold(&self) -> bool {
        self.bold.is_some()
    }
}

/// The full-screen textured triangle that copies the rasterised view onto the surface.
const BLIT_WGSL: &str = r#"
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
    var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    var o: VOut;
    o.pos = vec4<f32>(p[i], 0.0, 1.0);
    o.uv = vec2<f32>((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
    return o;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4<f32> {
    return textureSample(tex, samp, v.uv);
}
"#;

/// The texture holding the last rasterised view, and its bind group.
struct Target {
    texture: wgpu::Texture,
    bind: wgpu::BindGroup,
    width: u32,
    height: u32,
}

/// Rasterises views on the CPU and presents them on a wgpu surface. One per device/surface-format.
pub struct Painter {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    tex_format: wgpu::TextureFormat,
    target: Option<Target>,
    /// The safe-area insets (top, bottom) in physical px given by the shell; `None` uses a phone default.
    safe_area: Option<(f32, f32)>,
    /// What the target currently holds: (view source pointer, length, width, height, insets bits, host version).
    key: Option<(usize, usize, u32, u32, u64, u64)>,
    /// The tappable targets of the view currently in the target, for [`Self::resolve_tap`] (same geometry as drawn).
    hits: Vec<Hit>,
}

impl Painter {
    /// Build the presentation pipeline for a device and the surface's texture format.
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Result<Self, String> {
        // Upload the (sRGB-encoded) pixels so that sampling then writing the surface round-trips them unchanged.
        let tex_format =
            if format.is_srgb() { wgpu::TextureFormat::Rgba8UnormSrgb } else { wgpu::TextureFormat::Rgba8Unorm };
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("kubuno-blit"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(BLIT_WGSL)),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("kubuno-blit"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("kubuno-blit"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("kubuno-blit"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs",
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs",
                targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("kubuno-blit"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        Ok(Self { pipeline, layout, sampler, tex_format, target: None, safe_area: None, key: None, hits: Vec::new() })
    }

    /// The app-level tap for a touch at `(x, y)` (physical px) against the view currently on screen: the top-most
    /// element with an `x:Name` or an event, with its `OnClick` handler. `None` if the touch hits no such element.
    pub fn resolve_tap(&self, x: f32, y: f32) -> Option<TapEvent> {
        let hit = hit_test(&self.hits, x, y)?;
        let handler = hit.events.iter().find(|(e, _)| e == "Click").map(|(_, h)| h.clone()).unwrap_or_default();
        Some(TapEvent { name: hit.name.clone(), handler, x, y })
    }

    /// Set the safe-area insets (top: status bar / notch / Dynamic Island, bottom: home indicator / gesture bar)
    /// in physical pixels, as the OS reports them. The content is laid out between them; the screen background
    /// still fills the whole surface.
    pub fn set_safe_area(&mut self, top: f32, bottom: f32) {
        self.safe_area = Some((top.max(0.0), bottom.max(0.0)));
    }

    /// Parse a real `.kbview`/`.kbcontrol` with the shared grammar, lay it out, rasterise it (only when it or the
    /// size changed) and present it onto the surface texture.
    #[allow(clippy::too_many_arguments)]
    pub fn paint_view(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        surface: &wgpu::SurfaceTexture,
        width: u32,
        height: u32,
        font: Option<&FontHandle>,
        src: &str,
    ) -> Result<(), String> {
        let insets = self.safe_area.map_or(0, |(t, b)| ((t.to_bits() as u64) << 32) | b.to_bits() as u64);
        // The data context contributes to the key, so a changed binding / repeater list re-rasterises.
        let state_version = crate::host::version().wrapping_add(crate::data::version().wrapping_mul(1_000_003));
        let key = (src.as_ptr() as usize, src.len(), width, height, insets, state_version);
        if self.key != Some(key) || self.target.is_none() {
            let pixmap =
                render_view(src, width, height, font, self.safe_area).ok_or("cannot allocate the view pixmap")?;
            // Capture the tappable targets of this frame (same layout), for resolve_tap between frames.
            self.hits = view_hits(src, width, height, font, self.safe_area);
            let stale = self.target.as_ref().is_none_or(|t| t.width != width || t.height != height);
            if stale {
                self.target = Some(self.make_target(device, width, height));
            }
            let target = self.target.as_ref().ok_or("no view texture")?;
            queue.write_texture(
                wgpu::ImageCopyTexture {
                    texture: &target.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                pixmap.data(),
                wgpu::ImageDataLayout { offset: 0, bytes_per_row: Some(4 * width), rows_per_image: Some(height) },
                wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            );
            self.key = Some(key);
        }
        let target = self.target.as_ref().ok_or("no view texture")?;
        let view = surface.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("kubuno-blit") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("kubuno-blit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::WHITE), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &target.bind, &[]);
            pass.draw(0..3, 0..1);
        }
        queue.submit(std::iter::once(encoder.finish()));
        Ok(())
    }

    fn make_target(&self, device: &wgpu::Device, width: u32, height: u32) -> Target {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("kubuno-view"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.tex_format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let tview = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("kubuno-view"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&tview) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        Target { texture, bind, width, height }
    }
}

/// The renderer's sample screen, authored as a real `.kbview` file edited in Visual Studio and embedded so the exact
/// file the developer edits is the one parsed and rendered — one source of truth across designer and device. It
/// exercises the shared control vocabulary; no module's app lives here (each ships its own in `<module>/mobile`).
pub const SAMPLE_KBVIEW: &str = include_str!("views/home.kbview");

/// The renderer's own sample as an [`App`]: what the shells' standalone demo build runs, to try the engine and a
/// shell without any module.
pub const SAMPLE_APP: App =
    App { id: "sample", label: "Kubuno", views: &[SAMPLE_KBVIEW], setup: no_setup, on_event: None, view_index: None };

/// An app with no host control or image to register.
fn no_setup() {}
