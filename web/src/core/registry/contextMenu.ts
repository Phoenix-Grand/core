/**
 * Contract for the shell's background context menu (right-click on the empty
 * area of a module's view).
 *
 * Same data-first model as `newActions.ts`: a module contributes `MenuItem[]`,
 * rendered by THE project's menu component (`MenuDropdown` from `@ui`) - no more
 * bespoke panel filled with a slot of components.
 *
 *   ExtensionRegistry.register(CONTEXT_MENU_ITEMS, 'drive', {
 *     moduleId: 'drive',
 *     items: () => [{ type: 'action', label: …, onClick: … }],
 *   } satisfies ContextMenuProvider)
 *
 * `items` is a FUNCTION evaluated on each right-click: it reads stores
 * (`useX.getState()`), the current path and `i18n.t` at that moment, so a
 * contributor needs no hooks. Returning `[]` means "nothing here" and the menu
 * simply does not open.
 *
 * Channel: the generic ExtensionRegistry under a literal point name, so a
 * contributor needs no `@kubuno/sdk` republish (`ExtensionRegistry` and `MenuItem`
 * are already part of the published surface).
 */
import type { MenuItem } from '../../ui/MenuDropdown'

export const CONTEXT_MENU_ITEMS = 'shell.context-menu-items'

export interface ContextMenuItemsProvider {
  /** Owning module - only ACTIVE modules contribute. */
  moduleId: string
  /** Built on each open; `[]` when the module has nothing for this spot. */
  items: () => MenuItem[]
  /** Lower comes first when several modules contribute. */
  order?: number
}
