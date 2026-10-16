/**
 * Roaming clipboard history - imperative entry points, like `openLabelPicker`.
 *
 * `openClipboardPane()` shows the history (rendered once by
 * `<ClipboardPaneHost />` in App.tsx) and resolves with the envelope the user
 * picked, or null if they closed it. A caller that just wants to record a copy
 * uses `pushClipboard(envelope)`, which never throws.
 */
import { create } from 'zustand'
import { clipboardApi, type ClipboardItem } from '../api/clipboard'
import type { KubunoDataEnvelope } from '../registry/DataTransferRegistry'

interface PaneEntry {
  /** Restrict the list to these envelope types (e.g. a module pasting its own). */
  types?: string[]
  resolve: (picked: KubunoDataEnvelope | null) => void
}

interface ClipboardStore {
  current: PaneEntry | null
  /** Bumped after every push, so an open pane refreshes itself. */
  revision: number
  open: (types?: string[]) => Promise<KubunoDataEnvelope | null>
  close: (picked: KubunoDataEnvelope | null) => void
  bump: () => void
}

export const useClipboardStore = create<ClipboardStore>((set, get) => ({
  current: null,
  revision: 0,
  open: types => new Promise<KubunoDataEnvelope | null>(resolve => set({ current: { types, resolve } })),
  close: picked => { get().current?.resolve(picked); set({ current: null }) },
  bump: () => set(s => ({ revision: s.revision + 1 })),
}))

/** Show the history; resolves with the chosen envelope (null = dismissed). */
export const openClipboardPane = (types?: string[]): Promise<KubunoDataEnvelope | null> =>
  useClipboardStore.getState().open(types)

/**
 * Record a clip in the history. Fire-and-forget on purpose: the copy itself has
 * already happened on the system clipboard, so a history failure (offline, older
 * server) must stay invisible to the user.
 */
export function pushClipboard(envelope: KubunoDataEnvelope): Promise<ClipboardItem | null> {
  return clipboardApi.push(envelope).then(item => {
    if (item) useClipboardStore.getState().bump()
    return item
  })
}
