import { useTranslation } from 'react-i18next'
/**
 * Generic renderer for cross-module data cards (`KubunoDataEnvelope`).
 *
 * Consumers (chat, notes, mail…) render `<DataCardView envelope={env} />`:
 * if the PRODUCER module registered a renderer on `core.data-card`, it is
 * used; otherwise a self-contained fallback shows the title, the module/type
 * badge, the plain-text summary and the raw JSON payload (collapsible).
 *
 * This file also publishes the whole data-transfer API as the `core` module
 * service, so ANY module can produce/consume envelopes through
 * `ModuleServiceRegistry.get('core', …)` without build-time coupling to the
 * npm `@kubuno/sdk` version (helpers stay importable from the SDK too).
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Package, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react'
import {
  DataTransferRegistry, copyKubunoData, readKubunoData, parseKubunoData,
  isKubunoDataEnvelope, kubunoDataToHtml,
  type DataCardProps, type DataCardRenderer, type KubunoDataEnvelope,
} from './DataTransferRegistry'
import { ModuleServiceRegistry } from './ModuleServiceRegistry'
import { openLabelPicker } from '../store/labelPickerStore'
import { openClipboardPane, pushClipboard } from '../store/clipboardStore'
import { clipboardApi } from '../api/clipboard'
// Side effect: registers the `drive.file` card renderer at chunk load.
import './DriveFileCard'

export function DataCardView({ envelope }: DataCardProps) {
  const { t: translate } = useTranslation()
  const navigate = useNavigate()
  const [showJson, setShowJson] = useState(false)

  const Renderer = DataTransferRegistry.resolveRenderer(envelope.type)
  if (Renderer) return <Renderer envelope={envelope} />

  return (
    <div className="w-72 max-w-full rounded-xl border border-border bg-surface-0 text-text-primary overflow-hidden">
      <div className="px-3 py-2 flex items-start gap-2">
        <Package size={15} className="text-primary mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          {envelope.title && <p className="text-xs font-semibold truncate">{envelope.title}</p>}
          <p className="text-[11px] text-text-tertiary truncate">{envelope.module} · {envelope.type}</p>
        </div>
        {envelope.href && (
          <button
            onClick={() => navigate(envelope.href!)}
            className="p-1 text-text-tertiary hover:text-primary flex-shrink-0"
            title={translate('shared_ui.open_in_module')}
          >
            <ExternalLink size={13} />
          </button>
        )}
      </div>
      {envelope.text && (
        <p className="px-3 pb-2 text-[11px] text-text-secondary whitespace-pre-wrap break-words">{envelope.text}</p>
      )}
      <button
        onClick={() => setShowJson(s => !s)}
        className="w-full flex items-center gap-1 px-3 py-1.5 border-t border-border text-[10px] text-text-tertiary hover:text-text-secondary"
      >
        {showJson ? <ChevronDown size={11} /> : <ChevronRight size={11} />} JSON
      </button>
      {showJson && (
        <pre className="px-3 pb-2 text-[10px] text-text-tertiary overflow-x-auto max-h-40 overflow-y-auto">
          {JSON.stringify(envelope.data, null, 2)}
        </pre>
      )}
    </div>
  )
}

// Platform service: lets every module use the data-transfer API at runtime
// through `ModuleServiceRegistry.get('core', …)` - no vendored helpers and no
// dependency on the published npm type surface. Runs when the shared chunk
// loads, i.e. before any module's register().
/**
 * Copy + record. Every cross-module copy lands in the ROAMING HISTORY, so it
 * survives a reload, reaches the other tabs and the user's other devices, and
 * can be pasted from the clipboard pane. The history push is fire-and-forget:
 * the system clipboard write is what the user is waiting for.
 */
async function copyKubunoDataWithHistory(envelope: KubunoDataEnvelope): Promise<boolean> {
  const ok = await copyKubunoData(envelope)
  void pushClipboard(envelope)
  return ok
}

ModuleServiceRegistry.publish('core', {
  // Modules keep calling `copyKubunoData`: the history comes for free.
  copyKubunoData: copyKubunoDataWithHistory,
  readKubunoData,
  parseKubunoData,
  isKubunoDataEnvelope,
  kubunoDataToHtml,
  registerDataCardRenderer: (moduleId: string, renderer: DataCardRenderer) =>
    DataTransferRegistry.registerRenderer(moduleId, renderer),
  resolveDataCard: (type: string) => DataTransferRegistry.resolve(type),
  DataCardView,
  // Cross-module labels: modules pass the SAME envelope they copy to the
  // clipboard - the picker links it to the user's labels (/labels to browse).
  openLabelPicker,
  // Roaming clipboard history (see api/clipboard.ts): record a clip, show the
  // pane (resolves with the envelope the user picked), or read it directly.
  pushClipboard,
  openClipboardPane,
  listClipboard: (limit?: number) => clipboardApi.list(limit),
})
