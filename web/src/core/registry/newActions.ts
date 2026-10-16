/**
 * Contract for the sidebar « Nouveau » button's menu.
 *
 * The button uses THE project's menu component (`MenuDropdown` from `@ui`), which
 * takes DATA (`MenuItem[]`), not React nodes - so a module contributes items, not
 * a component rendering Radix `DropdownMenu.Item`s (the previous contract, which
 * forced a bespoke Radix panel and a second menu look in the app).
 *
 * `items` is a FUNCTION evaluated when the menu opens: it can read stores
 * (`useX.getState()`) and translate (`i18n.t`) at that moment, so a module needs
 * no hooks - the same trick ModuleMenuRegistry uses for the gear menu.
 *
 * Channel: the generic ExtensionRegistry under the literal point
 * 'shell.new-actions' (both `ExtensionRegistry` and `MenuItem` are already part of
 * the published `@kubuno/sdk` / `@kubuno/ui` surface, so contributors need no SDK
 * republish):
 *
 *   ExtensionRegistry.register(NEW_ACTIONS, 'drive', {
 *     moduleId: 'drive',
 *     items: () => [{ type: 'action', label: …, icon: …, onClick: … }],
 *   } satisfies NewActionsProvider)
 */
import type { MenuItem } from '../../ui/MenuDropdown'

export const NEW_ACTIONS = 'shell.new-actions'

export interface NewActionsProvider {
  /** Owning module - the shell only shows the contributions of the ACTIVE module. */
  moduleId: string
  /** Built when the menu opens (fresh labels/state), never at registration time. */
  items: () => MenuItem[]
  /** Lower comes first when several providers contribute. */
  order?: number
}
