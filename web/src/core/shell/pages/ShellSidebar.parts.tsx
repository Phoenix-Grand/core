/**
 * The parts of `ShellSidebar.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { NavLink } from "react-router-dom"
import { useTranslation } from 'react-i18next'
import { Plus, ChevronLeft } from "lucide-react"
import { getIcon } from "../../utils/iconMap"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { useUiStore } from "../../store/uiStore"
import { WaffleAppRegistry } from "../../registry/WaffleAppRegistry"
import { Slot } from "../../slots/SlotRegistry"
import type { SidebarItem } from "../../types"
import type { ShellSidebar } from './ShellSidebar'

function SidebarIcon({ name }: { name: string }) {
  const Icon = getIcon(name)
  return <Icon size={20} />
}
export { SidebarIcon }

function ModuleRootIcon({ moduleId, item }: { moduleId: string; item: SidebarItem }) {
  const entry = WaffleAppRegistry.get(moduleId)
  if (entry) {
    const app = entry.apps.find(a => a.path === item.path) ?? entry.apps[0]
    if (app) return <app.Icon size={20} />
  }
  return <SidebarIcon name={item.icon} />
}
export { ModuleRootIcon }

function SidebarLink({ item, iconOverride }: { item: SidebarItem; iconOverride?: React.ReactNode }) {
  const { closeSidebar } = useUiStore()
  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      onClick={closeSidebar}
      className={({ isActive }) =>
        `group flex items-center gap-3 px-3 py-2 rounded-full text-sm font-medium relative
         transition-all cursor-pointer select-none
         ${isActive
           ? 'bg-primary-light text-text-nav-active'
           : 'text-text-nav hover:bg-surface-2'
         }`
      }
    >
      {({ isActive }) => (
        <>
          <span className={isActive ? 'text-primary' : 'text-text-secondary group-hover:text-text-nav'}>
            {iconOverride ?? <SidebarIcon name={item.icon} />}
          </span>
          <span className="flex-1 truncate">{item.label}</span>
          {item.badge != null && item.badge > 0 && (
            <span className="text-xs bg-danger text-white rounded-full min-w-[18px] h-[18px]
                             flex items-center justify-center px-1 font-medium">
              {item.badge > 99 ? '99+' : item.badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  )
}
export { SidebarLink }

export function Part1({ closeSidebar }: { closeSidebar: NonNullable<ShellSidebar['closeSidebar']> }) {
  return (
    <NavLink
                  to="/"
                  onClick={closeSidebar}
                  className="flex items-center gap-2 px-3 py-2 rounded-full text-sm
                             text-text-secondary hover:bg-surface-2 transition-colors"
                >
                  <ChevronLeft size={16} />
                  <span>Accueil</span>
                </NavLink>
  )
}

export function Part2({ ActiveConfig_SidebarBody }: { ActiveConfig_SidebarBody: NonNullable<NonNullable<ShellSidebar['activeConfig']>['SidebarBody']> }) {
  return (
    <ActiveConfig_SidebarBody />
  )
}

export function Part3({ activeConfig }: { activeConfig: NonNullable<ShellSidebar['activeConfig']> }) {
  const { t } = useTranslation()
  return (
    <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <button
                            className="flex items-center gap-2 px-5 py-2.5 bg-white rounded-2xl text-sm font-medium
                                       text-text-primary border border-border shadow-sm hover:shadow-md
                                       transition-shadow w-full"
                          >
                            <Plus size={18} className="text-text-secondary" />
                            {activeConfig.newButtonLabel ?? t('shell.new')}
                          </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            side="bottom"
                            align="start"
                            sideOffset={4}
                            className="min-w-48 bg-white rounded-[5px] shadow-lg border border-border py-1 z-50"
                          >
                            <Slot
                              name="sidebar-new-actions"
                              fallback={
                                <div className="px-3 py-2 text-xs text-text-tertiary">
                                  {t('shell.no_actions')}
                                </div>
                              }
                            />
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
  )
}
