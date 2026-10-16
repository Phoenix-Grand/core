/**
 * Global label picker, imperative like `prompt()`: any module calls
 * `openLabelPicker(envelope)` (directly or through the `core` module service)
 * to attach/detach cross-module labels on the element the envelope describes.
 * The dialog itself is rendered once by `<LabelPickerHost />` in App.tsx.
 */
import { create } from 'zustand'
import type { KubunoDataEnvelope } from '../registry/DataTransferRegistry'

interface PickerEntry {
  envelope: KubunoDataEnvelope
  resourceId: string
  resolve: (changed: boolean) => void
}

interface LabelPickerStore {
  current: PickerEntry | null
  open:  (envelope: KubunoDataEnvelope) => Promise<boolean>
  close: (changed: boolean) => void
}

/** djb2 - stable key for id-less payloads (e.g. a bare maps point). */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/**
 * Stable identity of the element an envelope describes: its module id when the
 * payload carries one, otherwise a content hash. Everything that produces the
 * same key is considered the same element by the label system.
 */
export function resourceKeyOf(envelope: KubunoDataEnvelope): string {
  const d = envelope.data as Record<string, unknown> | null
  const id = d && (d.id ?? d.event_id ?? d.formula_id)
  if (typeof id === 'string' && id) return id
  return `h_${hash(JSON.stringify(envelope.data ?? envelope.title ?? ''))}`
}

export const useLabelPickerStore = create<LabelPickerStore>((set, get) => ({
  current: null,
  open: (envelope) =>
    new Promise<boolean>((resolve) =>
      set({ current: { envelope, resourceId: resourceKeyOf(envelope), resolve } })),
  close: (changed) => { get().current?.resolve(changed); set({ current: null }) },
}))

/** Imperative entry point (also published as a `core` module service). */
export const openLabelPicker = (envelope: KubunoDataEnvelope): Promise<boolean> =>
  useLabelPickerStore.getState().open(envelope)
