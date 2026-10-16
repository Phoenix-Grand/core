//! GENERIC real-time collaboration service (Yjs) of the core.
//!
//! Any module that edits a kubuno file (.kb***) can open a collaborative
//! session by connecting its `Y.Doc` to the `/collab/:room/sync` WebSocket.
//! The core does NOT understand the Yjs structure: it relays opaque binary
//! updates (concatenable) between the clients of the same `room` and persists
//! them (update journal + consolidated snapshot) so that late joiners can
//! resynchronize. The visible `.kb***` file is still written by the clients
//! (application JSON snapshot) - here we only keep the transient CRDT state.
//!
//! Auth: JWT via `?token=` (browsers cannot set headers on a WebSocket
//! upgrade). Any authenticated user can join a room (the module controls who
//! obtains the entity identifier; a per-room ACL may be added later).

use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicU64, Ordering},
    sync::Arc,
    sync::OnceLock,
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    response::IntoResponse,
    Json,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{broadcast, Mutex, RwLock};
use uuid::Uuid;
use yrs::{
    encoding::read::Cursor,
    updates::decoder::{Decode, DecoderV1},
    Doc, ReadTxn, StateVector, Transact, Update,
};

use kubuno_db::dialect::Assign;
use kubuno_db::{new_id, params, DbPool, DbQueryBuilder};

use crate::{auth::middleware::InternalRequest, errors::AppError, state::AppState};

/// Beyond this number of journaled updates, the room is consolidated (GC).
const CONSOLIDATE_THRESHOLD: i64 = 30;
/// …or beyond this cumulative journal size (a single image insert is enough to trigger it).
const CONSOLIDATE_BYTES: i64 = 512 * 1024;

/// Rooms with a consolidation already in progress: avoids concurrent
/// consolidations (read/delete race) and task pile-up on a single room.
static CONSOLIDATING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
fn consolidating() -> &'static Mutex<HashSet<String>> {
    CONSOLIDATING.get_or_init(|| Mutex::new(HashSet::new()))
}

// ── Yjs merge with garbage collection (GC) ────────────────────────────────────

/// Applies a possibly CONCATENATED Yjs update blob (legacy format where the
/// core stacked updates by plain binary concatenation). We loop a streaming
/// decoder until the buffer is exhausted; a truncated/unreadable update
/// cleanly stops the processing of this blob without panicking.
fn apply_concat(doc: &Doc, blob: &[u8]) {
    if blob.is_empty() {
        return;
    }
    let mut dec = DecoderV1::new(Cursor::new(blob));
    // Loop until the end of the buffer; a truncated/corrupted update breaks out cleanly.
    while let Ok(update) = Update::decode(&mut dec) {
        if doc.transact_mut().apply_update(update).is_err() {
            break;
        }
    }
}

/// Merges a snapshot + a list of updates into a single **compact** Yjs state:
/// the yrs `Doc` has GC enabled by default, so deleted/replaced contents
/// (old images, tombstones) AND redundant state dumps (re-`encodeState`
/// sent on every client reconnection) are eliminated. Pure CPU function, no I/O.
fn merge_gc(snapshot: Option<Vec<u8>>, updates: Vec<Vec<u8>>) -> Vec<u8> {
    let doc = Doc::new(); // GC enabled (skip_gc = false by default)
    if let Some(s) = snapshot {
        apply_concat(&doc, &s);
    }
    for u in &updates {
        apply_concat(&doc, u);
    }
    let txn = doc.transact();
    txn.encode_state_as_update_v1(&StateVector::default())
}

// ── Persistence (consolidated snapshot + update journal) ──────────────────────

pub struct CollabStore;

impl CollabStore {
    /// Yjs state of a room: consolidated snapshot followed by incremental updates.
    pub async fn load(db: &DbPool, room: &str) -> Result<Vec<Vec<u8>>, sqlx::Error> {
        let mut parts: Vec<Vec<u8>> = Vec::new();
        let snap: Option<(Vec<u8>,)> = db
            .fetch_optional_as::<(Vec<u8>,)>(
                "SELECT snapshot FROM core.collab_snapshots WHERE room = $1",
                params![room],
            )
            .await?;
        if let Some((s,)) = snap {
            if !s.is_empty() {
                parts.push(s);
            }
        }
        let updates: Vec<(Vec<u8>,)> = db
            .fetch_all_as::<(Vec<u8>,)>(
                "SELECT update_data FROM core.collab_updates WHERE room = $1 ORDER BY created_at ASC",
                params![room],
            )
            .await?;
        parts.extend(updates.into_iter().map(|(d,)| d));
        Ok(parts)
    }

    /// Persists an incremental update; triggers a background consolidation
    /// beyond the threshold (count OR cumulative journal size). Saving stays
    /// fast: the CPU merge work is never on the hot path.
    pub async fn save(db: &DbPool, room: &str, data: &[u8], origin: Uuid) -> Result<(), sqlx::Error> {
        // The id is generated in Rust (no DB-side UUID default on MySQL/SQLite).
        db.execute(
            "INSERT INTO core.collab_updates (id, room, update_data, origin) VALUES ($1, $2, $3, $4)",
            params![new_id(), room, data, origin],
        )
        .await?;
        // NOTE (multi-DBMS): `octet_length()` is PostgreSQL/MySQL only (SQLite
        // spells it `length()` on a BLOB); kept verbatim and flagged. COUNT/SUM go
        // through the backend so they decode as i64 on every engine.
        let backend = db.backend();
        let (count, bytes): (i64, i64) = db
            .fetch_one_as::<(i64, i64)>(
                &format!(
                    "SELECT {}, {} FROM core.collab_updates WHERE room = $1",
                    backend.count_bigint("*"),
                    backend.sum_bigint("octet_length(update_data)"),
                ),
                params![room],
            )
            .await?;
        if count >= CONSOLIDATE_THRESHOLD || bytes >= CONSOLIDATE_BYTES {
            Self::spawn_consolidate(db.clone(), room.to_string());
        }
        Ok(())
    }

    /// Launches a background consolidation, at most one per room at a time.
    fn spawn_consolidate(db: DbPool, room: String) {
        tokio::spawn(async move {
            {
                let mut set = consolidating().lock().await;
                if !set.insert(room.clone()) {
                    return; // already in progress for this room
                }
            }
            if let Err(e) = Self::consolidate(&db, &room, false).await {
                tracing::error!(error = %e, room = %room, "collab: consolidation");
            }
            consolidating().lock().await.remove(&room);
        });
    }

    /// Merges snapshot + updates through a `Y.Doc` (yrs) with GC: produces a compact
    /// snapshot (deleted contents and redundant state dumps eliminated), then purges
    /// the consolidated updates. Deletion is limited to the `id`s actually read:
    /// an update that arrived during the merge survives (applied on the next pass).
    ///
    /// `force = true` recompacts even without a new update - used to migrate the
    /// old concatenated snapshots (which have no pending journal).
    pub async fn consolidate(db: &DbPool, room: &str, force: bool) -> Result<(), sqlx::Error> {
        let rows: Vec<(Uuid, Vec<u8>)> = db
            .fetch_all_as::<(Uuid, Vec<u8>)>(
                "SELECT id, update_data FROM core.collab_updates WHERE room = $1 ORDER BY created_at ASC",
                params![room],
            )
            .await?;
        if rows.is_empty() && !force {
            return Ok(());
        }

        let snap: Option<(Vec<u8>,)> = db
            .fetch_optional_as::<(Vec<u8>,)>(
                "SELECT snapshot FROM core.collab_snapshots WHERE room = $1",
                params![room],
            )
            .await?;
        let snap_bytes = snap.map(|(s,)| s);
        let had_snapshot = snap_bytes.is_some();
        let prev_len = snap_bytes.as_ref().map(Vec::len).unwrap_or(0);

        let ids: Vec<Uuid> = rows.iter().map(|(id, _)| *id).collect();
        let update_data: Vec<Vec<u8>> = rows.into_iter().map(|(_, d)| d).collect();

        // Yjs decode/re-encode: CPU work isolated from the async runtime.
        let merged = tokio::task::spawn_blocking(move || merge_gc(snap_bytes, update_data))
            .await
            .map_err(|e| sqlx::Error::Protocol(format!("consolidation interrompue: {e}")))?;

        // Nothing to write / nothing to gain: no new update and snapshot already compact.
        if ids.is_empty() && (!had_snapshot || merged.len() >= prev_len) {
            return Ok(());
        }

        let backend = db.backend();
        let mut tx = db.begin().await?;
        // `NOW()` bound from Rust; the upsert clause goes through the backend.
        let now = chrono::Utc::now();
        let conflict = backend.upsert(
            "core.collab_snapshots",
            &["room"],
            &[Assign::Incoming("snapshot"), Assign::Incoming("updated_at")],
        );
        let snapshot_sql = format!(
            "INSERT INTO core.collab_snapshots (room, snapshot, updated_at) VALUES ($1, $2, $3){conflict}"
        );
        tx.execute(&snapshot_sql, params![room, merged.clone(), now]).await?;
        if !ids.is_empty() {
            // `= ANY($2)` over an array becomes a portable `IN (...)` list.
            let mut qb =
                DbQueryBuilder::new(backend, "DELETE FROM core.collab_updates WHERE room = ");
            qb.push_bind(room);
            qb.push(" AND id");
            qb.push_in(ids.iter().copied());
            qb.tx_execute(&mut tx).await?;
        }
        tx.commit().await?;

        if prev_len > 0 && merged.len() < prev_len {
            tracing::info!(
                room = %room,
                avant_octets = prev_len,
                apres_octets = merged.len(),
                updates = ids.len(),
                "collab: snapshot recompacté (GC)"
            );
        }
        Ok(())
    }
}

impl CollabStore {
    /// Drops every persisted trace of a room (snapshot and update journal), in
    /// one transaction. Waits for a consolidation of that room in progress so it
    /// cannot write its snapshot back right after the purge.
    pub async fn purge(db: &DbPool, room: &str) -> Result<(), sqlx::Error> {
        let mut waited = Duration::ZERO;
        loop {
            if consolidating().lock().await.insert(room.to_string()) {
                break;
            }
            if waited >= Duration::from_secs(10) {
                // Give up waiting rather than block the caller forever; the
                // delayed second pass (see `close_room`) catches a late snapshot.
                tracing::warn!(room = %room, "collab: purge while a consolidation still runs");
                return Self::purge_rows(db, room).await;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            waited += Duration::from_millis(50);
        }
        let result = Self::purge_rows(db, room).await;
        consolidating().lock().await.remove(room);
        result
    }

    async fn purge_rows(db: &DbPool, room: &str) -> Result<(), sqlx::Error> {
        let mut tx = db.begin().await?;
        tx.execute("DELETE FROM core.collab_updates WHERE room = $1", params![room]).await?;
        tx.execute("DELETE FROM core.collab_snapshots WHERE room = $1", params![room]).await?;
        tx.commit().await
    }
}

/// One-time migration at startup: recompacts (GC) all existing collab snapshots
/// to eliminate the bloat inherited from the old concatenation (redundant state
/// dumps, deleted contents never collected). Sequential - a single `Y.Doc` in
/// memory at a time - and idempotent (can be re-run harmlessly).
pub async fn recompact_all(db: DbPool) {
    let rooms: Vec<(String,)> = match db
        .fetch_all_as::<(String,)>(
            "SELECT room FROM core.collab_snapshots \
         UNION SELECT DISTINCT room FROM core.collab_updates",
            params![],
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "collab: recompactage (liste des rooms)");
            return;
        }
    };
    if rooms.is_empty() {
        return;
    }
    tracing::info!(rooms = rooms.len(), "collab: recompactage GC des snapshots au démarrage…");
    for (room,) in rooms {
        {
            let mut set = consolidating().lock().await;
            if !set.insert(room.clone()) {
                continue;
            }
        }
        if let Err(e) = CollabStore::consolidate(&db, &room, true).await {
            tracing::error!(error = %e, room = %room, "collab: recompactage");
        }
        consolidating().lock().await.remove(&room);
    }
    tracing::info!("collab: recompactage GC terminé");
}

// ── Broadcast hub (room → subscribers) ────────────────────────────────────────

/// Relayed frame: binary Yjs update or text awareness message (cursors).
#[derive(Clone, Debug, PartialEq)]
enum Frame {
    Bin(Vec<u8>),
    Txt(String),
    /// The owning module replaced the content behind the room: every client is
    /// told to reload and its socket is closed (see [`close_room`]).
    Replaced,
}

/// How long a closed room stays refused in memory. The owning module's own
/// authorization refuses it for good; this covers the window before a client
/// even asks, and modules that do not check.
const CLOSED_ROOM_TTL: Duration = Duration::from_secs(15 * 60);

/// Text frame telling a client its room was closed because the content was replaced.
const REPLACED_MESSAGE: &str = "{\"type\":\"replaced\"}";

#[derive(Clone)]
struct CollabHub {
    rooms: Arc<RwLock<HashMap<String, broadcast::Sender<Frame>>>>,
    /// Rooms closed by their module, with the time of closing.
    closed: Arc<Mutex<HashMap<String, Instant>>>,
    /// Rooms announced as EMPTY to one connection, which is then the only one
    /// allowed to seed them: several clients joining an empty room at once (they
    /// all reload together after a replacement) would otherwise each insert the
    /// stored content, and the CRDT keeps every copy.
    seeders: Arc<Mutex<HashMap<String, u64>>>,
}

impl CollabHub {
    fn new() -> Self {
        CollabHub {
            rooms: Arc::new(RwLock::new(HashMap::new())),
            closed: Arc::new(Mutex::new(HashMap::new())),
            seeders: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Marks `room` closed, then tells every connected client.
    async fn close(&self, room: &str) {
        {
            let mut closed = self.closed.lock().await;
            let now = Instant::now();
            closed.retain(|_, at| now.duration_since(*at) < CLOSED_ROOM_TTL);
            closed.insert(room.to_string(), now);
        }
        self.seeders.lock().await.remove(room);
        self.broadcast(room, Frame::Replaced).await;
    }

    async fn is_closed(&self, room: &str) -> bool {
        self.closed
            .lock()
            .await
            .get(room)
            .map(|at| at.elapsed() < CLOSED_ROOM_TTL)
            .unwrap_or(false)
    }

    /// The connection `conn` found the room empty: may it seed it?
    async fn claim_seed(&self, room: &str, conn: u64) -> bool {
        let mut seeders = self.seeders.lock().await;
        match seeders.get(room) {
            Some(holder) => *holder == conn,
            None => {
                seeders.insert(room.to_string(), conn);
                true
            }
        }
    }

    /// The room has state now, or its seeder left: the claim is over.
    async fn release_seed(&self, room: &str, conn: Option<u64>) {
        let mut seeders = self.seeders.lock().await;
        if conn.is_none() || seeders.get(room) == conn.as_ref() {
            seeders.remove(room);
        }
    }
    async fn subscribe(&self, room: &str) -> broadcast::Receiver<Frame> {
        {
            let r = self.rooms.read().await;
            if let Some(tx) = r.get(room) {
                return tx.subscribe();
            }
        }
        let mut w = self.rooms.write().await;
        let tx = w.entry(room.to_string()).or_insert_with(|| broadcast::channel(512).0);
        tx.subscribe()
    }
    async fn broadcast(&self, room: &str, frame: Frame) {
        let r = self.rooms.read().await;
        if let Some(tx) = r.get(room) {
            let _ = tx.send(frame);
        }
    }
}

static HUB: OnceLock<CollabHub> = OnceLock::new();
fn hub() -> &'static CollabHub {
    HUB.get_or_init(CollabHub::new)
}

// ── WebSocket handler ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CollabQuery {
    /// Socket ticket bound to this room's path - web.
    #[serde(default)]
    pub kt: Option<String>,
    /// Access token - native clients.
    #[serde(default)]
    pub token: Option<String>,
}

pub async fn collab_handler(
    State(state): State<AppState>,
    Path(room): Path<String>,
    Query(query): Query<CollabQuery>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, AppError> {
    let user_id = crate::auth::tickets::socket_user(
        &state,
        query.kt.as_deref(),
        query.token.as_deref(),
        uri.path(),
    )
    .await?;

    // Generic ACL: the module owning the room can refuse access.
    if !authorize_room(&state, &room, user_id).await {
        return Err(AppError::Forbidden);
    }

    Ok(ws.on_upgrade(move |socket| handle(socket, state, room, user_id)))
}

/// Asks the module owning a room whether it allows `user_id` to join it.
///
/// The room has the form `<module_id>-<entity>:<uuid>` or `<module_id>:<uuid>`.
/// The module is resolved through the registry (longest prefix), then its internal
/// endpoint `POST /internal/collab/authorize` is called. **Fail-open**: only an
/// explicit `403` denies access; a module without this endpoint (404), a network
/// error or an unknown module let the user through (backward compatibility, robustness).
async fn authorize_room(state: &AppState, room: &str, user_id: Uuid) -> bool {
    // Resolve the owning module (longest id that prefixes the room).
    let (module_id, base_url) = {
        let registry = state.modules.read().await;
        let mut best: Option<(usize, String, String)> = None;
        for inst in registry.all() {
            let id = &inst.module_id;
            let matches = room == id
                || room.starts_with(&format!("{id}-"))
                || room.starts_with(&format!("{id}:"));
            if matches && best.as_ref().map(|(len, _, _)| id.len() > *len).unwrap_or(true) {
                best = Some((
                    id.len(),
                    id.clone(),
                    inst.base_url.trim_end_matches('/').to_owned(),
                ));
            }
        }
        match best {
            Some((_, id, url)) => (id, url),
            None => return true, // no module → core-internal room, let it through
        }
    };

    let url = format!("{base_url}/internal/collab/authorize");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        // Internal secret of the target module (it compares it with its own value).
        .header("X-Internal-Secret", state.settings.server.module_secret(&module_id))
        .json(&serde_json::json!({ "room": room, "user_id": user_id }))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;

    match resp {
        Ok(r) if r.status() == reqwest::StatusCode::FORBIDDEN => {
            tracing::info!(room = %room, %user_id, "collab: accès refusé par le module");
            false
        }
        Ok(_) => true,
        Err(e) => {
            tracing::warn!(error = %e, room = %room, "collab: autorisation injoignable (fail-open)");
            true
        }
    }
}

fn next_conn_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

async fn handle(socket: WebSocket, state: AppState, room: String, user_id: Uuid) {
    let conn = next_conn_id();
    let mut rx = hub().subscribe(&room).await;
    let (mut sender, mut receiver) = socket.split();

    // A room closed by its module (content replaced behind it): the client is
    // told to reload instead of being handed the abandoned state.
    if hub().is_closed(&room).await {
        let _ = sender.send(Message::Text(REPLACED_MESSAGE.to_string())).await;
        let _ = sender.send(Message::Close(None)).await;
        return;
    }

    // Initial sync: persisted snapshot + updates. We first announce whether the room
    // is EMPTY (no state) → the client then knows it can "seed" the Y.Doc
    // from the existing JSON content. Only ONE connection is told so at a time
    // (see `CollabHub::seeders`); the others receive the seed through the room.
    match CollabStore::load(&state.db, &room).await {
        Ok(parts) => {
            let empty = parts.is_empty() && hub().claim_seed(&room, conn).await;
            let init = format!("{{\"type\":\"sync\",\"empty\":{empty}}}");
            if sender.send(Message::Text(init)).await.is_err() { return; }
            for part in parts {
                if sender.send(Message::Binary(part)).await.is_err() {
                    return;
                }
            }
        }
        Err(e) => {
            tracing::error!(error = %e, room = %room, "collab: chargement");
            return;
        }
    }

    loop {
        tokio::select! {
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        // An update racing the closing of the room is dropped: it
                        // carries the abandoned state.
                        if hub().is_closed(&room).await {
                            let _ = sender.send(Message::Text(REPLACED_MESSAGE.to_string())).await;
                            break;
                        }
                        let data = data.to_vec();
                        if let Err(e) = CollabStore::save(&state.db, &room, &data, user_id).await {
                            tracing::error!(error = %e, room = %room, "collab: save");
                        }
                        hub().release_seed(&room, None).await;
                        hub().broadcast(&room, Frame::Bin(data)).await;
                    }
                    Some(Ok(Message::Text(txt))) => {
                        // Awareness (cursors/presence): relayed as is, not persisted.
                        hub().broadcast(&room, Frame::Txt(txt.to_string())).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            Ok(frame) = rx.recv() => {
                let out = match frame {
                    Frame::Bin(d) => Message::Binary(d),
                    Frame::Txt(t) => Message::Text(t),
                    Frame::Replaced => {
                        let _ = sender.send(Message::Text(REPLACED_MESSAGE.to_string())).await;
                        let _ = sender.send(Message::Close(None)).await;
                        break;
                    }
                };
                if sender.send(out).await.is_err() {
                    break;
                }
            }
        }
    }
    hub().release_seed(&room, Some(conn)).await;
}

// ── Closing a room (internal, called by the owning module) ────────────────────

#[derive(Deserialize)]
pub struct CloseRoomDto {
    pub room: String,
}

/// Longest room name accepted by [`close_room`].
const MAX_ROOM_LEN: usize = 512;

/// May `caller` (a module id; `None` = master secret) close `room`? A module
/// only closes its own rooms: `<id>`, `<id>-…` or `<id>:…`.
fn may_close(caller: Option<&str>, room: &str) -> bool {
    match caller {
        None => true,
        Some(id) => {
            !id.is_empty()
                && (room == id
                    || room.strip_prefix(id).is_some_and(|rest| rest.starts_with('-') || rest.starts_with(':')))
        }
    }
}

/// `POST /internal/collab/rooms/close` - the owning module replaced the content
/// behind `room` (a REST save from a client outside the room). The room is
/// closed: connected clients are told to reload and disconnected, later joins
/// and stray updates are refused, and its persisted state is dropped so it can
/// never be served again.
pub async fn close_room(
    State(state): State<AppState>,
    internal: InternalRequest,
    Json(dto): Json<CloseRoomDto>,
) -> Result<Json<serde_json::Value>, AppError> {
    let room = dto.room.trim();
    if room.is_empty() || room.len() > MAX_ROOM_LEN || room.chars().any(char::is_control) {
        return Err(AppError::Validation("room invalide".into()));
    }
    if !may_close(internal.module_id(), room) {
        tracing::warn!(caller = %internal.0.label(), room = %room, "collab: room close refused (not the owner)");
        return Err(AppError::Forbidden);
    }

    hub().close(room).await;
    if let Err(e) = CollabStore::purge(&state.db, room).await {
        tracing::error!(error = %e, room = %room, "collab: purge of a closed room");
        return Err(AppError::from(e));
    }
    // Second pass once the sockets are gone: an update read just before the
    // closing may still have been written after the first purge.
    let db = state.db.clone();
    let late = room.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if let Err(e) = CollabStore::purge(&db, &late).await {
            tracing::error!(error = %e, room = %late, "collab: second purge of a closed room");
        }
    });
    tracing::info!(caller = %internal.0.label(), room = %room, "collab: room closed (content replaced)");
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_module_closes_only_its_own_rooms() {
        assert!(may_close(Some("office"), "office-document:0b6f2f2e-6d3c-4c51-9a55-1f3b8f4f7e10"));
        assert!(may_close(Some("office"), "office:0b6f2f2e"));
        assert!(may_close(Some("office"), "office"));
        assert!(!may_close(Some("office"), "officer-document:x"));
        assert!(!may_close(Some("notes"), "office-document:x"));
        assert!(!may_close(Some(""), "office-document:x"));
        assert!(may_close(None, "office-document:x"), "the master secret is not tied to a module");
    }

    #[tokio::test]
    async fn closing_a_room_notifies_its_clients_and_refuses_it() {
        let hub = CollabHub::new();
        let mut a = hub.subscribe("office-document:a").await;
        let mut other = hub.subscribe("office-document:b").await;

        hub.broadcast("office-document:a", Frame::Bin(vec![1, 2])).await;
        hub.close("office-document:a").await;

        assert_eq!(a.recv().await.expect("update"), Frame::Bin(vec![1, 2]));
        assert_eq!(a.recv().await.expect("replaced"), Frame::Replaced);
        assert!(hub.is_closed("office-document:a").await);
        assert!(!hub.is_closed("office-document:b").await);
        assert!(other.try_recv().is_err(), "another room hears nothing");
    }

    #[tokio::test]
    async fn closed_rooms_expire_from_memory() {
        let hub = CollabHub::new();
        hub.closed
            .lock()
            .await
            .insert("old".into(), Instant::now() - CLOSED_ROOM_TTL - Duration::from_secs(1));
        assert!(!hub.is_closed("old").await);
        hub.close("new").await;
        assert!(!hub.closed.lock().await.contains_key("old"), "expired entries are pruned");
    }

    #[tokio::test]
    async fn only_one_connection_seeds_an_empty_room() {
        let hub = CollabHub::new();
        assert!(hub.claim_seed("r", 1).await);
        assert!(!hub.claim_seed("r", 2).await, "a second joiner must not seed too");
        assert!(hub.claim_seed("r", 1).await, "the holder keeps its claim");
        // Another connection leaving does not release the claim…
        hub.release_seed("r", Some(2)).await;
        assert!(!hub.claim_seed("r", 3).await);
        // …the holder leaving without seeding does.
        hub.release_seed("r", Some(1)).await;
        assert!(hub.claim_seed("r", 3).await);
        // Once the room holds state, the claim is over for everyone.
        hub.release_seed("r", None).await;
        assert!(hub.claim_seed("r", 4).await);
    }

    #[tokio::test]
    async fn closing_a_room_cancels_its_seed_claim() {
        let hub = CollabHub::new();
        assert!(hub.claim_seed("r", 1).await);
        hub.close("r").await;
        assert!(hub.seeders.lock().await.is_empty());
    }
}
