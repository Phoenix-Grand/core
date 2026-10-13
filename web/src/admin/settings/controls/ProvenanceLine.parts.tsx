/**
 * The parts of `ProvenanceLine.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { MenuDropdown } from "@ui"
import type { ProvenanceLine } from './ProvenanceLine'

export function Part1({ items, menu_pos, menu, theme }: { items: NonNullable<ProvenanceLine['items']>; menu_pos: NonNullable<NonNullable<ProvenanceLine['menu']>['pos']>; menu: NonNullable<ProvenanceLine['menu']>; theme: NonNullable<ProvenanceLine['theme']> }) {
  return (
    <MenuDropdown items={items} pos={menu_pos} onClose={menu.close} theme={theme} />
  )
}
