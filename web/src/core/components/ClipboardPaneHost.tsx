/**
 * The CLIPBOARD PANE - Kubuno's equivalent of Office's clipboard task pane and
 * of Windows 11's clipboard history (Win+V).
 *
 * Mounted once in App.tsx; opens when `openClipboardPane()` is called from
 * anywhere (core page or module, through the `core` service). It lists the
 * user's recent clips - rendered by the PRODUCER's `core.data-card` renderer,
 * so a copied map shows a map and a copied shape shows a shape - and lets them:
 *
 *   • paste one back: the entry is written to the system clipboard in the same
 *     dual text/plain + text/html format as a fresh copy, AND returned to the
 *     caller, so a module can insert it directly instead of relying on Ctrl+V;
 *   • pin an entry (survives the trim and « Effacer l'historique »);
 *   • delete one entry, or clear the history.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardList, Pin, PinOff, Trash2, X, Loader2, ClipboardPaste, Package } from 'lucide-react'
import { useClipboardStore } from '../store/clipboardStore'
import { clipboardApi, type ClipboardItem } from '../api/clipboard'
import { copyKubunoData } from '../registry/DataTransferRegistry'
import { DataCardView } from '../registry/DataCardView'

/** "il y a 3 min" - the pane's only timestamp, kept deliberately coarse. */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'à l’instant'
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`
  return `il y a ${Math.floor(s / 86400)} j`
}

/**
 * Global shortcut, Windows' Win+V transposed: Ctrl/Cmd + Shift + V opens the
 * pane from anywhere. Declared here because this host is always mounted, and
 * ignored while the user is typing (a text field owns its own paste).
 */
function useClipboardShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== 'v') return
      const t = e.target as HTMLElement | null
      if (t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable)) return
      e.preventDefault()
      open()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
}

export default function ClipboardPaneHost() {
  const current = useClipboardStore(s => s.current)
  const revision = useClipboardStore(s => s.revision)
  const close = useClipboardStore(s => s.close)
  const [items, setItems] = useState<ClipboardItem[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const openPane = useClipboardStore(s => s.open)
  useClipboardShortcut(useCallback(() => { void openPane() }, [openPane]))

  // Escape closes it, like every other overlay of the shell.
  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(null) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, close])

  const reload = useCallback(() => {
    setLoading(true)
    clipboardApi.list()
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { if (current) reload() }, [current, revision, reload])

  // The types filter lets a module ask for what it can actually paste.
  const shown = useMemo(() => {
    const types = current?.types
    return types?.length ? items.filter(i => types.includes(i.kind)) : items
  }, [items, current])

  if (!current) return null

  const paste = async (item: ClipboardItem) => {
    setBusy(item.id)
    // Put it back on the system clipboard too, so a plain Ctrl+V works next.
    await copyKubunoData(item.payload)
    setBusy(null)
    close(item.payload)
  }

  const togglePin = async (item: ClipboardItem) => {
    setBusy(item.id)
    try { await clipboardApi.setPinned(item.id, !item.pinned); reload() }
    finally { setBusy(null) }
  }

  const remove = async (item: ClipboardItem) => {
    setBusy(item.id)
    try { await clipboardApi.remove(item.id); reload() }
    finally { setBusy(null) }
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center" onClick={() => close(null)}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative bg-surface-0 rounded-2xl shadow-xl w-full max-w-md flex flex-col max-h-[75vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-2.5 px-5 pt-4 pb-2">
          <ClipboardList size={18} className="text-primary mt-0.5 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-text-primary">Presse-papiers</h3>
            <p className="text-xs text-text-tertiary">
              {shown.length ? `${shown.length} élément${shown.length > 1 ? 's' : ''}` : 'Historique de vos copies'}
            </p>
          </div>
          <button onClick={() => close(null)} className="p-1 rounded-full text-text-tertiary hover:bg-surface-2">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-2">
          {loading && (
            <div className="flex items-center justify-center py-8 text-text-tertiary">
              <Loader2 size={18} className="animate-spin" />
            </div>
          )}
          {!loading && !shown.length && (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Package size={22} className="text-text-tertiary" />
              <p className="text-xs text-text-secondary">Rien pour l’instant.</p>
              <p className="text-[11px] text-text-tertiary max-w-[16rem]">
                Les éléments copiés depuis un module de Kubuno apparaissent ici, sur tous vos onglets et appareils.
              </p>
            </div>
          )}
          {!loading && shown.map(item => (
            <div key={item.id} className="mb-1.5 rounded-xl border border-border overflow-hidden">
              <div className="flex items-start gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-text-primary truncate">
                    {item.title || item.kind}
                  </p>
                  <p className="text-[11px] text-text-tertiary truncate">
                    {item.module} · {ago(item.created_at)}
                  </p>
                  {item.preview && (
                    <p className="mt-1 text-[11px] text-text-secondary line-clamp-2 whitespace-pre-wrap break-words">
                      {item.preview}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <button
                    onClick={() => paste(item)}
                    disabled={busy === item.id}
                    title="Coller"
                    className="p-1.5 rounded-lg text-text-secondary hover:bg-surface-2 hover:text-primary"
                  >
                    {busy === item.id ? <Loader2 size={14} className="animate-spin" /> : <ClipboardPaste size={14} />}
                  </button>
                  <button
                    onClick={() => togglePin(item)}
                    title={item.pinned ? 'Désépingler' : 'Épingler'}
                    className={`p-1.5 rounded-lg hover:bg-surface-2 ${item.pinned ? 'text-primary' : 'text-text-tertiary hover:text-text-secondary'}`}
                  >
                    {item.pinned ? <Pin size={14} /> : <PinOff size={14} />}
                  </button>
                  <button
                    onClick={() => remove(item)}
                    title="Supprimer"
                    className="p-1.5 rounded-lg text-text-tertiary hover:bg-surface-2 hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <button
                onClick={() => setExpanded(e => (e === item.id ? null : item.id))}
                className="w-full px-3 py-1 border-t border-border text-[10px] text-text-tertiary hover:text-text-secondary text-left"
              >
                {expanded === item.id ? 'Masquer l’aperçu' : 'Aperçu'}
              </button>
              {expanded === item.id && (
                <div className="p-2 border-t border-border bg-surface-1 flex justify-center">
                  <DataCardView envelope={item.payload} />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border">
          <p className="text-[11px] text-text-tertiary">
            Ctrl+Maj+V · les éléments épinglés sont conservés.
          </p>
          <button
            onClick={async () => { await clipboardApi.clear(); reload() }}
            disabled={!items.some(i => !i.pinned)}
            className="text-xs px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:bg-surface-2 disabled:opacity-40"
          >
            Effacer l’historique
          </button>
        </div>
      </div>
    </div>
  )
}
