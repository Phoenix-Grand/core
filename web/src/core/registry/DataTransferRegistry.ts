/**
 * Cross-module data sharing over the system clipboard (JSON envelopes).
 *
 * A producer module serializes a piece of its state into a `KubunoDataEnvelope`
 * and calls `copyKubunoData()`. The envelope travels on the clipboard in TWO
 * formats at once:
 *   - `text/plain`: a human-readable summary (pastes cleanly outside Kubuno);
 *   - `text/html`: `<span data-kubuno="<base64 JSON>">…</span>` carrying the
 *     full envelope (survives paste without any clipboard-read permission).
 *
 * A consumer module (chat, notes, mail…) calls `readKubunoData(e.clipboardData)`
 * in its `paste` handler; if an envelope is found it can render it as a rich
 * card. Rendering is decoupled through the `core.data-card` extension point:
 * the PRODUCER registers a React renderer for its own types, so any consumer
 * can display the payload without a hard-coded cross-module reference. When no
 * renderer is installed, consumers should fall back to a generic JSON card.
 */
import type React from 'react'
import { ExtensionRegistry } from './ExtensionRegistry'

export interface KubunoDataEnvelope {
  /** Protocol version of the envelope itself. */
  kubuno: 1
  /** Payload type, namespaced by the producer module: `<module>.<kind>` (e.g. `maps.place`). */
  type: string
  /** Producer module id (e.g. `maps`). */
  module: string
  /** Short human-readable label (card title). */
  title?: string
  /** Plain-text fallback written to `text/plain` alongside the envelope. */
  text?: string
  /** In-app deep link opening the data in the producer module (e.g. `/maps?ll=…`). */
  href?: string
  /** Type-specific JSON payload. */
  data: unknown
}

/** Extension point through which producer modules register their card renderers. */
export const DATA_CARD_EXTENSION = 'core.data-card'

export interface DataCardProps {
  envelope: KubunoDataEnvelope
}

/** Static rendering of an envelope, for consumers that cannot host live React
 *  components (canvas documents, exports, thumbnails). Produced on demand by
 *  the PRODUCER module - the consumer never interprets the payload itself. */
export interface DataCardStaticRender {
  /** Vector markup (preferred: crisp at any scale). */
  svg?: string
  /** Raster fallback as a `data:` URL. */
  dataUrl?: string
  width: number
  height: number
}

export interface DataCardRenderer {
  /** Envelope types this renderer handles (e.g. `['maps.place', 'maps.route']`). */
  types: string[]
  /** Live React card (chat bubbles, previews). Optional: consumers fall back to a generic card. */
  Component?: React.ComponentType<DataCardProps>
  /** On-demand static render of the envelope (canvas/document consumers). */
  renderStatic?: (envelope: KubunoDataEnvelope) => Promise<DataCardStaticRender | null>
}

/* ── base64 helpers (UTF-8 safe, chunked to avoid call-stack limits) ── */

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Builds the `text/html` clipboard flavor embedding the envelope. */
export function kubunoDataToHtml(envelope: KubunoDataEnvelope): string {
  const b64 = encodeBase64Utf8(JSON.stringify(envelope))
  const label = envelope.text ?? envelope.title ?? envelope.type
  return `<span data-kubuno="${b64}">${escapeHtml(label)}</span>`
}

/** Validates an arbitrary parsed value as a `KubunoDataEnvelope`. */
export function isKubunoDataEnvelope(value: unknown): value is KubunoDataEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v.kubuno === 1
    && typeof v.type === 'string' && v.type.includes('.')
    && typeof v.module === 'string' && v.module.length > 0
    && 'data' in v
}

/** Parses a raw string (e.g. pasted plain text) as an envelope, or null. */
export function parseKubunoData(raw: string): KubunoDataEnvelope | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isKubunoDataEnvelope(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Extracts an envelope from a paste/drop `DataTransfer`, if any: first the
 * `data-kubuno` marker in `text/html`, then raw-JSON `text/plain` as a fallback.
 */
export function readKubunoData(dt: DataTransfer | null): KubunoDataEnvelope | null {
  if (!dt) return null
  const html = dt.getData('text/html')
  const match = html ? /data-kubuno="([A-Za-z0-9+/=]+)"/.exec(html) : null
  if (match) {
    try {
      const parsed: unknown = JSON.parse(decodeBase64Utf8(match[1]))
      if (isKubunoDataEnvelope(parsed)) return parsed
    } catch { /* corrupt marker: fall through to plain text */ }
  }
  return parseKubunoData(dt.getData('text/plain') || '')
}

/** `document.execCommand('copy')` path for browsers without the async clipboard API. */
function execCopy(text: string, html: string): boolean {
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault()
    e.clipboardData?.setData('text/plain', text)
    e.clipboardData?.setData('text/html', html)
  }
  document.addEventListener('copy', onCopy, true)
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } finally {
    document.removeEventListener('copy', onCopy, true)
  }
}

/**
 * Writes an envelope to the system clipboard (dual `text/plain` + `text/html`).
 * Resolves to false when every strategy failed (nothing was copied).
 */
export async function copyKubunoData(envelope: KubunoDataEnvelope): Promise<boolean> {
  const text = envelope.text ?? envelope.title ?? JSON.stringify(envelope)
  const html = kubunoDataToHtml(envelope)
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })])
      return true
    } catch { /* permission denied or insecure context: fall back */ }
  }
  return execCopy(text, html)
}

export const DataTransferRegistry = {
  /**
   * Registers a producer module's card renderer. One renderer per module -
   * its `Component` should switch on `envelope.type` when handling several.
   */
  registerRenderer(moduleId: string, renderer: DataCardRenderer): void {
    ExtensionRegistry.register(DATA_CARD_EXTENSION, moduleId, renderer)
  },

  unregisterRenderer(moduleId: string): void {
    ExtensionRegistry.unregister(DATA_CARD_EXTENSION, moduleId)
  },

  /** Full renderer entry for an envelope type, or undefined. */
  resolve(type: string): DataCardRenderer | undefined {
    return ExtensionRegistry.getAll<DataCardRenderer>(DATA_CARD_EXTENSION)
      .find(r => Array.isArray(r.types) && r.types.includes(type))
  },

  /** Renderer component for an envelope type, or undefined (generic fallback). */
  resolveRenderer(type: string): React.ComponentType<DataCardProps> | undefined {
    return DataTransferRegistry.resolve(type)?.Component
  },

  copy: copyKubunoData,
  read: readKubunoData,
  parse: parseKubunoData,
}
