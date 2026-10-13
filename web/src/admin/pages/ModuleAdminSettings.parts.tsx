/**
 * The parts of `ModuleAdminSettings.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Tabs } from "@ui"
import type { ModuleAdminSettings } from './ModuleAdminSettings'

export function Part1({ tabs, activeTab, setTab, t }: { tabs: NonNullable<ModuleAdminSettings['tabs']>; activeTab: NonNullable<ModuleAdminSettings['activeTab']>; setTab: NonNullable<ModuleAdminSettings['setTab']>; t: NonNullable<ModuleAdminSettings['tr']> }) {
  return (
    <Tabs tabs={tabs} value={activeTab} onChange={setTab} className="mb-4" t={t} />
  )
}

export function Part2({ ExtraTab }: { ExtraTab: NonNullable<ModuleAdminSettings['ExtraTab']> }) {
  return (
    <ExtraTab />
  )
}

export function Part3({ pageCategories, categorySection }: { pageCategories: NonNullable<ModuleAdminSettings['pageCategories']>; categorySection: ModuleAdminSettings['categorySection'] }) {
  return (
    <>{pageCategories.map(c => categorySection(
                  c.category, c.category, c.basic, c.advanced, pageCategories.length === 1,
                ))}</>
  )
}
