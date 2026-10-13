/**
 * The parts of `MarketplacePanel.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { isNewerVersion } from "../../core/utils/semver"
import { Package, Check, Download, RefreshCw, Star, ExternalLink, Trash2 } from "lucide-react"
import type { MarketplacePanel } from './MarketplacePanel'

export function Part1({ visible, cat, busy, t, uninstall, install, phase }: { visible: NonNullable<MarketplacePanel['visible']>; cat: NonNullable<MarketplacePanel['rows_categories']>[number]['cat']; busy: MarketplacePanel['busy']; t: NonNullable<MarketplacePanel['tr']>; uninstall: NonNullable<MarketplacePanel['uninstall']>; install: NonNullable<MarketplacePanel['install']>; phase: NonNullable<MarketplacePanel['phase']> }) {
  return (
    <>{visible.filter((m) => (m.category || 'Autres') === cat).map((mod) => {
                  // Strictly newer only: a catalogue lagging behind must never invite
                  // an administrator to downgrade (string comparison offered 0.1.8
                  // to an instance running 0.1.10).
                  const catalogueIsNewer =
                    !!mod.installed_version && isNewerVersion(mod.version, mod.installed_version)
                  const canUpdate = !!mod.installed && catalogueIsNewer
                  const upToDate = !!mod.installed && !catalogueIsNewer
                  const isBusy = busy === mod.id
                  return (
                    <div key={mod.id} className="bg-white rounded-xl border border-border p-4 flex flex-col gap-3">
                      <div className="flex items-start gap-2">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-white"
                             style={{ backgroundColor: mod.accent || '#1a73e8' }}>
                          <Package size={16} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <p className="text-sm font-medium text-text-primary truncate">{mod.name}</p>
                            {mod.official && (
                              <span className="text-[10px] px-1.5 py-px rounded-full bg-primary-light text-primary font-medium">
                                {t('admin.mk_official', { defaultValue: 'Officiel' })}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-text-tertiary flex items-center gap-2">
                            v{mod.version}
                            {typeof mod.rating === 'number' && mod.rating > 0 && (
                              <span className="inline-flex items-center gap-0.5"><Star size={11} className="text-warning" fill="currentColor" />{mod.rating}</span>
                            )}
                          </p>
                        </div>
                      </div>
                      {mod.summary && <p className="text-sm text-text-secondary leading-relaxed line-clamp-3">{mod.summary}</p>}
                      <div className="mt-auto flex items-center justify-between gap-2">
                        {mod.links?.repo
                          ? <a href={mod.links.repo} target="_blank" rel="noreferrer"
                               className="text-sm text-text-tertiary hover:text-primary inline-flex items-center gap-1">
                              <ExternalLink size={12} /> {t('admin.mk_source', { defaultValue: 'Source' })}
                            </a>
                          : <span />}
                        <div className="flex items-center gap-1.5">
                          {mod.removable && (
                            <button
                              onClick={() => uninstall.mutate(mod.id)}
                              disabled={isBusy}
                              title={t('admin.mk_uninstall', { defaultValue: 'Désinstaller' })}
                              className="p-1.5 rounded-lg text-text-tertiary hover:text-danger hover:bg-danger-light disabled:opacity-60 transition-colors">
                              <Trash2 size={14} />
                            </button>
                          )}
                          {upToDate ? (
                            <span className="text-sm px-2.5 py-1 rounded-lg bg-success-light text-success font-medium inline-flex items-center gap-1">
                              <Check size={13} /> {t('admin.mk_installed_badge', { defaultValue: 'Installé' })}
                            </span>
                          ) : (
                            <button
                              onClick={() => install.mutate(mod.id)}
                              disabled={isBusy}
                              className="text-sm px-3 py-1.5 rounded-lg bg-primary text-white font-medium inline-flex items-center gap-1.5 hover:bg-primary-hover disabled:opacity-60 transition-colors">
                              {isBusy
                                ? <><RefreshCw size={13} className="animate-spin" /> {phase[mod.id] || t('admin.mk_installing', { defaultValue: 'Installation…' })}</>
                                : canUpdate
                                  ? <><RefreshCw size={13} /> {t('admin.mk_update', { defaultValue: 'Mettre à jour' })}</>
                                  : <><Download size={13} /> {t('admin.mk_install', { defaultValue: 'Installer' })}</>}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}</>
  )
}
