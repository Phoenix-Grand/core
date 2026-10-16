/**
 * Signed download / stream tickets (`POST /api/v1/auth/tickets`).
 *
 * Some requests are made by the browser itself and can never carry the
 * `Authorization` header: `<img src>`, `<video>`/`<audio>` (and their Range
 * requests), `<iframe>` previews, downloads performed as a navigation,
 * `EventSource`, `WebSocket`. Instead of an ambient cookie, such a URL carries a
 * short-lived ticket (`?kt=…`) that the core signs and binds to the account, the
 * session, the module, the exact path and the method. Signing out revokes it.
 *
 *   const src = useSignedUrl(`/api/v1/drive/${id}/thumbnail`)          // <img>
 *   const src = useSignedUrl(url, { purpose: 'stream' })               // <video>
 *   await downloadSignedUrl(`/api/v1/drive/${id}/download`)            // file
 *   const ws  = new WebSocket(await signedSocketUrl('/api/v1/chat/ws')) // socket
 *
 * URLs that need no ticket are returned unchanged: other origins, `blob:` and
 * `data:` URLs, and the public API surface (avatars, themes, share links,
 * public pages…). Requests are batched (one POST per tick, up to 200 URLs) and
 * answers are cached until shortly before they expire; tickets are
 * deterministic within a time bucket, so the browser's HTTP cache keeps
 * working.
 */
import { useEffect, useState } from 'react'
import { api, hasAccessToken } from './client'

export type TicketPurpose = 'view' | 'download' | 'stream' | 'socket'

export interface SignedUrlOptions {
  /** Decides the ticket's lifetime. `view` (default): images, previews.
   *  `download`: a file saved by the browser. `stream`: `<video>`/`<audio>`
   *  (Range requests) and `EventSource`. `socket`: a WebSocket handshake. */
  purpose?: TicketPurpose
  /** Spend the ticket on its first use (downloads only). */
  once?: boolean
}

interface Issued { url: string; expires_at: number }
interface Pending { key: string; path: string; resolve: (v: Issued) => void; reject: (e: unknown) => void }

const MAX_BATCH = 200
/** Re-use a cached ticket only while it has at least this much life left. */
const MARGIN_S: Record<TicketPurpose, number> = { view: 30, download: 30, stream: 120, socket: 20 }

/** Core paths under /api/v1 known to be public: a ticket would be wasted on
 *  them. (Module routes are never guessed: a ticket on a public route is
 *  harmless, a missing one on a private route is a broken image.) */
const PUBLIC_PATH = [
  /^\/api\/v1\/users\/[^/]+\/avatar(\/original)?$/,
  /^\/api\/v1\/themes(\/|$)/,
  /^\/api\/v1\/(config|modules|openapi\.json|docs)$/,
  /^\/api\/v1\/auth\//,
  /^\/api\/v1\/setup\//,
]

const cache = new Map<string, Issued>()
const queues = new Map<string, Pending[]>()
let generation = 0
let warnedUnsupported = false

/** Forget every cached ticket - on sign-out and on account switch, so a URL
 *  minted for one account is never handed to another. */
export function clearSignedUrlCache(): void {
  cache.clear()
  generation++
}

function nowS(): number { return Math.floor(Date.now() / 1000) }

/** Same-origin `path?query` (minus any previous ticket), or null when the URL
 *  needs no ticket. */
function ticketTarget(url: string): string | null {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null
  let u: URL
  try { u = new URL(url, window.location.origin) } catch { return null }
  const sameOrigin = u.origin === window.location.origin
    || (u.protocol.startsWith('ws') && u.host === window.location.host)
  if (!sameOrigin) return null
  const p = u.pathname
  const isApi = p.startsWith('/api/v1/') || p === '/ws' || (p.startsWith('/collab/') && p.endsWith('/sync'))
  if (!isApi || PUBLIC_PATH.some(re => re.test(p))) return null
  u.searchParams.delete('kt')
  const q = u.searchParams.toString()
  return q ? `${p}?${q}` : p
}

function flush(bucket: string): void {
  const items = queues.get(bucket) ?? []
  queues.delete(bucket)
  const [purpose, onceFlag] = bucket.split('|') as [TicketPurpose, string]
  const gen = generation
  for (let i = 0; i < items.length; i += MAX_BATCH) {
    const chunk = items.slice(i, i + MAX_BATCH)
    api.post<{ tickets: Issued[] }>('/auth/tickets', {
      urls: chunk.map(p => p.path),
      method: 'GET',
      purpose,
      once: onceFlag === '1',
    }).then(({ data }) => {
      chunk.forEach((p, n) => {
        const t = data.tickets[n]
        if (!t) { p.reject(new Error('ticket missing')); return }
        if (onceFlag !== '1' && gen === generation) cache.set(p.key, t)
        p.resolve(t)
      })
    }).catch((e: unknown) => {
      // A core without the endpoint (older release): fall back to the bare
      // URL, which its legacy cookie still authenticates.
      const status = (e as { response?: { status?: number } })?.response?.status
      if (status === 404 || status === 405) {
        if (!warnedUnsupported) { warnedUnsupported = true; console.warn('[signedUrl] core has no /auth/tickets; using bare URLs') }
        chunk.forEach(p => p.resolve({ url: p.path, expires_at: nowS() + 3600 }))
        return
      }
      chunk.forEach(p => p.reject(e))
    })
  }
}

function request(path: string, purpose: TicketPurpose, once: boolean): Promise<Issued> {
  // Anonymous page (public form, published app, share link): there is no
  // session to mint a ticket from. Hand the bare URL back, as before - a
  // public route serves it, a private one refuses it either way.
  if (!hasAccessToken()) return Promise.resolve({ url: path, expires_at: nowS() + 60 })
  const key = `${purpose}|${path}`
  if (!once) {
    const hit = cache.get(key)
    if (hit && hit.expires_at - nowS() > MARGIN_S[purpose]) return Promise.resolve(hit)
  }
  return new Promise<Issued>((resolve, reject) => {
    const bucket = `${purpose}|${once ? '1' : '0'}`
    let q = queues.get(bucket)
    if (!q) {
      q = []
      queues.set(bucket, q)
      queueMicrotask(() => flush(bucket))
    }
    q.push({ key, path, resolve, reject })
  })
}

/** Ticketed same-origin URL for `url` (returned unchanged when it needs none). */
export async function signedUrl(url: string, opts: SignedUrlOptions = {}): Promise<string> {
  const path = ticketTarget(url)
  if (!path) return url
  const t = await request(path, opts.purpose ?? 'view', !!opts.once && opts.purpose === 'download')
  return t.url
}

/** Batch form of [`signedUrl`]. */
export function signedUrls(urls: string[], opts: SignedUrlOptions = {}): Promise<string[]> {
  return Promise.all(urls.map(u => signedUrl(u, opts)))
}

/** `ws(s)://host/<path>?kt=…` for a WebSocket on `url` - a path (`/ws`,
 *  `/api/v1/<module>/…`, `/collab/<room>/sync`) or a full same-host `ws(s)://`
 *  URL. A `token=` parameter (the access token older code put there) is
 *  removed. Fetch a new one on every (re)connect: a socket ticket lives one
 *  minute. Other hosts are returned unchanged. */
export async function signedSocketUrl(url: string): Promise<string> {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  let u: URL
  try { u = new URL(url, window.location.origin) } catch { return url }
  if (u.host !== window.location.host) return url
  u.searchParams.delete('token')
  u.searchParams.delete('kt')
  const q = u.searchParams.toString()
  const rel = q ? `${u.pathname}?${q}` : u.pathname
  const target = ticketTarget(rel)
  const signed = target ? (await request(target, 'socket', false)).url : rel
  return `${proto}://${window.location.host}${signed}`
}

/** Starts a browser download of `url` with a one-time ticket. */
export async function downloadSignedUrl(url: string, filename?: string): Promise<void> {
  const href = await signedUrl(url, { purpose: 'download', once: true })
  const a = document.createElement('a')
  a.href = href
  a.rel = 'noopener'
  if (filename !== undefined) a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Opens `url` in a new tab with a ticket. The tab is opened synchronously
 *  (still inside the click) and navigated once the ticket arrives, so popup
 *  blockers do not swallow it. */
export async function openSignedUrl(url: string, opts: SignedUrlOptions = {}): Promise<void> {
  const w = window.open('', '_blank')
  try {
    const href = await signedUrl(url, { purpose: opts.purpose ?? 'view', once: opts.once })
    if (w) { w.opener = null; w.location.href = href } else window.open(href, '_blank', 'noopener')
  } catch (e) {
    w?.close()
    throw e
  }
}

/**
 * React hook: the ticketed form of `url`, `undefined` while it is being
 * fetched (render a placeholder rather than an `<img>` with a bare URL).
 * Re-issued before expiry while mounted (except for `stream`, where swapping
 * the `src` would restart playback - a stream ticket lives for hours).
 */
export function useSignedUrl(url: string | null | undefined, opts: SignedUrlOptions = {}): string | undefined {
  const purpose = opts.purpose ?? 'view'
  const once = !!opts.once
  const passThrough = !url || ticketTarget(url) === null
  const [state, setState] = useState<{ src: string; url: string } | undefined>(undefined)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!url || passThrough) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const path = ticketTarget(url)
    if (!path) return
    request(path, purpose, once && purpose === 'download').then(t => {
      if (!alive) return
      setState({ src: t.url, url })
      if (purpose !== 'stream' && purpose !== 'socket') {
        const delay = Math.max(5, t.expires_at - nowS() - MARGIN_S[purpose]) * 1000
        timer = setTimeout(() => setTick(n => n + 1), delay)
      }
    }).catch(() => { if (alive) setState(undefined) })
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [url, purpose, once, passThrough, tick])

  if (!url) return undefined
  if (passThrough) return url
  return state && state.url === url ? state.src : undefined
}
