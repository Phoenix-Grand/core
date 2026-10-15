//! Render the renderer's sample screen to a PNG file, exactly as the device shells show it (same layout + raster
//! code), for a quick look without an emulator or a phone. A module's app renders its own screens with its own
//! `render_views` example (`<module>/mobile/common/…/examples`).
//!
//! `cargo run -p kubuno-mobile-render --example render_views -- <font.ttf> <out-dir> [width height]`

use std::path::PathBuf;

use kubuno_mobile_render::{render_view, FontHandle, SAMPLE_KBVIEW};

fn main() {
    let mut args = std::env::args().skip(1);
    let font_path = args.next().expect("usage: render_views <font.ttf> <out-dir> [width height]");
    let out = PathBuf::from(args.next().expect("usage: render_views <font.ttf> <out-dir> [width height]"));
    let width: u32 = args.next().and_then(|v| v.parse().ok()).unwrap_or(1080);
    let height: u32 = args.next().and_then(|v| v.parse().ok()).unwrap_or(2340);
    let mut font = FontHandle::from_bytes(std::fs::read(&font_path).expect("read font"));
    // Load a bold sibling for real-bold preview (e.g. arial.ttf -> arialbd.ttf), else bold is faked.
    let reg = PathBuf::from(&font_path);
    let stem = reg.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    for name in [format!("{stem}bd.ttf"), format!("{stem}-Bold.ttf"), format!("{stem} Bold.ttf")] {
        let cand = reg.with_file_name(name);
        if let Ok(b) = std::fs::read(&cand) {
            println!("bold: {}", cand.display());
            font = font.with_bold(b);
            break;
        }
    }
    std::fs::create_dir_all(&out).expect("create out dir");

    let t = std::time::Instant::now();
    let pm = render_view(SAMPLE_KBVIEW, width, height, Some(&font), None).expect("render");
    pm.save_png(out.join("sample.png")).expect("save png");
    println!("sample: {:?}", t.elapsed());
}
