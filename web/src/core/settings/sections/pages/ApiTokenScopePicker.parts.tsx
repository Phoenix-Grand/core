/**
 * The parts of `ApiTokenScopePicker.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { ChevronRight, Clock } from "lucide-react"
import { Badge, Checkbox, Combobox } from "@ui"
import type { ApiTokenScopePicker } from './ApiTokenScopePicker'

export function Part1({ chosen, toggle, scopes, privilegeLabel, t }: { chosen: NonNullable<ApiTokenScopePicker['chosen']>; toggle: ApiTokenScopePicker['toggle']; scopes: NonNullable<ApiTokenScopePicker['props']['scopes']>; privilegeLabel: NonNullable<ApiTokenScopePicker['privilegeLabel']>; t: NonNullable<ApiTokenScopePicker['tr']> }) {
  return (
    <Combobox
              value={null}
              onChange={(key) => { if (key && !chosen.has(key)) toggle(key) }}
              options={scopes
                .filter((s) => !chosen.has(s.key))
                .map((s) => ({ value: s.key, label: `${privilegeLabel(s)} - ${s.key}` }))}
              placeholder={t('settings.tok_scopes')}
              searchPlaceholder={t('settings.tok_scopes_search')}
              width={220}
              maxHeight={280}
              t={t}
            />
  )
}

export function Part2({ groups, chosen, collapsed, setCollapsed, domainLabel, toggleGroup, t, toggle, privilegeLabel, privilegeDescription }: { groups: NonNullable<ApiTokenScopePicker['groups']>; chosen: NonNullable<ApiTokenScopePicker['chosen']>; collapsed: NonNullable<ApiTokenScopePicker['collapsed']>; setCollapsed: NonNullable<ApiTokenScopePicker['setCollapsed']>; domainLabel: NonNullable<ApiTokenScopePicker['domainLabel']>; toggleGroup: ApiTokenScopePicker['toggleGroup']; t: NonNullable<ApiTokenScopePicker['tr']>; toggle: ApiTokenScopePicker['toggle']; privilegeLabel: NonNullable<ApiTokenScopePicker['privilegeLabel']>; privilegeDescription: NonNullable<ApiTokenScopePicker['privilegeDescription']> }) {
  return (
    <>{groups.map(([domain, items]) => {
              const keys = items.map((s) => s.key)
              const allOn = keys.every((k) => chosen.has(k))
              const isOpen = !collapsed.has(domain)
              return (
                <div key={domain}>
                  <div className="flex items-center gap-2 px-3 py-2 bg-surface-1">
                    <button
                      type="button"
                      onClick={() => {
                        const next = new Set(collapsed)
                        if (isOpen) next.add(domain)
                        else next.delete(domain)
                        setCollapsed(next)
                      }}
                      className="flex items-center gap-1.5 flex-1 min-w-0 text-left text-text-primary"
                      aria-expanded={isOpen}
                    >
                      <ChevronRight
                        size={13}
                        className={`shrink-0 text-text-tertiary transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      />
                      <span className="text-xs font-medium truncate">{domainLabel(domain)}</span>
                      <span className="text-xs text-text-tertiary shrink-0">
                        {keys.filter((k) => chosen.has(k)).length}/{keys.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleGroup(keys, allOn)}
                      className="text-xs text-text-secondary hover:text-primary shrink-0"
                    >
                      {t('settings.tok_scopes_group_all')}
                    </button>
                  </div>
    
                  {isOpen && (
                    <div className="px-3 py-1.5 space-y-1.5">
                      {items.map((s) => (
                        <div key={s.key} className="flex items-start gap-2">
                          <Checkbox
                            checked={chosen.has(s.key)}
                            onChange={() => toggle(s.key)}
                            label={privilegeLabel(s)}
                            description={privilegeDescription(s) ?? undefined}
                            className="flex-1 min-w-0"
                          />
                          {s.requires_expiry && (
                            <Badge variant="warning" size="sm">
                              <Clock size={10} className="inline mr-0.5 -mt-px" />
                              {t('settings.tok_scope_requires_expiry')}
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}</>
  )
}
