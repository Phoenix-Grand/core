//! Self-hosted sign-in CAPTCHA - several kinds of human test, all generated and
//! verified here.
//!
//! # Why this exists
//!
//! After a configurable number of consecutive failures on an account
//! ([`crate::auth::login_throttle`] counts them), the sign-in form must carry a
//! solved challenge before the password is even checked
//! ([`crate::handlers::auth::login`]). This is the brute-force gate the
//! administrator asked for: it costs a human nothing and a bot a solve per try.
//!
//! # No third party (Kubuno charter)
//!
//! The charter proscribes any Google reference and any third-party service:
//! reCAPTCHA, hCaptcha and the like are all out. So every challenge is drawn (as
//! a PNG the core rasterises itself - no image crate, no font file), stored and
//! checked here, and the answer never leaves the server.
//!
//! # Kinds ([`CaptchaKind`])
//!
//! * **Text** - warped characters to retype. The distortion and noise are
//!   tunable; the letters exist only as warped pixels (never as markup or
//!   vector geometry), so the answer cannot be read off the response.
//! * **Slider** - a jigsaw piece to drag into the gap it was cut from. The
//!   answer is the horizontal position; a tolerance decides how precise the drop
//!   must be.
//! * **Math** - a small sum to solve. The lightest option, for instances that
//!   only want a token gate.
//!
//! All are short-lived and single-use: the first verification attempt consumes
//! the row whether or not it matches, so each challenge allows exactly one try.

use crate::{errors::AppError, settings::SettingScope};
use base64::Engine as _;
use chrono::{Duration, Utc};
use kubuno_db::{params, DbPool};
use rand::Rng;
use serde_json::{json, Value};
use uuid::Uuid;

/// Alphabet without visually ambiguous glyphs (`O`/`0`, `I`/`1`/`L`, `Z`/`2`).
const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXY3456789";
/// How long a challenge stays solvable.
const TTL_MINUTES: i64 = 5;

/// Which human test to present. Stored on the challenge row so verification
/// knows how to read `answer`, and chosen by `security.captcha_type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptchaKind {
    Text,
    Slider,
    Math,
}

impl CaptchaKind {
    fn as_str(self) -> &'static str {
        match self {
            CaptchaKind::Text => "text",
            CaptchaKind::Slider => "slider",
            CaptchaKind::Math => "math",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "slider" => CaptchaKind::Slider,
            "math" => CaptchaKind::Math,
            _ => CaptchaKind::Text,
        }
    }
}

/// Instance-wide rendering settings, resolved once per generation.
struct Params {
    kind: CaptchaKind,
    length: i64,
    distortion: i64,
    noise: i64,
    math_max: i64,
}

async fn get_int(db: &DbPool, key: &str, default: i64, min: i64, max: i64) -> i64 {
    match crate::settings::chain::resolve_for(db, key, &SettingScope::INSTANCE).await {
        Ok(r) => r
            .value
            .as_ref()
            .and_then(Value::as_i64)
            .unwrap_or(default)
            .clamp(min, max),
        Err(e) => {
            tracing::error!(error = %e, key, "captcha: unreadable setting");
            default
        }
    }
}

async fn resolve_params(db: &DbPool) -> Params {
    let kind = match crate::settings::chain::resolve_for(db, "security.captcha_type", &SettingScope::INSTANCE).await {
        Ok(r) => CaptchaKind::parse(r.value.as_ref().and_then(Value::as_str).unwrap_or("text")),
        Err(_) => CaptchaKind::Text,
    };
    Params {
        kind,
        length: get_int(db, "security.captcha_length", 5, 4, 8).await,
        distortion: get_int(db, "security.captcha_distortion", 40, 0, 100).await,
        noise: get_int(db, "security.captcha_noise", 40, 0, 100).await,
        math_max: get_int(db, "security.captcha_math_max", 10, 5, 50).await,
    }
}

/// A generated challenge: the id echoed back at sign-in, and the JSON the form
/// needs to render it (its `type` plus per-kind images or prompt).
pub struct Challenge {
    pub id: Uuid,
    pub payload: Value,
}

/// Draw, store and return a fresh challenge of the configured kind. Sweeps stale
/// rows first so the table cannot grow without bound.
pub async fn generate(db: &DbPool) -> Result<Challenge, AppError> {
    let now = Utc::now();
    if let Err(e) = db
        .execute(
            "DELETE FROM core.captcha_challenges WHERE expires_at < $1 OR consumed = TRUE",
            params![now],
        )
        .await
    {
        tracing::warn!(error = %e, "captcha: could not purge the stale challenges");
    }

    let p = resolve_params(db).await;
    let (answer, mut payload) = match p.kind {
        CaptchaKind::Text => build_text(&p),
        CaptchaKind::Slider => build_slider(),
        CaptchaKind::Math => build_math(&p),
    };

    let id = store(db, p.kind, &answer).await?;
    payload["challenge_id"] = json!(id);
    payload["type"] = json!(p.kind.as_str());
    Ok(Challenge { id, payload })
}

async fn store(db: &DbPool, kind: CaptchaKind, answer: &str) -> Result<Uuid, AppError> {
    let expires_at = Utc::now() + Duration::minutes(TTL_MINUTES);
    // The id is generated in Rust and bound rather than read back with RETURNING.
    let id = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.captcha_challenges (id, answer, kind, expires_at) VALUES ($1, $2, $3, $4)",
        params![id, answer, kind.as_str(), expires_at],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "captcha: could not store the challenge");
        AppError::Internal(anyhow::anyhow!("captcha: génération impossible"))
    })?;
    Ok(id)
}

fn data_url(png: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    )
}

// ── Text ────────────────────────────────────────────────────────────────────

fn build_text(p: &Params) -> (String, Value) {
    let code: String = {
        let mut rng = rand::thread_rng();
        (0..p.length)
            .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
            .collect()
    };
    let png = render_text_png(&code, p.distortion, p.noise);
    (code, json!({ "image": data_url(&png) }))
}

// ── Math ────────────────────────────────────────────────────────────────────

fn build_math(p: &Params) -> (String, Value) {
    let mut rng = rand::thread_rng();
    let a = rng.gen_range(1..=p.math_max);
    let b = rng.gen_range(1..=p.math_max);
    ((a + b).to_string(), json!({ "prompt": format!("{a} + {b}") }))
}

// ── Slider (jigsaw) ───────────────────────────────────────────────────────────

const SL_W: usize = 260;
const SL_H: usize = 160;
const PIECE: i32 = 46; // square side
const BUMP: i32 = 9; // knob radius on the right edge
const PIECE_W: i32 = PIECE + BUMP; // piece canvas width

/// Is (dx, dy) inside the jigsaw piece: a square with a round knob on its right.
fn in_piece(dx: i32, dy: i32) -> bool {
    if (0..PIECE).contains(&dx) && (0..PIECE).contains(&dy) {
        return true;
    }
    let (cx, cy) = (PIECE, PIECE / 2);
    dx >= PIECE && (dx - cx) * (dx - cx) + (dy - cy) * (dy - cy) <= BUMP * BUMP
}

fn build_slider() -> (String, Value) {
    let mut rng = rand::thread_rng();
    // Structured greyscale background so the gap has something to align against.
    let mut bg = vec![0u8; SL_W * SL_H];
    for y in 0..SL_H {
        for x in 0..SL_W {
            let base = 150.0 + 40.0 * ((x as f32 * 0.03).sin() + (y as f32 * 0.04).cos());
            bg[y * SL_W + x] = base.clamp(60.0, 220.0) as u8;
        }
    }
    for _ in 0..16 {
        let rw = rng.gen_range(20..70);
        let rh = rng.gen_range(20..60);
        let rx = rng.gen_range(0..SL_W as i32 - rw);
        let ry = rng.gen_range(0..SL_H as i32 - rh);
        let tone = rng.gen_range(70..210) as u8;
        for y in ry..ry + rh {
            for x in rx..rx + rw {
                bg[y as usize * SL_W + x as usize] = tone;
            }
        }
    }
    for _ in 0..600 {
        let x = rng.gen_range(0..SL_W);
        let y = rng.gen_range(0..SL_H);
        bg[y * SL_W + x] = rng.gen_range(60..220);
    }

    let piece_y = rng.gen_range(10..(SL_H as i32 - PIECE - 10));
    let max_x = SL_W as i32 - PIECE_W - 4;
    // Gap in the right two-thirds so the piece (which starts at the far left)
    // always has somewhere to travel.
    let target_x = rng.gen_range((SL_W as i32 / 3)..max_x);

    // The piece: the background fragment under the mask, with alpha for shape.
    let mut piece = vec![0u8; (PIECE_W as usize) * (PIECE as usize) * 2]; // gray + alpha
    for dy in 0..PIECE {
        for dx in 0..PIECE_W {
            let idx = ((dy * PIECE_W + dx) as usize) * 2;
            if in_piece(dx, dy) {
                let sx = (target_x + dx) as usize;
                let sy = (piece_y + dy) as usize;
                piece[idx] = bg[sy * SL_W + sx];
                piece[idx + 1] = 255;
            } else {
                piece[idx + 1] = 0;
            }
        }
    }

    // Darken one piece-shaped region on the background, outlined at its edge.
    let punch = |bg: &mut [u8], gx: i32, gy: i32| {
        for dy in 0..PIECE {
            for dx in 0..PIECE_W {
                if !in_piece(dx, dy) {
                    continue;
                }
                let (x, y) = ((gx + dx), (gy + dy));
                if x < 0 || x >= SL_W as i32 || y < 0 || y >= SL_H as i32 {
                    continue;
                }
                let (x, y) = (x as usize, y as usize);
                let edge = !in_piece(dx - 1, dy)
                    || !in_piece(dx + 1, dy)
                    || !in_piece(dx, dy - 1)
                    || !in_piece(dx, dy + 1);
                bg[y * SL_W + x] = if edge { 40 } else { (bg[y * SL_W + x] as u16 * 4 / 10) as u8 };
            }
        }
    };

    // A couple of DECOY gaps, darkened exactly like the real one, so the true
    // slot is not simply the darkest piece-shaped region a script can scan for.
    // They are only drawn on the background - no piece is cut from them, so they
    // do not help a human either way, but they defeat the trivial "find the
    // darkest notch" auto-solver (kubuno-security review).
    for _ in 0..2 {
        let fx = rng.gen_range(4..max_x);
        // Keep decoys clear of the real gap so they can't overlap the answer.
        if (fx - target_x).abs() < PIECE_W + 6 {
            continue;
        }
        let fy = rng.gen_range(6..(SL_H as i32 - PIECE - 6));
        punch(&mut bg, fx, fy);
    }

    // Punch the real gap last, at the target position.
    punch(&mut bg, target_x, piece_y);

    let bg_png = encode_png(SL_W, SL_H, 0, 1, &bg);
    let piece_png = encode_png(PIECE_W as usize, PIECE as usize, 4, 2, &piece);
    (
        target_x.to_string(),
        json!({
            "background": data_url(&bg_png),
            "piece": data_url(&piece_png),
            "piece_y": piece_y,
            "max_x": max_x,
            "width": SL_W,
            "height": SL_H,
            "piece_width": PIECE_W,
        }),
    )
}

// ── Verification ──────────────────────────────────────────────────────────────

/// Verify an answer and consume the challenge.
///
/// The row is consumed on the FIRST attempt regardless of the answer - one guess
/// per challenge. Returns `true` only when a live, unconsumed challenge existed
/// and the answer satisfied its kind. Fails **closed** on a database error: a
/// broken store must not let the gate be bypassed.
pub async fn verify(db: &DbPool, id: Uuid, given: &str) -> bool {
    // MySQL has no UPDATE ... RETURNING, so the guarded consume and the read of
    // the answer are done as two statements inside one transaction. The UPDATE's
    // `consumed = FALSE` guard makes exactly one racer win (rows_affected == 1);
    // reading by id afterwards, still in the tx, sees the row we just consumed
    // before any concurrent sweep can delete it.
    let now = Utc::now();
    let mut tx = match db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "captcha: verification failed");
            return false;
        }
    };

    let affected = match tx
        .execute(
            "UPDATE core.captcha_challenges SET consumed = TRUE \
             WHERE id = $1 AND consumed = FALSE AND expires_at > $2",
            params![id, now],
        )
        .await
    {
        Ok(n) => n,
        Err(e) => {
            tracing::error!(error = %e, "captcha: verification failed");
            let _ = tx.rollback().await;
            return false;
        }
    };
    if affected == 0 {
        let _ = tx.rollback().await;
        return false;
    }

    let row = match tx
        .fetch_optional_row(
            "SELECT answer, kind FROM core.captcha_challenges WHERE id = $1",
            params![id],
        )
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => {
            let _ = tx.rollback().await;
            return false;
        }
        Err(e) => {
            tracing::error!(error = %e, "captcha: verification failed");
            let _ = tx.rollback().await;
            return false;
        }
    };

    let (expected, kind): (String, String) = match (
        row.try_get::<String>("answer"),
        row.try_get::<String>("kind"),
    ) {
        (Ok(a), Ok(k)) => (a, k),
        _ => {
            let _ = tx.rollback().await;
            return false;
        }
    };

    if let Err(e) = tx.commit().await {
        // Fail closed: if the consume did not persist, do not honour the answer.
        tracing::error!(error = %e, "captcha: verification failed");
        return false;
    }

    match CaptchaKind::parse(&kind) {
        CaptchaKind::Text => given.trim().to_uppercase() == expected,
        CaptchaKind::Math => given.trim().parse::<i64>().ok() == expected.parse::<i64>().ok(),
        CaptchaKind::Slider => {
            let tolerance = get_int(db, "security.captcha_slider_tolerance", 6, 2, 20).await;
            match (given.trim().parse::<f64>(), expected.parse::<f64>()) {
                (Ok(got), Ok(want)) => (got - want).abs() <= tolerance as f64,
                _ => false,
            }
        }
    }
}

// ── Text glyph font + rasteriser ──────────────────────────────────────────────

/// The 5×7 dot-matrix pattern of a glyph: seven rows, the low five bits each.
/// `None` for a character not in [`ALPHABET`]. Drawing from a bitmap into a
/// raster (rather than SVG text or shapes) is what keeps the answer out of the
/// response - the client gets warped pixels, not letters or decodable geometry.
fn glyph(ch: char) -> Option<[u8; 7]> {
    let rows = match ch {
        'A' => [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'B' => [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
        'C' => [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
        'D' => [0x1C, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1C],
        'E' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
        'F' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
        'G' => [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
        'H' => [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'J' => [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
        'K' => [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
        'M' => [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
        'N' => [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
        'P' => [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
        'Q' => [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
        'R' => [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
        'S' => [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
        'T' => [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        'U' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'V' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
        'W' => [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
        'X' => [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
        'Y' => [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
        '3' => [0x1E, 0x01, 0x01, 0x0E, 0x01, 0x01, 0x1E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => [0x1F, 0x10, 0x10, 0x1E, 0x01, 0x01, 0x1E],
        '6' => [0x0E, 0x10, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        // Closed top loop over a straight right-hand descender, so a warped '9'
        // cannot be read as a '3' (whose left side is open on every row).
        '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x01, 0x01],
        _ => return None,
    };
    Some(rows)
}

const IMG_W: usize = 180;
const IMG_H: usize = 60;

/// Rasterise the code into an 8-bit greyscale PNG. `distortion` (0..100) scales
/// the rotation and the per-column sine warp; `noise` (0..100) scales the
/// speckle and the number of interference curves.
fn render_text_png(code: &str, distortion: i64, noise: i64) -> Vec<u8> {
    let d = (distortion.clamp(0, 100) as f32) / 100.0;
    let nf = (noise.clamp(0, 100) as f32) / 100.0;
    let mut rng = rand::thread_rng();
    let mut buf = vec![0xF1u8; IMG_W * IMG_H];

    let put = |buf: &mut [u8], x: i32, y: i32, v: u8| {
        if x >= 0 && (x as usize) < IMG_W && y >= 0 && (y as usize) < IMG_H {
            buf[y as usize * IMG_W + x as usize] = v;
        }
    };

    let dots = (nf * 130.0) as i32;
    for _ in 0..dots {
        let x = rng.gen_range(0..IMG_W as i32);
        let y = rng.gen_range(0..IMG_H as i32);
        put(&mut buf, x, y, rng.gen_range(170..210));
    }

    let n = code.chars().count().max(1);
    let slot = IMG_W as f32 / n as f32;
    const SCALE: f32 = 5.0;
    for (i, ch) in code.chars().enumerate() {
        let Some(rows) = glyph(ch) else { continue };
        let cx = slot * (i as f32 + 0.5);
        let cy = IMG_H as f32 / 2.0 + rng.gen_range(-4.0..4.0);
        let angle = rng.gen_range(-0.38f32..0.38) * d; // up to ≈ ±22° at 100
        let (sin, cos) = angle.sin_cos();
        // Keep the sine warp gentle enough that a glyph's distinguishing strokes
        // (e.g. 3 vs 9, 5 vs 6) survive, so a human reads the stored answer.
        let amp = rng.gen_range(1.0f32..2.0) + 3.5 * d;
        let freq = rng.gen_range(0.04f32..0.09);
        let phase = rng.gen_range(0.0f32..std::f32::consts::TAU);
        let ink = rng.gen_range(20..70);

        for (row, bits) in rows.iter().enumerate() {
            for col in 0..5 {
                if bits & (0x10 >> col) == 0 {
                    continue;
                }
                let steps = SCALE.ceil() as i32 + 1;
                for sy in 0..steps {
                    for sx in 0..steps {
                        let lx = (col as f32 + sx as f32 / steps as f32 - 2.5) * SCALE;
                        let ly = (row as f32 + sy as f32 / steps as f32 - 3.5) * SCALE;
                        let px = cx + lx * cos - ly * sin;
                        let py = cy + lx * sin + ly * cos + amp * ((cx + lx) * freq + phase).sin();
                        put(&mut buf, px as i32, py as i32, ink);
                    }
                }
            }
        }
    }

    let curves = (nf * 3.0).round() as i32;
    for _ in 0..curves {
        let amp = rng.gen_range(4.0f32..10.0);
        let freq = rng.gen_range(0.04f32..0.09);
        let phase = rng.gen_range(0.0f32..std::f32::consts::TAU);
        let base = rng.gen_range(15..45) as f32;
        // Lighter than the glyph ink (20..70) so an interference curve reads as a
        // background line, never mistaken for part of a character.
        let g = rng.gen_range(150..195);
        for x in 0..IMG_W as i32 {
            let y = base + amp * (x as f32 * freq + phase).sin();
            put(&mut buf, x, y as i32, g);
            put(&mut buf, x, y as i32 + 1, g);
        }
    }

    encode_png(IMG_W, IMG_H, 0, 1, &buf)
}

/// Minimal PNG encoder (8-bit). `color_type`/`channels`: 0/1 greyscale, 4/2
/// greyscale+alpha. Pixel data is wrapped in a zlib stream of *stored*
/// (uncompressed) deflate blocks, so no compressor is needed; the images are
/// tiny, so the size cost is irrelevant.
fn encode_png(w: usize, h: usize, color_type: u8, channels: usize, pixels: &[u8]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &b in bytes {
            crc ^= b as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }
    fn adler32(bytes: &[u8]) -> u32 {
        let (mut a, mut b) = (1u32, 0u32);
        for &byte in bytes {
            a = (a + byte as u32) % 65521;
            b = (b + a) % 65521;
        }
        (b << 16) | a
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut typed = kind.to_vec();
        typed.extend_from_slice(data);
        out.extend_from_slice(&typed);
        out.extend_from_slice(&crc32(&typed).to_be_bytes());
    }

    let stride = channels * w;
    let mut raw = Vec::with_capacity(h * (stride + 1));
    for row in 0..h {
        raw.push(0);
        raw.extend_from_slice(&pixels[row * stride..row * stride + stride]);
    }

    let mut zlib = vec![0x78, 0x01];
    let mut offset = 0;
    while offset < raw.len() {
        let block = (raw.len() - offset).min(0xFFFF);
        let last = offset + block >= raw.len();
        zlib.push(if last { 1 } else { 0 });
        zlib.extend_from_slice(&(block as u16).to_le_bytes());
        zlib.extend_from_slice(&(!(block as u16)).to_le_bytes());
        zlib.extend_from_slice(&raw[offset..offset + block]);
        offset += block;
    }
    zlib.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(w as u32).to_be_bytes());
    ihdr.extend_from_slice(&(h as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, color_type, 0, 0, 0]);

    let mut out = vec![137, 80, 78, 71, 13, 10, 26, 10];
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}
