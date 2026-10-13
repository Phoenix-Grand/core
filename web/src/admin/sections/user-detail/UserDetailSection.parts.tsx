/**
 * The parts of `UserDetailSection.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Tabs } from "@ui"
import type { UserDetailSection } from './UserDetailSection'
type Pane = 'profile' | 'security' | 'activity'

export function Part1({ t, tabs, pane, setPane }: { t: NonNullable<UserDetailSection['tr']>; tabs: NonNullable<UserDetailSection['tabs']>; pane: NonNullable<UserDetailSection['pane']>; setPane: UserDetailSection['setPane'] }) {
  return (
    <Tabs<Pane> t={t} tabs={tabs} value={pane} onChange={setPane} />
  )
}
