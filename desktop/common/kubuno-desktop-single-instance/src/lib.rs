//! Single-instance programs for the Kubuno desktop (`desktop/README.md`, "Single instance").
//!
//! A program calls [`acquire`] first thing, with its [`InstanceKey`] and what this launch asked for (an
//! [`Activation`]: the command line and the working directory):
//!
//! - **no other instance holds the key**: [`Outcome::Primary`]. The process runs, keeps the [`Primary`] alive for
//!   its whole life, and calls [`Primary::serve`] once it can act on a request (its window exists): every later
//!   launch's activation is handed to the handler, on a background thread;
//! - **an instance holds it**: the activation is sent to it and [`Outcome::Forwarded`] comes back. The program exits
//!   (code 0) without showing anything; the running instance restores and focuses its window. On Windows the
//!   second process first grants the first one the right to take the foreground (`AllowSetForegroundWindow`),
//!   which is what makes the focus work instead of a blinking taskbar button;
//! - **an instance holds it but does not answer** within the wait (hung, or still starting for too long):
//!   [`Outcome::Unreachable`]; the caller decides (Kubuno Desktop starts anyway rather than show nothing).
//!
//! A crashed instance never blocks the next launch: the lock is an OS object the kernel releases with the process
//! (Windows: a named mutex, *abandoned* when its owner dies; Linux and macOS: `flock` on a lock file, released when
//! the descriptor closes), and the hand-off endpoint is recreated by the next primary (the named pipe disappears
//! with its process; a leftover Unix socket file is removed before binding, under the lock).
//!
//! | | Windows | Linux | macOS |
//! |---|---|---|---|
//! | lock | `Local\kubuno-<app>-<digest>` named mutex, DACL: current user only | `flock` on `<runtime>/kubuno-<app>-<digest>.lock` | same as Linux |
//! | hand-off | `\\.\pipe\kubuno-<app>-<digest>`, DACL: current user only, remote clients rejected | Unix socket `<runtime>/kubuno-<app>-<digest>.sock`, `0600`, peer uid checked | same as Linux |
//! | runtime dir | - | `$XDG_RUNTIME_DIR/kubuno`, else `/tmp/kubuno-<uid>` (`0700`, owner checked) | `$TMPDIR/kubuno` (per user) |
//! | user, session | SID, Terminal Services session id | uid, `XDG_SESSION_ID` | uid |
//!
//! On macOS a bundled app is also activated by the system itself (LaunchServices reopens the running bundle); this
//! crate covers the launches that bypass it (a terminal, a second copy of the bundle, a deep link handled by an
//! helper).
//!
//! The protocol is one JSON line each way: `{"v":1,"app":…,"args":[…],"cwd":…}` then `{"v":1,"ok":true,"pid":…}`
//! (64 KiB at most). It carries no secret: a command line is not one.

mod key;
#[cfg(windows)]
pub mod windows;
#[cfg(windows)]
use windows as sys;
#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;

use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub use key::{document_of_arg, document_of_file, document_of_server, normalize_path, InstanceKey};

/// The protocol version of the hand-off line.
pub const PROTOCOL_VERSION: u32 = 1;
/// The longest line accepted either way.
pub const MAX_LINE: usize = 64 * 1024;
/// How long a second launch waits for the running instance by default.
pub const DEFAULT_WAIT: Duration = Duration::from_secs(5);

/// What a launch asked for, handed to the running instance.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activation {
    /// The arguments, program name excluded.
    pub args: Vec<String>,
    /// The launch's working directory (a relative file argument is relative to it).
    pub cwd: Option<String>,
}

impl Activation {
    /// This process's command line and working directory.
    pub fn from_env() -> Activation {
        Activation {
            args: std::env::args().skip(1).collect(),
            cwd: std::env::current_dir().ok().map(|d| d.to_string_lossy().into_owned()),
        }
    }

    /// Whether `flag` is one of the arguments.
    pub fn has(&self, flag: &str) -> bool {
        self.args.iter().any(|a| a == flag)
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Request {
    v: u32,
    app: String,
    #[serde(flatten)]
    activation: Activation,
}

#[derive(Debug, Serialize, Deserialize)]
struct Reply {
    v: u32,
    ok: bool,
    pid: u32,
}

/// What [`acquire`] found.
#[derive(Debug)]
pub enum Outcome {
    /// This process is the instance: keep the [`Primary`] for the whole life of the process.
    Primary(Primary),
    /// Another instance (process `pid`) got this launch's activation: exit.
    Forwarded { pid: u32 },
    /// Another instance holds the key but did not answer in time.
    Unreachable(io::Error),
}

/// The lock of the running instance and its hand-off endpoint. Dropping it releases the instance (the next launch
/// becomes the instance); a process normally keeps it until it exits.
pub struct Primary {
    key: InstanceKey,
    // Field order matters: the listener stops before the lock is released.
    server: Option<Server>,
    listener: Option<sys::Listener>,
    _lock: sys::Lock,
}

impl std::fmt::Debug for Primary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Primary").field("key", &self.key).field("serving", &self.server.is_some()).finish()
    }
}

struct Server {
    stop: Arc<AtomicBool>,
}

impl Primary {
    /// The key this instance holds.
    pub fn key(&self) -> &InstanceKey {
        &self.key
    }

    /// Whether the hand-off endpoint could be created (it can fail when another process of the same user squats
    /// the name; the instance still holds the lock, later launches then report [`Outcome::Unreachable`]).
    pub fn can_serve(&self) -> bool {
        self.listener.is_some() || self.server.is_some()
    }

    /// Starts answering later launches: `handler` gets each activation on a background thread (post it to the UI
    /// thread; it should return quickly, the second launch waits for the answer). Once only; later calls do
    /// nothing.
    pub fn serve(&mut self, handler: impl Fn(Activation) + Send + Sync + 'static) {
        let Some(mut listener) = self.listener.take() else { return };
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let app = self.key.app().to_string();
        let spawned = std::thread::Builder::new().name(format!("single-instance-{app}")).spawn(move || {
            let handler = Arc::new(handler);
            loop {
                let conn = listener.accept();
                if thread_stop.load(Ordering::SeqCst) {
                    break;
                }
                match conn {
                    Ok(conn) => {
                        if let Err(e) = answer(conn, &app, handler.as_ref()) {
                            tracing::warn!(error = %e, "single instance: a hand-off failed");
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "single instance: the hand-off endpoint failed; later launches will start their own instance");
                        break;
                    }
                }
            }
        });
        match spawned {
            Ok(_) => self.server = Some(Server { stop }),
            Err(e) => tracing::error!(error = %e, "single instance: cannot start the hand-off thread"),
        }
    }
}

impl Drop for Primary {
    fn drop(&mut self) {
        if let Some(server) = self.server.take() {
            server.stop.store(true, Ordering::SeqCst);
            // Wake the thread blocked in `accept` (it sees `stop` and leaves).
            let _ = sys::connect(&self.key, Instant::now() + Duration::from_millis(200));
        }
    }
}

/// Reads one request from `conn`, hands it to `handler` and answers.
fn answer<C: Read + Write>(conn: C, app: &str, handler: &(dyn Fn(Activation) + Send + Sync)) -> io::Result<()> {
    let mut reader = BufReader::new(conn);
    let mut line = Vec::new();
    (&mut reader).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line)?;
    if line.is_empty() {
        return Ok(()); // A wake-up connection, or a launch that gave up.
    }
    if line.len() > MAX_LINE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "hand-off line too long"));
    }
    let request: Request = serde_json::from_slice(&line).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let ok = request.v == PROTOCOL_VERSION && request.app == app;
    if ok {
        tracing::info!(args = ?request.activation.args, cwd = ?request.activation.cwd, "single instance: activation handed over by a second launch");
        handler(request.activation);
    } else {
        tracing::warn!(version = request.v, app = %request.app, "single instance: a hand-off of another program or protocol was ignored");
    }
    let mut conn = reader.into_inner();
    let mut reply = serde_json::to_vec(&Reply { v: PROTOCOL_VERSION, ok, pid: std::process::id() }).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    reply.push(b'\n');
    conn.write_all(&reply)?;
    conn.flush()
}

/// Takes the instance of `key`, or hands `activation` to the instance that holds it (see the crate doc). `wait`
/// bounds how long a second launch waits for the running instance (a primary that is still starting, or one that
/// just died and whose lock the OS is releasing); [`DEFAULT_WAIT`] fits a program's start.
pub fn acquire(key: &InstanceKey, activation: &Activation, wait: Duration) -> io::Result<Outcome> {
    let deadline = Instant::now() + wait;
    loop {
        if let Some(lock) = sys::Lock::try_acquire(key)? {
            let listener = match sys::Listener::bind(key) {
                Ok(l) => Some(l),
                Err(e) => {
                    tracing::warn!(error = %e, "single instance: the hand-off endpoint cannot be created; this instance runs without it");
                    None
                }
            };
            return Ok(Outcome::Primary(Primary { key: key.clone(), server: None, listener, _lock: lock }));
        }
        match forward(key, activation, deadline) {
            Ok(pid) => return Ok(Outcome::Forwarded { pid }),
            Err(e) if Instant::now() >= deadline => return Ok(Outcome::Unreachable(e)),
            Err(e) => tracing::debug!(error = %e, "single instance: the running instance did not answer yet"),
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Sends `activation` to the running instance; its process id on success.
fn forward(key: &InstanceKey, activation: &Activation, deadline: Instant) -> io::Result<u32> {
    let (conn, server_pid) = sys::connect(key, deadline)?;
    sys::allow_foreground(server_pid);
    let request = Request { v: PROTOCOL_VERSION, app: key.app().to_string(), activation: activation.clone() };
    let mut line = serde_json::to_vec(&request).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    line.push(b'\n');
    if line.len() > MAX_LINE {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "command line too long to hand over"));
    }
    // The exchange runs on a helper thread so that a hung instance cannot hang this launch past the deadline.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> io::Result<Reply> {
            let mut conn = conn;
            conn.write_all(&line)?;
            conn.flush()?;
            let mut reader = BufReader::new(conn);
            let mut answer = Vec::new();
            (&mut reader).take(MAX_LINE as u64).read_until(b'\n', &mut answer)?;
            serde_json::from_slice::<Reply>(&answer).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        })();
        let _ = tx.send(result);
    });
    let remaining = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(500));
    match rx.recv_timeout(remaining) {
        Ok(Ok(reply)) if reply.ok => Ok(if reply.pid != 0 { reply.pid } else { server_pid }),
        Ok(Ok(_)) => Err(io::Error::new(io::ErrorKind::InvalidData, "the running instance refused the hand-off")),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "the running instance did not answer")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_line_is_flat_json() {
        let r = Request { v: 1, app: "kubuno-desktop".into(), activation: Activation { args: vec!["--page".into(), "settings".into()], cwd: Some("C:\\".into()) } };
        let text = serde_json::to_string(&r).expect("json");
        assert_eq!(text, r#"{"v":1,"app":"kubuno-desktop","args":["--page","settings"],"cwd":"C:\\"}"#);
        let back: Request = serde_json::from_str(&text).expect("parse");
        assert_eq!(back.activation, r.activation);
        assert!(back.activation.has("--page") && !back.activation.has("--background"));
    }
}
