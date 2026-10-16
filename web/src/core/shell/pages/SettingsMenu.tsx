import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Settings, Trash2, Palette, Printer, Puzzle } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ModuleSettingsRegistry } from '../../slots/SlotRegistry'
import { ModuleMenuRegistry } from '../../registry/ModuleMenuRegistry'
import { useModulesStore } from '../../store/modulesStore'
import { adminUrl } from '../../../admin/adminAction'
import AppearanceDialog from '../dialogs/AppearanceDialog'

/* Header settings menu (⚙). Replaces the old plain "go to settings" button with a
 * Google-style dropdown. Permanent entries - Paramètres, Apparence, Imprimer,
 * Télécharger des modules complémentaires - are always present; Corbeille and any
 * custom items come from the active module via ModuleMenuRegistry. */
export default function SettingsMenu({
  triggerClassName, iconSize, ariaLabel,
}: { triggerClassName: string; iconSize: number; ariaLabel: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { activeModules } = useModulesStore()
  const activeIds = new Set(activeModules.map((m) => m.module_id))

  const moduleId = pathname.split('/').filter(Boolean)[0] || 'home'
  const settingsRoute = ModuleSettingsRegistry.getRoute(moduleId, activeIds) ?? '/settings'
  const menuCfg = ModuleMenuRegistry.get(moduleId)

  const [appearanceOpen, setAppearanceOpen] = useState(false)

  const item = 'flex items-center gap-3 w-full px-3 py-2 text-sm text-text-primary hover:bg-surface-1 cursor-pointer outline-none'
  const sep  = 'my-1 h-px bg-border mx-2'
  const ico  = 'text-text-secondary'

  const openTrash = () => {
    if (menuCfg?.trash?.onOpen) menuCfg.trash.onOpen()
    else if (menuCfg?.trash?.route) navigate(menuCfg.trash.route)
  }
  // Rich in-app preview if the module provides one, else the browser's own print
  // preview (styled by the app's `@media print` rules).
  const doPrint = () => { if (menuCfg?.print?.onOpen) menuCfg.print.onOpen(); else window.print() }
  // Marketplace pre-filtered on modules related to the current one (category/tags).
  const openMarketplace = () => navigate(adminUrl({ tab: 'marketplace', params: { related: moduleId } }))

  const customItems = (menuCfg?.items ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className={triggerClassName} aria-label={ariaLabel}>
            <Settings size={iconSize} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4}
            className="min-w-64 bg-white rounded-[5px] border border-border shadow-lg py-1 z-[9999]">

            <DropdownMenu.Item className={item} onSelect={() => navigate(settingsRoute)}>
              <Settings size={16} className={ico} />
              {t('settingsmenu.settings', { defaultValue: 'Paramètres' })}
            </DropdownMenu.Item>

            {menuCfg?.trash && (
              <DropdownMenu.Item className={item} onSelect={openTrash}>
                <Trash2 size={16} className={ico} />
                {t('settingsmenu.trash', { defaultValue: 'Corbeille' })}
              </DropdownMenu.Item>
            )}

            <DropdownMenu.Separator className={sep} />

            <DropdownMenu.Item className={item} onSelect={() => setAppearanceOpen(true)}>
              <Palette size={16} className={ico} />
              {t('settingsmenu.appearance', { defaultValue: 'Apparence' })}
            </DropdownMenu.Item>

            <DropdownMenu.Item className={item} onSelect={doPrint}>
              <Printer size={16} className={ico} />
              {t('settingsmenu.print', { defaultValue: 'Imprimer' })}
            </DropdownMenu.Item>

            {customItems.length > 0 && (
              <>
                <DropdownMenu.Separator className={sep} />
                {customItems.map((it) => (
                  <DropdownMenu.Item key={it.id} className={item} onSelect={it.onSelect}>
                    {it.icon ? <span className={ico}>{it.icon}</span> : <span className="w-4" />}
                    {it.label}
                  </DropdownMenu.Item>
                ))}
              </>
            )}

            <DropdownMenu.Separator className={sep} />

            <DropdownMenu.Item className={item} onSelect={openMarketplace}>
              <Puzzle size={16} className={ico} />
              {t('settingsmenu.addons', { defaultValue: 'Télécharger des modules complémentaires' })}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {appearanceOpen && <AppearanceDialog moduleId={moduleId} onClose={() => setAppearanceOpen(false)} />}
    </>
  )
}
