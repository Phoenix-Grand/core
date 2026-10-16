import type React from 'react'

/* Per-module customisation of the header settings menu (the gear ⚙).
 *
 * The core always renders the permanent entries - Paramètres, Apparence, Imprimer,
 * Télécharger des modules complémentaires. A module opts into the conditional ones and
 * adds its own via this registry (imported from `@kubuno/sdk`, resolved at runtime to
 * the host's single instance):
 *   ModuleMenuRegistry.register('drive', {
 *     trash: { route: '/drive/trash' },
 *     print: { onOpen: () => openDrivePrintPreview() },
 *     items: [{ id: 'import', label: 'Importer…', onSelect: openImport }],
 *   })
 */

export interface ModuleMenuItem {
  id:        string
  label:     string
  icon?:     React.ReactNode
  onSelect:  () => void
  /** Lower comes first within the custom section. */
  order?:    number
}

export interface ModuleMenuConfig {
  /** Presence adds a "Corbeille" entry (the module supports deletions). Navigates to
   *  `route`, or calls `onOpen` for an in-app trash view. */
  trash?: { route?: string; onOpen?: () => void }
  /** Rich in-app print preview. Absent → the core falls back to `window.print()`
   *  (browser preview using the app's `@media print` rules). */
  print?: { onOpen: () => void }
  /** Extra items injected between "Imprimer" and the download entry. */
  items?: ModuleMenuItem[]
}

const map = new Map<string, ModuleMenuConfig>()

export const ModuleMenuRegistry = {
  register(moduleId: string, config: ModuleMenuConfig): void { map.set(moduleId, config) },
  get(moduleId: string): ModuleMenuConfig | undefined { return map.get(moduleId) },
  unregisterModule(moduleId: string): void { map.delete(moduleId) },
}
