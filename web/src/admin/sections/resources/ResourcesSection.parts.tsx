/**
 * The parts of `ResourcesSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Tabs } from "@ui"
import { type ResourcePane } from "./panes"
import type { ResourcesSection } from './ResourcesSection'

export function Part1({ t, tabs, pane, go }: { t: NonNullable<ResourcesSection['tr']>; tabs: NonNullable<ResourcesSection['tabs']>; pane: NonNullable<ResourcesSection['pane']>; go: ResourcesSection['go'] }) {
  return (
    <Tabs<ResourcePane> t={t} tabs={tabs} value={pane} onChange={go} />
  )
}
