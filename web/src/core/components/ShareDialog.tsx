import { useTranslation } from 'react-i18next'
import { useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { Trash2, Check, HelpCircle, Settings, ArrowLeft, Link2, Lock, Globe } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { FloatingWindow, Dropdown, Spinner, Button } from '../../ui/index'
import { ShareRegistry, ShareRecipientKinds, type ShareSection } from '../registry/ShareRegistry'
import { useShareStore, type ShareRecipient } from '../store/shareStore'

/**
 * The project's share dialog: who owns a thing, who it is shared with, and at
 * which permission. Everything beyond that - link scope, per-module switches,
 * notices - comes from sections modules register in `ShareRegistry`, so the
 * core never has to know what a form or a spreadsheet needs.
 *
 * Opened through `openShare()`; mounted once as `<ShareHost />`.
 */

function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean)
  if (p.length === 0) return '?'
  return (p.length === 1 ? p[0].slice(0, 2) : p[0][0] + p[p.length - 1][0]).toUpperCase()
}

function colorFor(id: string): string {
  const palette = ['#1a73e8', '#d93025', '#1e8e3e', '#f9ab00', '#9334e6', '#e8710a', '#12b5cb', '#d01884']
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function Avatar({ id, name, url }: { id: string; name: string; url: string | null }) {
  return (
    <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs text-white overflow-hidden shrink-0"
      style={{ backgroundColor: colorFor(id) }}>
      {url ? <img src={url} alt={name} className="w-full h-full object-cover" /> : initials(name)}
    </div>
  )
}

/** One person: avatar, name over e-mail, and their role on the right. */
function Person({ id, name, email, url, right }: {
  id: string; name: string; email: string; url: string | null; right: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <Avatar id={id} name={name} url={url} />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-text-primary truncate">{name}</div>
        <div className="text-xs text-text-secondary truncate">{email}</div>
      </div>
      {right}
    </div>
  )
}

export default function ShareDialog() {
  const { t: translate } = useTranslation()
  const entry = useShareStore(st => st.current)
  const close = useShareStore(st => st.close)
  const extras = useSyncExternalStore(ShareRegistry.subscribe, ShareRegistry.list, ShareRegistry.list)
  const kinds  = useSyncExternalStore(ShareRecipientKinds.subscribe, ShareRecipientKinds.list, ShareRecipientKinds.list)
  const qc = useQueryClient()

  const entityId = entry?.target.id ?? ''
  const api      = entry?.api
  const cacheKey = `share:${entry?.target.moduleId ?? ''}`
  const PERMS    = entry?.permissions ?? ['edit', 'view']
  const label    = entry?.permissionLabel ?? ((p: string) => p)

  const [search, setSearch]       = useState('')
  const [debounced, setDebounced] = useState('')
  // New collaborators come in at the most permissive level offered; each row
  // can then be tuned. No selector next to the search field - the reference
  // picks the level per person, once they are in the list.
  const perm = PERMS[0]
  const [open, setOpen]           = useState(false)
  const [settings, setSettings]   = useState(false)
  const [focused, setFocused]     = useState(false)
  const [copied, setCopied]       = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 250)
    return () => clearTimeout(id)
  }, [search])

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h, true)
    return () => document.removeEventListener('mousedown', h, true)
  }, [open])

  const { data, isLoading } = useQuery({
    queryKey: [cacheKey, entityId],
    queryFn:  () => api!.list(entityId),
    enabled:  !!api && !!entityId,
  })
  const { data: results = [] } = useQuery({
    queryKey: [cacheKey, 'recipients', debounced],
    queryFn:  () => api!.searchRecipients(debounced),
    enabled:  !!api && debounced.length > 0,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: [cacheKey, entityId] })
  const addMut = useMutation({
    mutationFn: (r: ShareRecipient) => api!.add(entityId, r.id, perm),
    onSuccess:  () => { setSearch(''); setDebounced(''); setOpen(false); invalidate() },
  })
  const updateMut = useMutation({
    mutationFn: ({ userId, permission }: { userId: string; permission: string }) =>
      api!.update(entityId, userId, permission),
    onSuccess: invalidate,
  })
  const removeMut = useMutation({
    mutationFn: (userId: string) => api!.remove(entityId, userId),
    onSuccess: invalidate,
  })

  if (!entry) return null

  const mine = (slot: ShareSection['slot']) => extras.filter(x =>
    x.moduleId === entry.target.moduleId &&
    (!x.kind || x.kind === entry.target.kind) &&
    (x.slot ?? 'general') === slot)

  const existing = new Set([
    data?.owner?.id,
    ...(data?.collaborators ?? []).map(c => c.user_id),
  ].filter(Boolean) as string[])
  const found = results.filter(r => !existing.has(r.id))

  const name = entry.title ?? translate('sharing.this_item')
  // Every shareable thing has a link: the page it lives on, unless the module
  // knows a better one.
  const shareLink = entry.link ?? window.location.href
  const settingsSections = mine('settings')

  // ── Secondary screen, behind the gear ────────────────────────────────────
  if (settings) {
    return (
      <FloatingWindow
        title={
          <span className="flex items-center gap-2">
            <button onClick={() => setSettings(false)} aria-label={translate('common.back')} title={translate('common.back')}
              className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-2">
              <ArrowLeft size={16} />
            </button>
            {translate('sharing.item_settings', { name })}
          </span>
        }
        onClose={close}
        defaultWidth={520}
        backdrop
      >
        <div className="p-5 space-y-4">
          {settingsSections.length === 0
            ? <p className="text-xs text-text-secondary">{translate('sharing.no_settings')}</p>
            : settingsSections.map(x => (
              <div key={x.id}>
                {x.label && <div className="text-xs text-text-primary mb-2">{x.label}</div>}
                <x.Component target={entry.target} />
              </div>
            ))}
        </div>
      </FloatingWindow>
    )
  }

  // ── Main screen ──────────────────────────────────────────────────────────
  return (
    <FloatingWindow
      title={
        <span className="flex items-center gap-2 w-full">
          <span className="flex-1 truncate">{translate('sharing.item_title', { name })}</span>
          <button aria-label={translate('shared_ui.help')} title={translate('shared_ui.help')}
            className="w-8 h-8 flex items-center justify-center rounded-full text-text-secondary hover:bg-surface-2">
            <HelpCircle size={17} />
          </button>
          <button onClick={() => setSettings(true)} aria-label={translate('sharing.settings')} title={translate('sharing.settings')}
            className="w-8 h-8 flex items-center justify-center rounded-full text-text-secondary hover:bg-surface-2">
            <Settings size={17} />
          </button>
        </span>
      }
      onClose={close}
      defaultWidth={520}
      backdrop
    >
      <div className="p-5 space-y-5">
        {/* Add people */}
        <div ref={boxRef} className="relative">
          <div className="flex gap-2 items-start">
            {/* Outlined field: the legend notches the border, so the label sits
                ON the outline instead of above or inside it. `fieldset` does
                that natively - no faked background behind the text. */}
            <fieldset
              className="flex-1 min-w-0 rounded-lg px-3 pb-2 transition-colors"
              style={{
                border: `1px solid ${focused ? 'var(--color-primary)' : 'var(--color-border)'}`,
                paddingTop: 2,
              }}
            >
              <legend className="px-1 text-xs transition-colors"
                style={{ color: focused ? 'var(--color-primary)' : 'var(--color-text-secondary)' }}>
                {/* People and groups are the core's own; anything else is a term
                    a module contributed, and only if it is installed. */}
                {translate('sharing.add_recipients', {
                  kinds: [translate('sharing.people'), translate('sharing.groups'), ...kinds.map(k => k.label)].join(' / '),
                })}
              </legend>
              <div className="flex items-center pb-1">
                <input
                  value={search}
                  onChange={e => { setSearch(e.target.value); setOpen(true) }}
                  onFocus={() => { setOpen(true); setFocused(true) }}
                  onBlur={() => setFocused(false)}
                  className="flex-1 min-w-0 bg-transparent outline-none text-xs"
                />
              </div>
            </fieldset>
          </div>
          {open && debounced.length > 0 && (
            <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
              {found.length === 0
                ? <div className="px-3 py-2 text-xs text-text-tertiary">{translate('sharing.no_users')}</div>
                : found.map(r => (
                  <button key={r.id} onClick={() => addMut.mutate(r)} disabled={addMut.isPending}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-2 text-left">
                    <Avatar id={r.id} name={r.display_name || r.email} url={r.avatar_url} />
                    <div className="min-w-0">
                      <div className="text-xs truncate">{r.display_name || r.email}</div>
                      {r.display_name && <div className="text-xs text-text-tertiary truncate">{r.email}</div>}
                    </div>
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* Who has access */}
        <div>
          <h3 className="text-base text-text-primary mb-1">{translate('sharing.users_with_access')}</h3>
          {isLoading ? (
            <div className="flex justify-center py-4"><Spinner size="sm" /></div>
          ) : (
            <div>
              {data?.owner && (
                <Person id={data.owner.id} url={data.owner.avatar_url}
                  name={translate('sharing.you', { name: data.owner.display_name || data.owner.email })}
                  email={data.owner.email}
                  right={<span className="text-xs text-text-secondary flex items-center gap-1"><Check size={13} /> {translate('sharing.owner')}</span>} />
              )}
              {(data?.collaborators ?? []).map(c => (
                <Person key={c.user_id} id={c.user_id} url={c.avatar_url}
                  name={c.display_name || c.email} email={c.email}
                  right={
                    <span className="flex items-center gap-1">
                      <Dropdown value={c.permission} height={32} fontSize={12}
                        onChange={v => updateMut.mutate({ userId: c.user_id, permission: v })}
                        options={PERMS.map(p => ({ value: p, label: label(p) }))} />
                      <button onClick={() => removeMut.mutate(c.user_id)} disabled={removeMut.isPending}
                        title={translate('common.remove')} aria-label={translate('common.remove')}
                        className="p-1.5 rounded text-text-tertiary hover:text-danger hover:bg-danger-light">
                        <Trash2 size={15} />
                      </button>
                    </span>
                  } />
              ))}
              {(data?.collaborators ?? []).length === 0 && (
                <div className="text-xs text-text-tertiary py-1">{translate('sharing.only_you')}</div>
              )}
            </div>
          )}
        </div>

        {/* General access: the link scope the core owns, then whatever the
            module adds (a form's respondent view, a doc's comment policy…). */}
        {(entry.linkAccess || mine('general').length > 0) && (
          <div>
            <h3 className="text-base text-text-primary mb-2">{translate('sharing.general_access')}</h3>
            <div className="space-y-3">
              {entry.linkAccess && (() => {
                const la = entry.linkAccess
                const current = la.options.find(o => o.value === la.value)
                const restricted = la.value === la.options[0]?.value
                return (
                  <div className="flex items-start gap-3">
                    <span className="w-9 h-9 rounded-full bg-surface-2 flex items-center justify-center shrink-0">
                      {restricted
                        ? <Lock size={16} className="text-text-secondary" />
                        : <Globe size={16} className="text-success" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-primary">{la.label ?? translate('sharing.link_access')}</span>
                        <Dropdown value={la.value} width={260}
                          onChange={v => la.onChange(v)}
                          options={la.options.map(o => ({ value: o.value, label: o.label }))} />
                      </div>
                      {current?.hint && <p className="text-xs text-text-secondary mt-0.5">{current.hint}</p>}
                    </div>
                  </div>
                )
              })()}
              {mine('general').map(x => (
                <div key={x.id}>
                  {x.label && <div className="text-xs text-text-secondary mb-1">{x.label}</div>}
                  <x.Component target={entry.target} />
                </div>
              ))}
            </div>
          </div>
        )}

        {mine('notice').map(x => (
          <div key={x.id}
            className="rounded-lg bg-primary-light px-4 py-3 text-xs text-text-primary empty:hidden empty:p-0">
            <x.Component target={entry.target} />
          </div>
        ))}

        <div className="flex items-center justify-between pt-1">
          <Button variant="secondary" icon={<Link2 size={16} />}
            onClick={() => {
              void navigator.clipboard.writeText(shareLink)
                .then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600) })
            }}>
            {copied ? translate('sharing.link_copied') : translate('sharing.copy_link')}
          </Button>
          <Button variant="primary" onClick={close}>OK</Button>
        </div>
      </div>
    </FloatingWindow>
  )
}
