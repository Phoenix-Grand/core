/**
 * Code-behind of `MenusGroup.kbcontrol` (converted from `MenusGroup.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { FileText } from "lucide-react"
import MockContextMenu from "../mocks/MockContextMenu"

import { ViewBase } from './MenusGroup.kbcontrol'

export class MenusGroup extends ViewBase {
  @bind accessor sortVal = 'name'

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    this.useStores()
  }

  get items_source() {
    return this.memo('items_source', [], () => [
            { value: 'name', label: 'Nom', icon: <FileText size={14} /> },
            { value: 'date', label: 'Date de modification' },
            { value: 'size', label: 'Taille' },
            { value: 'type', label: 'Type' },
          ])
  }

  /** `<MockContextMenu>`, rendered by a ReactHost. */
  get MockContextMenu() {
    return MockContextMenu
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type MenusGroupStores = ReturnType<MenusGroup['useStores']>

export default MenusGroup.component()
