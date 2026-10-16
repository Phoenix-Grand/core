import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Key, Shield, User, Laptop, Bell, Palette, Download, HardDriveDownload, type LucideIcon } from 'lucide-react'
import { useSidebarStore } from '../store/sidebarStore'
import { useAuthStore, type MeFeatures } from '../store/authStore'
export type Tab = 'profile' | 'notifications' | 'themes' | 'clients' | 'security' | 'sessions' | 'api-tokens' | 'my-data'

export interface NavItem {
  id: Tab
  labelKey: string
  defaultLabel: string
  Icon: LucideIcon
  /**
   * Feature switch of `/me` this section depends on. A section carrying one does
   * not exist for an account the switch is off for: it is absent from the panel,
   * from the mobile index and from the page - never present and disabled. A
   * greyed control is an invitation to ask why; an absent one is an answer.
   */
  feature?: keyof MeFeatures
}

export const SETTINGS_NAV: NavItem[] = [
  { id: 'profile',       labelKey: 'settings.tab_profile',       defaultLabel: 'Profile',       Icon: User },
  { id: 'notifications', labelKey: 'settings.tab_notifications', defaultLabel: 'Notifications', Icon: Bell },
  { id: 'themes',        labelKey: 'settings.tab_themes',        defaultLabel: 'Thèmes',        Icon: Palette },
  { id: 'clients',       labelKey: 'settings.tab_clients',       defaultLabel: 'Clients',       Icon: Download },
  { id: 'security',      labelKey: 'settings.tab_security',      defaultLabel: 'Sécurité',      Icon: Shield },
  { id: 'sessions',      labelKey: 'settings.tab_sessions',      defaultLabel: 'Sessions',      Icon: Laptop },
  { id: 'api-tokens',    labelKey: 'settings.tab_api',           defaultLabel: 'API tokens',    Icon: Key },
  { id: 'my-data',       labelKey: 'settings.tab_my_data',       defaultLabel: 'Télécharger mes données',
    Icon: HardDriveDownload, feature: 'data_export_self_service' },
]

/**
 * The sections this account actually has, in paint order.
 *
 * The single source the three consumers share - panel, mobile index and page
 * title. Filtering in one place is what makes "the function disappears" true
 * rather than true in two places out of three.
 */
export function useSettingsNav(): NavItem[] {
  const features = useAuthStore((s) => s.features)
  return useMemo(
    () => SETTINGS_NAV.filter((item) => !item.feature || features?.[item.feature] === true),
    [features],
  )
}

// Rendered inside AppSidebar as the left panel while on /settings (replaces the
// module navigation). Tab selection is URL-driven (?tab=) so panel and content
// stay in sync. `collapsed` → icons only, to match the rest of the shell.
function SettingsSidebar({ collapsed }: { collapsed?: boolean }) {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const active = (params.get('tab') as Tab) || 'profile'
  const nav = useSettingsNav()
  return (
    <nav className={`flex-1 space-y-0.5 ${collapsed ? 'px-2' : 'px-3'}`}>
      {/* Panel section title: 14px bold, no forced caps and no letter-spacing. */}
      {!collapsed && (
        <p className="px-3 pt-1 pb-2 text-sm font-bold text-text-secondary">
          {t('settings.page_title')}
        </p>
      )}
      {nav.map(({ id, labelKey, defaultLabel, Icon }) => {
        const label = t(labelKey, { defaultValue: defaultLabel })
        return (
          <button
            key={id}
            type="button"
            onClick={() => navigate(`/settings?tab=${id}`)}
            title={collapsed ? label : undefined}
            className={`w-full flex items-center gap-3 rounded-lg text-sm transition-colors ${
              collapsed ? 'justify-center py-2.5' : 'px-3 py-2'} ${
              active === id ? 'bg-primary-light text-primary font-medium' : 'text-text-secondary hover:bg-surface-2'}`}
          >
            <Icon size={18} className="shrink-0" />
            {!collapsed && label}
          </button>
        )
      })}
    </nav>
  )
}

// Override the left panel on /settings (registered once at module load; resolves
// only when the route is /settings, so it is inert elsewhere).
useSidebarStore.getState().register({
  moduleId:      'core-settings',
  routePrefix:   '/settings',
  SidebarBody:   SettingsSidebar,
  collapsedBody: true,
})
