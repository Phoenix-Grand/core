/**
 * Roaming CLIPBOARD HISTORY API (`/api/v1/clipboard`).
 *
 * The browser clipboard holds one item, is not shared between tabs and is lost
 * on reload. This history keeps the recent clips server-side, per user, as the
 * same `KubunoDataEnvelope` the `core.data-card` renderers already understand -
 * so a copy made in the spreadsheet can be pasted from the chat, from another
 * tab, or from another device.
 *
 * The backend owns the rules (dedup by content, 30 unpinned entries kept,
 * 256 KB payload cap): the client only pushes and reads.
 */
import { api } from './client'
import type { KubunoDataEnvelope } from '../registry/DataTransferRegistry'

export interface ClipboardItem {
  id: string
  /** Producing module id ('office', 'maps'…). */
  module: string
  /** Envelope type ('office.shape', 'maps.place'…). */
  kind: string
  title: string | null
  /** Human-readable summary shown in the pane. */
  preview: string | null
  /** The envelope itself - rendered through the producer's data-card renderer. */
  payload: KubunoDataEnvelope
  href: string | null
  /** Pinned entries survive the trim and « Effacer l'historique ». */
  pinned: boolean
  created_at: string
  updated_at: string
}

export const clipboardApi = {
  async list(limit = 30): Promise<ClipboardItem[]> {
    const { data } = await api.get<{ items: ClipboardItem[] }>('/clipboard', { params: { limit } })
    return data.items ?? []
  },

  /**
   * Record a clip. Never throws at the caller: a history that is unavailable
   * (offline, older server) must not break the copy itself, which has already
   * happened on the system clipboard.
   */
  async push(envelope: KubunoDataEnvelope, opts?: { pinned?: boolean }): Promise<ClipboardItem | null> {
    try {
      const { data } = await api.post<{ item: ClipboardItem }>('/clipboard', {
        module: envelope.module,
        kind: envelope.type,
        title: envelope.title ?? null,
        preview: envelope.text ?? null,
        payload: envelope,
        href: envelope.href ?? null,
        pinned: opts?.pinned ?? false,
      })
      return data.item ?? null
    } catch {
      return null
    }
  },

  async setPinned(id: string, pinned: boolean): Promise<void> {
    await api.patch(`/clipboard/${id}`, { pinned })
  },

  async remove(id: string): Promise<void> {
    await api.delete(`/clipboard/${id}`)
  },

  /** Clears everything except the pinned entries. */
  async clear(): Promise<number> {
    const { data } = await api.delete<{ deleted: number }>('/clipboard')
    return data.deleted ?? 0
  },
}
