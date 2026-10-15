//! Raster sources for the mobile views, keyed by the short name a `.kbview` gives in an `Image="…"` attribute,
//! decoded on demand and cached per thread.
//!
//! The renderer embeds no image of its own: an app registers the JPEGs its screens show ([`register_image`], from
//! its [`crate::App::setup`]) — e.g. the Photos app's sample photos, which live in the photos module.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use jpeg_decoder::PixelFormat;
use tiny_skia::{IntSize, Pixmap};

thread_local! {
    /// The JPEG bytes registered for each key.
    static SOURCES: RefCell<HashMap<String, &'static [u8]>> = RefCell::new(HashMap::new());
    /// The decoded rasters (a key's entry is dropped when the key is registered again).
    static CACHE: RefCell<HashMap<String, Option<Rc<Pixmap>>>> = RefCell::new(HashMap::new());
}

/// Register the JPEG bytes `Image="key"` shows (replacing any earlier ones for that key). Called from the app's
/// [`crate::App::setup`], on the shell's UI thread, before the first frame.
pub fn register_image(key: &str, jpeg: &'static [u8]) {
    SOURCES.with(|s| s.borrow_mut().insert(key.to_string(), jpeg));
    CACHE.with(|c| c.borrow_mut().remove(key));
}

/// The raw JPEG bytes registered for `key`.
fn image_bytes(key: &str) -> Option<&'static [u8]> {
    SOURCES.with(|s| s.borrow().get(key).copied())
}

/// The raster for `key` as a premultiplied-RGBA pixmap (decoded once, then cached). `None` for an unknown key or an
/// image that fails to decode.
pub fn image(key: &str) -> Option<Rc<Pixmap>> {
    if let Some(hit) = CACHE.with(|c| c.borrow().get(key).cloned()) {
        return hit;
    }
    let built = decode(key);
    CACHE.with(|c| c.borrow_mut().insert(key.to_string(), built.clone()));
    built
}

fn decode(key: &str) -> Option<Rc<Pixmap>> {
    Some(Rc::new(decode_jpeg(image_bytes(key)?)?))
}

/// Decode baseline JPEG bytes to a premultiplied-RGBA pixmap (opaque, so straight == premultiplied). Public so an
/// app can decode the JPEG rasters it embeds for its own host controls (JPEG is far smaller than PNG for imagery).
pub fn decode_jpeg(bytes: &[u8]) -> Option<Pixmap> {
    let mut dec = jpeg_decoder::Decoder::new(bytes);
    let pixels = dec.decode().ok()?;
    let info = dec.info()?;
    let (w, h) = (info.width as u32, info.height as u32);
    let mut rgba = Vec::with_capacity((w as usize) * (h as usize) * 4);
    match info.pixel_format {
        PixelFormat::RGB24 => {
            for px in pixels.as_chunks::<3>().0 {
                rgba.extend_from_slice(&[px[0], px[1], px[2], 0xff]);
            }
        }
        PixelFormat::L8 => {
            for &g in &pixels {
                rgba.extend_from_slice(&[g, g, g, 0xff]);
            }
        }
        _ => return None,
    }
    Pixmap::from_vec(rgba, IntSize::from_wh(w, h)?)
}
