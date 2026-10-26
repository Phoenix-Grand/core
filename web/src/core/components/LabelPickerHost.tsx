import { useTranslation } from 'react-i18next'
/**
 * Global host of the cross-module label picker (mounted once in App.tsx, like
 * PromptHost). Opens when `openLabelPicker(envelope)` is called from anywhere -
 * core pages or modules through the `core` service. Lets the user attach or
 * detach labels on the element, creating new labels inline.
 */
import { useEffect, useMemo, useState } from 'react'
import { Tag, Check, Plus, X, Loader2, Users, Info } from 'lucide-react'
import { useLabelPickerStore } from '../store/labelPickerStore'
import { labelsApi, type CoreLabel } from '../api/labels'

const PALETTE = ['#1a73e8', '#1e8e3e', '#d93025', '#f9ab00', '#9334e6', '#e8710a', '#12805c', '#5f6368']

export default function LabelPickerHost() {
  const { t: translate } = useTranslation()
  const current = useLabelPickerStore(s => s.current)
  const close = useLabelPickerStore(s => s.close)
  const [labels, setLabels] = useState<CoreLabel[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [initial, setInitial] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // Checked labels the caller does NOT own: their managers will see this element.
  const sharedChecked = useMemo(
    () => labels.filter(l => checked.has(l.id) && !l.is_owner),
    [labels, checked],
  )

  useEffect(() => {
    if (!current) return
    setQuery('')
    setLoading(true)
    Promise.all([
      labelsApi.list(),
      labelsApi.forResource(current.envelope.type, current.resourceId),
    ])
      .then(([ls, ids]) => {
        setLabels(ls)
        setChecked(new Set(ids))
        setInitial(new Set(ids))
      })
      .catch(() => { setLabels([]); setChecked(new Set()); setInitial(new Set()) })
      .finally(() => setLoading(false))
  }, [current])

  const filtered = useMemo(
    () => labels.filter(l => l.name.toLowerCase().includes(query.trim().toLowerCase())),
    [labels, query],
  )
  const exactMatch = labels.some(l => l.name.toLowerCase() === query.trim().toLowerCase())

  if (!current) return null
  const { envelope } = current

  const toggle = (id: string) => setChecked(prev => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

  const createAndCheck = async () => {
    const name = query.trim()
    if (!name) return
    try {
      const color = PALETTE[labels.length % PALETTE.length]
      const label = await labelsApi.create(name, color)
      setLabels(prev => [...prev, label].sort((a, b) => a.name.localeCompare(b.name)))
      setChecked(prev => new Set(prev).add(label.id))
      setQuery('')
    } catch { /* conflict/network: keep the dialog usable */ }
  }

  const save = async () => {
    setSaving(true)
    try {
      await labelsApi.setForResource({
        module: envelope.module,
        resource_type: envelope.type,
        resource_id: current.resourceId,
        title: envelope.title,
        href: envelope.href,
        envelope,
        label_ids: [...checked],
      })
      close(checked.size !== initial.size || [...checked].some(id => !initial.has(id)))
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center" onClick={() => close(false)}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative bg-surface-0 rounded-2xl shadow-xl w-full max-w-sm flex flex-col max-h-[70vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-2.5 px-5 pt-4 pb-2">
          <Tag size={18} className="text-primary mt-0.5 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-text-primary">{translate('labels.title')}</h3>
            <p className="text-xs text-text-tertiary truncate">{envelope.title ?? envelope.type} · {envelope.module}</p>
          </div>
          <button onClick={() => close(false)} className="p-1 rounded-full text-text-tertiary hover:bg-surface-2">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 pb-2">
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && query.trim() && !exactMatch) createAndCheck() }}
            placeholder={translate('labels.search_or_create')}
            className="w-full text-sm px-3 py-2 rounded-lg border border-border bg-surface-0 text-text-primary outline-none focus:border-primary placeholder:text-text-tertiary"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-1 min-h-[120px]">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-text-tertiary"><Loader2 size={18} className="animate-spin" /></div>
          ) : (
            <>
              {filtered.map(l => (
                <button
                  key={l.id}
                  onClick={() => toggle(l.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-1 text-left"
                >
                  <span className="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ backgroundColor: l.color }} />
                  <span className="flex-1 text-sm text-text-primary truncate">{l.name}</span>
                  {!l.is_owner && (
                    <span title={translate('labels.shared_by', { name: l.owner_name })} className="flex-shrink-0">
                      <Users size={12} className="text-text-tertiary" />
                    </span>
                  )}
                  <span className="text-[11px] text-text-tertiary">{l.link_count}</span>
                  <span className={`w-4 ${checked.has(l.id) ? 'text-primary' : 'text-transparent'}`}><Check size={15} /></span>
                </button>
              ))}
              {query.trim() && !exactMatch && (
                <button
                  onClick={createAndCheck}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-1 text-left text-primary"
                >
                  <Plus size={15} className="flex-shrink-0" />
                  <span className="text-sm">{translate('labels.create_named', { name: query.trim() })}</span>
                </button>
              )}
              {!filtered.length && !query.trim() && (
                <p className="px-3 py-6 text-center text-xs text-text-tertiary">
                  {translate('labels.none')}</p>
              )}
            </>
          )}
        </div>

        {/* Attaching a SHARED label exposes this element to that label's managers
            (its owner and any co-owner) - say so rather than let it surprise. */}
        {sharedChecked.length > 0 && (
          <p className="mx-5 mb-2 flex items-start gap-1.5 rounded-lg bg-warning-light px-2.5 py-2 text-[11px] text-text-secondary">
            <Info size={12} className="mt-0.5 flex-shrink-0" />
            <span>
              {sharedChecked.length === 1
                ? translate('labels.shared_warning', { name: sharedChecked[0].name, owner: sharedChecked[0].owner_name })
                : translate('labels.shared_warnings', { count: sharedChecked.length })}
            </span>
          </p>
        )}

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <button onClick={() => close(false)} className="px-3 py-1.5 text-sm rounded-lg text-text-secondary hover:bg-surface-2">
            {translate('common.cancel')}</button>
          <button
            onClick={save}
            disabled={saving || loading}
            className="px-4 py-1.5 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {saving ? '…' : translate('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
