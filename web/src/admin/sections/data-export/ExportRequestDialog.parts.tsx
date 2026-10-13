/**
 * The parts of `ExportRequestDialog.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Search, X } from "lucide-react"
import { Badge, Callout, Checkbox, FloatingWindow, Input, Spinner } from "@ui"
import { formatWhen } from "../format"
import type { ExportRequestDialog } from './ExportRequestDialog'
const PICKER_LIMIT = 500

function Legend({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-text-primary" style={{ fontSize: 'var(--kb-text-body)', fontWeight: 600 }}>
      {children}
    </span>
  )
}
export { Legend }

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
      {children}
    </span>
  )
}
export { Hint }

function ScopeChoice({ checked, onSelect, title, description }: {
  checked:     boolean
  onSelect:    () => void
  title:       string
  description: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      className={`flex min-w-0 flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
        checked
          ? 'border-primary bg-primary-light'
          : 'border-border bg-surface-0 hover:bg-surface-1'
      }`}
    >
      <span className="text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>{title}</span>
      <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
        {description}
      </span>
    </button>
  )
}
export { ScopeChoice }

export function Part1({ t, onClose, submit, canSubmit, request, scope, setScope, overview, query, setQuery, pickedLabels, setPicked, loadingUsers, shown, picked, services, toggleService, withInstance, setWithInstance, accounts, i18n, error }: { t: NonNullable<ExportRequestDialog['tr']>; onClose: NonNullable<ExportRequestDialog['props']['onClose']>; submit: ExportRequestDialog['submit']; canSubmit: NonNullable<ExportRequestDialog['canSubmit']>; request: NonNullable<ExportRequestDialog['request']>; scope: NonNullable<ExportRequestDialog['scope']>; setScope: NonNullable<ExportRequestDialog['setScope']>; overview: NonNullable<ExportRequestDialog['props']['overview']>; query: NonNullable<ExportRequestDialog['query']>; setQuery: NonNullable<ExportRequestDialog['setQuery']>; pickedLabels: NonNullable<ExportRequestDialog['pickedLabels']>; setPicked: NonNullable<ExportRequestDialog['setPicked']>; loadingUsers: NonNullable<ExportRequestDialog['loadingUsers']>; shown: NonNullable<ExportRequestDialog['shown']>; picked: NonNullable<ExportRequestDialog['picked']>; services: NonNullable<ExportRequestDialog['services']>; toggleService: ExportRequestDialog['toggleService']; withInstance: NonNullable<ExportRequestDialog['withInstance']>; setWithInstance: NonNullable<ExportRequestDialog['setWithInstance']>; accounts: NonNullable<ExportRequestDialog['accounts']>; i18n: NonNullable<ExportRequestDialog['i18n']>; error: NonNullable<ExportRequestDialog['error']> }) {
  return (
    <FloatingWindow
            title={t('admin.dx_new_title')}
            onClose={onClose}
            defaultWidth={720}
            backdrop
            padding={20}
            t={t}
            actions={{
              confirm: {
                label:    t('admin.dx_request'),
                onClick:  submit,
                disabled: !canSubmit,
                loading:  request.isPending,
              },
              cancel: { label: t('common.cancel') },
            }}
          >
            <div className="flex min-w-0 flex-col gap-5">
              {/* ── Perimeter ───────────────────────────────────────────────── */}
              <section className="flex min-w-0 flex-col gap-2">
                <Legend>{t('admin.dx_scope_legend')}</Legend>
                <ScopeChoice
                  checked={scope === 'instance'}
                  onSelect={() => setScope('instance')}
                  title={t('admin.dx_scope_instance')}
                  description={t('admin.dx_scope_instance_desc', { count: overview.active_accounts })}
                />
                <ScopeChoice
                  checked={scope === 'accounts'}
                  onSelect={() => setScope('accounts')}
                  title={t('admin.dx_scope_accounts')}
                  description={t('admin.dx_scope_accounts_desc')}
                />
              </section>
    
              {/* ── The picker ──────────────────────────────────────────────── */}
              {scope === 'accounts' && (
                <section className="flex min-w-0 flex-col gap-2">
                  <Input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder={t('admin.dx_pick_search')}
                    leftIcon={<Search size={15} />}
                    aria-label={t('admin.dx_pick_search')}
                  />
    
                  {pickedLabels.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {pickedLabels.map(p => (
                        <button
                          key={p.id}
                          type="button"
                          className="flex items-center gap-1 rounded border border-border bg-surface-1 px-2 py-0.5 text-text-primary hover:bg-surface-2"
                          style={{ fontSize: 'var(--kb-text-meta)' }}
                          onClick={() => setPicked(list => list.filter(id => id !== p.id))}
                        >
                          <span className="max-w-52 truncate">{p.label}</span>
                          <X size={12} />
                        </button>
                      ))}
                    </div>
                  )}
    
                  <div className="max-h-64 min-w-0 overflow-y-auto rounded-lg border border-border bg-surface-0">
                    {loadingUsers && (
                      <div className="flex justify-center py-6"><Spinner /></div>
                    )}
                    {!loadingUsers && shown.length === 0 && (
                      <p
                        className="px-3 py-4 text-text-tertiary"
                        style={{ fontSize: 'var(--kb-text-meta)' }}
                      >
                        {t('admin.dx_pick_empty')}
                      </p>
                    )}
                    {shown.map(u => (
                      <label
                        key={u.id}
                        className="flex min-w-0 cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2 last:border-b-0 hover:bg-surface-1"
                      >
                        <Checkbox
                          checked={picked.includes(u.id)}
                          onChange={on => setPicked(list =>
                            on ? [...new Set([...list, u.id])] : list.filter(id => id !== u.id))}
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
                            {u.display_name?.trim() || u.username}
                          </span>
                          <span className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                            {u.email}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <Hint>{t('admin.dx_pick_hint', { limit: PICKER_LIMIT })}</Hint>
                </section>
              )}
    
              {/* ── Services ────────────────────────────────────────────────── */}
              <section className="flex min-w-0 flex-col gap-2">
                <Legend>{t('admin.dx_services_legend')}</Legend>
                <div className="flex min-w-0 flex-col gap-1.5">
                  {overview.services.map(s => (
                    <div
                      key={s.id}
                      className="flex min-w-0 items-start gap-2.5 rounded-lg border border-border bg-surface-1 px-3 py-2"
                    >
                      <span className="pt-0.5">
                        <Checkbox
                          checked={s.required || services.includes(s.id)}
                          disabled={s.required}
                          onChange={on => toggleService(s.id, on)}
                          aria-label={s.label}
                        />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
                            {s.label}
                          </span>
                          {s.required && <Badge variant="neutral" size="sm">{t('admin.dx_service_always')}</Badge>}
                          {s.format && (
                            <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro)' }}>
                              {s.format}
                            </span>
                          )}
                        </span>
                        {s.description && (
                          <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                            {s.description}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
                <Hint>{t('admin.dx_services_hint')}</Hint>
              </section>
    
              {/* ── Instance referentials ───────────────────────────────────── */}
              <section className="flex min-w-0 flex-col gap-2">
                <Legend>{t('admin.dx_instance_legend')}</Legend>
                <div className="flex min-w-0 items-start gap-2.5 rounded-lg border border-border bg-surface-1 px-3 py-2">
                  <span className="pt-0.5">
                    <Checkbox
                      checked={withInstance}
                      onChange={setWithInstance}
                      aria-label={t('admin.dx_instance_label')}
                    />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
                      {t('admin.dx_instance_label')}
                    </span>
                    <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                      {t('admin.dx_instance_desc')}
                    </span>
                  </span>
                </div>
              </section>
    
              {/* ── What is about to happen ─────────────────────────────────── */}
              <Callout variant="warning" title={t('admin.dx_summary_title')} t={t}>
                <span className="block">
                  {t('admin.dx_summary', {
                    count:   accounts,
                    hold:    overview.policy.hold_hours,
                    days:    overview.policy.retention_days,
                  })}
                </span>
                <span className="mt-1 block">{t('admin.dx_summary_alert')}</span>
                {accounts > 0 && (
                  <span className="mt-1 block text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                    {t('admin.dx_summary_when', {
                      when: formatWhen(
                        new Date(Date.parse(overview.now) + overview.policy.hold_hours * 3_600_000)
                          .toISOString(),
                        i18n.language,
                      ),
                    })}
                  </span>
                )}
              </Callout>
    
              {error && (
                <p className="text-danger" role="alert" style={{ fontSize: 'var(--kb-text-body)' }}>
                  {error}
                </p>
              )}
            </div>
          </FloatingWindow>
  )
}
