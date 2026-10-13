/**
 * The parts of `ModuleSidePanel.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { type ReactNode } from "react"
import { Link } from "react-router-dom"
import { ChevronDown } from "lucide-react"
import { adminPath } from "../../adminRoute"
import { findIcon } from "../../../core/utils/iconMap"
import ScopeTree from "./ScopeTree"
import type { ModuleSidePanel } from './ModuleSidePanel'

function Section(
  { title, open, onToggle, children }:
  { title: string; open: boolean; onToggle: () => void; children: ReactNode },
) {
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-1"
      >
        {/* Section title: plain 14px bold, no small caps, no accent bar. */}
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-text-primary">{title}</span>
        <ChevronDown
          size={16}
          strokeWidth={1.5}
          className={`shrink-0 text-text-tertiary transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  )
}
export { Section }

export function Part1({ Glyph }: { Glyph: NonNullable<ModuleSidePanel['Glyph']> }) {
  return (
    <Glyph size={24} />
  )
}

export function Part2({ t, openPages, setOpenPages, groups, activeGroup, module }: { t: NonNullable<ModuleSidePanel['tr']>; openPages: NonNullable<ModuleSidePanel['openPages']>; setOpenPages: NonNullable<ModuleSidePanel['setOpenPages']>; groups: NonNullable<ModuleSidePanel['props']['groups']>; activeGroup: ModuleSidePanel['props']['activeGroup']; module: NonNullable<ModuleSidePanel['props']['module']> }) {
  return (
    <Section
              title={t('admin.m_pages_panel')}
              open={openPages}
              onToggle={() => setOpenPages(v => !v)}
            >
              <div className="space-y-0.5 px-2 pb-1">
                {groups.map(g => {
                  const isActive = g.id === activeGroup
                  const Icon = findIcon(g.icon)
                  return (
                    // A real <Link> with a real href: middle-click, "open in new
                    // tab" and the status bar all have to work, which an
                    // onClick-only row silently breaks.
                    <Link
                      key={g.id}
                      to={adminPath('modules', module.id, g.id)}
                      title={g.label}
                      aria-current={isActive ? 'page' : undefined}
                      className={`flex w-full min-w-0 items-center gap-2 rounded-full px-2 py-1.5 text-sm
                              transition-colors ${
                    isActive
                      ? 'bg-primary-light font-medium text-primary'
                      : 'text-text-secondary hover:bg-surface-2'}`}
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {Icon && <Icon size={16} strokeWidth={1.5} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{g.label}</span>
                    </Link>
                  )
                })}
              </div>
            </Section>
  )
}

export function Part3({ t, openScope, setOpenScope, scope, onScopeChange, overridingUnits }: { t: NonNullable<ModuleSidePanel['tr']>; openScope: NonNullable<ModuleSidePanel['openScope']>; setOpenScope: NonNullable<ModuleSidePanel['setOpenScope']>; scope: NonNullable<ModuleSidePanel['props']['scope']>; onScopeChange: NonNullable<ModuleSidePanel['props']['onScopeChange']>; overridingUnits: NonNullable<ModuleSidePanel['overridingUnits']> }) {
  return (
    <Section
              title={t('admin.m_scope_units')}
              open={openScope}
              onToggle={() => setOpenScope(v => !v)}
            >
              <ScopeTree scope={scope} onChange={onScopeChange} overriding={overridingUnits} />
            </Section>
  )
}
