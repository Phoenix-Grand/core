/**
 * The parts of `HolidaysSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Tabs } from "@ui"
import type { HolidaysSection } from './HolidaysSection'
type Pane = 'calendars' | 'units'

export function Part1({ t, tabs, pane, go }: { t: NonNullable<HolidaysSection['tr']>; tabs: NonNullable<HolidaysSection['tabs']>; pane: NonNullable<HolidaysSection['pane']>; go: HolidaysSection['go'] }) {
  return (
    <Tabs<Pane> t={t} tabs={tabs} value={pane} onChange={next => go(next)} />
  )
}
