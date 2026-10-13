/**
 * The parts of `ScopeTree.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { ChevronRight, Search } from "lucide-react"
import { Input } from "@ui"
import type { ScopeTree } from './ScopeTree'

export function Part1({ needle, setNeedle, t }: { needle: NonNullable<ScopeTree['needle']>; setNeedle: NonNullable<ScopeTree['setNeedle']>; t: NonNullable<ScopeTree['tr']> }) {
  return (
    <Input
                type="search"
                value={needle}
                onChange={e => setNeedle(e.target.value)}
                placeholder={t('admin.ou_search_ph', { defaultValue: 'Rechercher une unité…' })}
                leftIcon={<Search size={14} />}
              />
  )
}

export function Part2({ rows, scope, isOpen, toggle, onChange, rowClass, overriding, t }: { rows: NonNullable<ScopeTree['rows']>; scope: NonNullable<ScopeTree['props']['scope']>; isOpen: ScopeTree['isOpen']; toggle: ScopeTree['toggle']; onChange: NonNullable<ScopeTree['props']['onChange']>; rowClass: ScopeTree['rowClass']; overriding: ScopeTree['props']['overriding']; t: NonNullable<ScopeTree['tr']> }) {
  return (
    <>{rows.map(({ unit, depth, kids }) => {
                const selected = scope.type === 'org_unit' && scope.id === unit.id
                const open = isOpen(unit.id)
                return (
                  // `depth + 1`: the units hang under the instance row above.
                  <div key={unit.id} className="flex items-center" style={{ paddingLeft: (depth + 1) * 12 }}>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden="true"
                      onClick={() => toggle(unit.id)}
                      className="flex h-6 w-5 shrink-0 items-center justify-center text-text-tertiary"
                    >
                      {kids > 0 && (
                        <ChevronRight size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onChange({ type: 'org_unit', id: unit.id })}
                      className={rowClass(selected)}
                      aria-current={selected ? 'true' : undefined}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{unit.name}</span>
                      {/* A branch that no longer follows its parent, named before
                          it is opened. */}
                      {overriding?.has(unit.id) && (
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                          title={t('admin.m_scope_has_overrides', {
                            defaultValue: 'Cette unité remplace au moins un réglage',
                          })}
                        />
                      )}
                    </button>
                  </div>
                )
              })}</>
  )
}
