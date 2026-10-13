/**
 * The parts of `OrgUnitScopePanel.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { ChevronRight } from "lucide-react"
import { Checkbox } from "@ui"
import type { OrgUnitScopePanel } from './OrgUnitScopePanel'

export function Part1({ rows, matching, expanded, selected, pick, toggle, multi, counts }: { rows: NonNullable<OrgUnitScopePanel['rows']>; matching: OrgUnitScopePanel['matching']; expanded: NonNullable<OrgUnitScopePanel['expanded']>; selected: NonNullable<OrgUnitScopePanel['selected']>; pick: OrgUnitScopePanel['pick']; toggle: OrgUnitScopePanel['toggle']; multi: NonNullable<OrgUnitScopePanel['multi']>; counts: NonNullable<OrgUnitScopePanel['props']['counts']> }) {
  return (
    <>{rows.map(({ u, depth, kids }) => {
                const open = !!matching || expanded.has(u.id) || depth === 0
                const isOn = selected.has(u.id)
                return (
                  <div
                    key={u.id}
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-selected={isOn}
                    aria-expanded={kids > 0 ? open : undefined}
                    onClick={() => pick(u.id)}
                    className={`flex items-center gap-1 rounded cursor-pointer ${
                  isOn ? 'bg-primary-light text-primary' : 'hover:bg-surface-2 text-text-primary'}`}
                    style={{ paddingLeft: depth * 16 }}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden="true"
                      onClick={e => { e.stopPropagation(); toggle(u.id) }}
                      className="w-5 h-5 flex items-center justify-center text-text-tertiary shrink-0"
                    >
                      {kids > 0 && !matching && (
                        <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                      )}
                    </button>
                    {multi && (
                      <span onClick={e => e.stopPropagation()} className="flex items-center">
                        <Checkbox checked={isOn} onChange={() => pick(u.id)} />
                      </span>
                    )}
                    <span className="flex-1 text-left text-sm px-1 py-1.5 truncate">{u.name}</span>
                    {counts?.[u.id] !== undefined && (
                      <span className="text-xs text-text-tertiary pr-2 tabular-nums">{counts[u.id]}</span>
                    )}
                  </div>
                )
              })}</>
  )
}

export function Part2({ value, onChange, t }: { value: NonNullable<OrgUnitScopePanel['props']['value']>; onChange: NonNullable<OrgUnitScopePanel['props']['onChange']>; t: NonNullable<OrgUnitScopePanel['tr']> }) {
  return (
    <Checkbox
                checked={value.descendants}
                onChange={v => onChange({ ...value, descendants: v })}
                label={t('admin.filter_ou_descendants')}
                labelClassName="text-sm text-text-secondary"
              />
  )
}
