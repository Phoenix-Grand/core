/**
 * The parts of `AccountUsageDialog.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { AlertTriangle, HardDrive, Shield } from "lucide-react"
import { Callout, EmptyState, ProgressBar, Spinner } from "@ui"
import { FloatingWindow } from "@ui/FloatingWindow"
import { formatAgo, formatBytes } from "../sections/format"
import CategoryComposition from "./CategoryComposition"
import CategoryRows from "./CategoryRows"
import DelegatedNote from "./DelegatedNote"
import Figure from "./Figure"
import type { AccountUsageDialog } from './AccountUsageDialog'

export function Part1({ t, name, onClose, onEditQuota, isLoading, isError, refetch, data, account, reading, modules, rules }: { t: NonNullable<AccountUsageDialog['tr']>; name: NonNullable<AccountUsageDialog['name']>; onClose: NonNullable<AccountUsageDialog['props']['onClose']>; onEditQuota: NonNullable<AccountUsageDialog['props']['onEditQuota']>; isLoading: NonNullable<AccountUsageDialog['isLoading']>; isError: NonNullable<AccountUsageDialog['isError']>; refetch: NonNullable<AccountUsageDialog['refetch']>; data: NonNullable<AccountUsageDialog['data']>; account: NonNullable<AccountUsageDialog['props']['account']>; reading: NonNullable<AccountUsageDialog['reading']>; modules: NonNullable<AccountUsageDialog['modules']>; rules: NonNullable<AccountUsageDialog['rules']> }) {
  return (
    <FloatingWindow
            title={t('admin.sto_acct_title', { name })}
            icon={<HardDrive size={16} />}
            onClose={onClose}
            defaultWidth={720}
            resizable
            backdrop
            t={t}
            actions={{
              confirm: onEditQuota
                ? { label: t('admin.sto_action_quota'), onClick: onEditQuota }
                : undefined,
              cancel: { label: t('admin.sto_acct_close') },
            }}
          >
            <div className="max-h-[70vh] overflow-y-auto overflow-x-hidden p-4">
              {isLoading && (
                <div className="flex justify-center py-12"><Spinner /></div>
              )}
    
              {isError && !isLoading && (
                <EmptyState
                  icon={<HardDrive size={26} />}
                  variant="error"
                  compact
                  title={t('admin.sto_acct_failed')}
                  description={t('admin.sto_acct_failed_desc')}
                  action={{ label: t('admin.sto_retry'), onClick: () => void refetch() }}
                  t={t}
                />
              )}
    
              {data && !isLoading && (
                <div className="flex flex-col gap-5">
                  {/* ── Who, and against what ceiling ─────────────────────────── */}
                  <div>
                    <p className="truncate text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                      {account.email}
                    </p>
                    <div className="mt-2">
                      <ProgressBar
                        value={data.used_bytes}
                        max={Math.max(data.quota_bytes, 1)}
                        label={t('admin.sto_quota_current', {
                          used:  formatBytes(data.used_bytes),
                          quota: formatBytes(data.quota_bytes),
                        })}
                        showValue
                        t={t}
                      />
                    </div>
                  </div>
    
                  {/* ── The four numbers ──────────────────────────────────────── */}
                  <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
                    <Figure label={t('admin.sto_acct_fig_counter')}>{formatBytes(data.used_bytes)}</Figure>
                    <Figure label={t('admin.sto_acct_fig_billed')}>{formatBytes(data.billable_bytes)}</Figure>
                    <Figure label={t('admin.sto_acct_fig_held')}>{formatBytes(data.held_bytes)}</Figure>
                    <Figure label={t('admin.sto_acct_fig_gap')}>
                      {data.unattributed_bytes > 0
                        ? `+${formatBytes(data.unattributed_bytes)}`
                        : data.over_declared_bytes > 0
                          ? `−${formatBytes(data.over_declared_bytes)}`
                          : t('admin.sto_acct_gap_none')}
                    </Figure>
                  </div>
    
                  {/* Both directions are named. A gap folded into an absolute value
                      loses the only thing that tells the operator which side to go
                      looking at. */}
                  {data.unattributed_bytes > 0 && (
                    <Callout variant="warning" title={t('admin.sto_acct_gap_unclaimed_title')} t={t}>
                      {t('admin.sto_acct_gap_unclaimed_desc', { bytes: formatBytes(data.unattributed_bytes) })}
                    </Callout>
                  )}
                  {data.over_declared_bytes > 0 && (
                    <Callout variant="warning" title={t('admin.sto_acct_gap_uncounted_title')} t={t}>
                      {t('admin.sto_acct_gap_uncounted_desc', { bytes: formatBytes(data.over_declared_bytes) })}
                    </Callout>
                  )}
    
                  {/* ── By category ───────────────────────────────────────────── */}
                  <div className="border-t border-border pt-4">
                    <h4 className="font-medium text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
                      {t('admin.sto_acct_cats_title')}
                    </h4>
                    <p className="mt-1 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                      {t('admin.sto_acct_cats_sub')}
                    </p>
                    <div className="mt-3">
                      <CategoryComposition
                        reading={reading}
                        heldBytes={data.held_bytes}
                        ariaLabel={t('admin.sto_acct_cats_aria')}
                        delegatedBytes={data.delegated_bytes}
                        delegatedObjects={data.delegated_objects}
                      />
                    </div>
                  </div>
    
                  {/* ── By module ─────────────────────────────────────────────── */}
                  <div className="border-t border-border pt-4">
                    <h4 className="font-medium text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
                      {t('admin.sto_acct_mods_title')}
                    </h4>
    
                    {modules.length === 0 ? (
                      <p className="mt-2 text-text-tertiary" style={{ fontSize: 'var(--kb-text-body)' }}>
                        {t('admin.sto_acct_mods_empty')}
                      </p>
                    ) : (
                      <div className="mt-3 flex flex-col gap-3">
                        {modules.map(m => (
                          <section key={m.module_id} className="rounded-lg border border-border">
                            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
                              <span className="min-w-0 flex-1 truncate font-medium text-text-primary"
                                    style={{ fontSize: 'var(--kb-text-body)' }}>
                                {m.display_name}
                              </span>
    
                              {m.stale && (
                                <span className="inline-flex shrink-0 items-center gap-1 text-warning"
                                      style={{ fontSize: 'var(--kb-text-meta)' }}>
                                  <AlertTriangle size={13} aria-hidden />
                                  {t('admin.sto_mod_stale')}
                                </span>
                              )}
    
                              <span className="shrink-0 tabular-nums text-text-tertiary"
                                    style={{ fontSize: 'var(--kb-text-meta)' }}>
                                {[
                                  t('admin.sto_cat_objects', { n: m.object_count.toLocaleString(), count: m.object_count }),
                                  t('admin.sto_acct_mod_held', { bytes: formatBytes(m.held_bytes) }),
                                  m.last_declared_at
                                    ? t('admin.sto_mod_declared', { ago: formatAgo(m.last_declared_at) })
                                    : null,
                                ].filter(Boolean).join(' · ')}
                              </span>
    
                              <span className="shrink-0 tabular-nums text-text-primary"
                                    style={{ fontSize: 'var(--kb-text-body)' }}>
                                {formatBytes(m.billable_bytes)}
                              </span>
                            </header>
    
                            <div className="px-3 py-1">
                              <CategoryRows rows={m.categories ?? []} rules={rules} />
                              <DelegatedNote
                                bytes={m.delegated_bytes}
                                objects={m.delegated_objects}
                                scope="module"
                                className="my-2"
                              />
                            </div>
                          </section>
                        ))}
                      </div>
                    )}
                  </div>
    
                  {/* The line stated in the interface too, not only in the code: an
                      operator reading somebody's storage should be told out loud
                      what this screen does not know about them. */}
                  <p className="flex items-start gap-2 border-t border-border pt-4 text-text-tertiary"
                     style={{ fontSize: 'var(--kb-text-meta)' }}>
                    <Shield size={13} className="mt-0.5 shrink-0" aria-hidden />
                    <span className="min-w-0">{t('admin.sto_acct_privacy')}</span>
                  </p>
                </div>
              )}
            </div>
          </FloatingWindow>
  )
}
