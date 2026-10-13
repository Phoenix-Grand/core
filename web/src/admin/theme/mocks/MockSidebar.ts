/**
 * Code-behind of `MockSidebar.kbcontrol` (converted from `MockSidebar.tsx` by @kubuno/views-migrate).
 */
import { Folder, House, Star, Trash2 } from "lucide-react"

import { ViewBase } from './MockSidebar.kbcontrol'
import * as __parts from './MockSidebar.parts'

export class MockSidebar extends ViewBase {
  get items() {
    return this.memo('items', [], () => [
    { icon: House, label: 'Accueil', active: true },
    { icon: Folder, label: 'Mon Drive', active: false },
    { icon: Star, label: 'Étoilés', active: false },
    { icon: Trash2, label: 'Corbeille', active: false },
  ])
  }

  get part1_props() {
    return this.memo('part1_props', [this.items], () => ({ items: this.items }))
  }

  /** A part of the screen still written in React (a list callback destructuring its item). */
  get Part1() {
    return __parts.Part1
  }

}

export default MockSidebar.component()
