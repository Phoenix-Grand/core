/**
 * `WaffleButton` - the header's app-launcher button and the popover that carries the `WaffleMenu` user
 * control (contract: vskubuno `docs/SHELL-CONTROLS.md`). The popover is platform chrome, so it lives here,
 * not in the user control: a Radix menu portalled to <body> (never clipped by an ancestor's overflow,
 * transform or stacking context), anchored to the button with flip and clamping to the viewport, closed by
 * Escape and a click outside, the focus going back to the button.
 *
 * It is also the web host of the launcher's data: the apps of the active modules, the favourites of the
 * account (`preferences.waffle_favorites`, cached in localStorage), the launch (SPA navigation to the app's
 * last place) and the save of an edit.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'

import { defineControl } from '@kubuno/views'
import type { WaffleApp } from '../../registry/WaffleAppRegistry'
import { appNavMemory } from '../../store/appNavMemory'
import { useAuthStore } from '../../store/authStore'
import { usePrivileges } from '../../authz/usePrivileges'
import { adminUrl } from '../../../admin/adminAction'
import { PRIV } from '../../authz/types'
import { api } from '../../api/client'
import type { User } from '../../types'
import { MenuItemHostContext, type MenuItemHost } from './menuItemHost'
import type { LauncherApp } from './model'
import { headerPanelChrome } from './panelChrome'
import WaffleMenu from './WaffleMenu'

const FAV_KEY = 'kubuno-waffle-favorites'

/** The favourites kept in the account's preferences. */
function favsFromUser(user: User | null): string[] | null {
  const v = user?.preferences?.waffle_favorites
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
}

/** The local cache (offline, before the profile has loaded). */
function loadFav(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

/** Launching an app returns to the last place visited in it (this tab), else its landing route. */
const launchTarget = (app: WaffleApp) => appNavMemory.get(app.id) ?? app.landing ?? app.path

/** Every tile and link of the launcher is an item of this menu (arrow keys, close on select). */
const asMenuItem: MenuItemHost = (element: ReactElement) => <DropdownMenu.Item asChild>{element}</DropdownMenu.Item>

export interface WaffleButtonProps {
  /** The apps of the active modules (`useWaffleApps`). */
  allApps: WaffleApp[]
  /** Kept for the callers; no longer changes the trigger's size (36px circles everywhere). */
  compact?: boolean
  /** The dark title bars (PaintSharp): light glyph, translucent hover. */
  dark?: boolean
  /** The mobile floating action button variant (bottom-right, opens upwards). */
  fab?: boolean
  onOpenChange?: (open: boolean) => void
}

function WaffleButtonImpl({ allApps, dark = false, fab = false, onOpenChange }: WaffleButtonProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const updateUser = useAuthStore((s) => s.updateUser)
  const { can } = usePrivileges()

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState<string[]>(() => favsFromUser(user) ?? loadFav())

  // Follow the server's preferences (sign-in, session restore, an edit made on another device).
  useEffect(() => {
    const fav = favsFromUser(user)
    if (fav) {
      setSaved(fav)
      localStorage.setItem(FAV_KEY, JSON.stringify(fav))
    }
  }, [user])

  // The launcher's apps; each tile's address is the app's last place, read again at every opening.
  const apps = useMemo<LauncherApp[]>(
    () => allApps.map((a) => ({ id: a.id, label: a.label, Icon: a.Icon, href: launchTarget(a), module: a.moduleId, moduleLabel: a.moduleLabel })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allApps, open],
  )
  const byId = useMemo(() => new Map(allApps.map((a) => [a.id, a])), [allApps])

  const saveFavorites = (favorites: string[]) => {
    setSaved(favorites)
    localStorage.setItem(FAV_KEY, JSON.stringify(favorites))
    api.patch<{ user: User }>('/me', { preferences: { waffle_favorites: favorites } })
      .then(({ data }) => { if (data?.user) updateUser({ preferences: data.user.preferences }) })
      .catch(() => { /* the localStorage cache is the fallback */ })
  }

  const marketplaceHref = adminUrl({ tab: 'marketplace' })

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(v) => { setOpen(v); if (!v) setEditing(false); onOpenChange?.(v) }}
    >
      <DropdownMenu.Trigger asChild>
        {fab ? (
          // The mobile floating action button: bottom-right (placed by the parent), the primary blue FAB.
          <button
            aria-label={t('header.apps')}
            className="w-14 h-14 rounded-2xl bg-primary text-white flex items-center justify-center
                       shadow-[0_4px_14px_rgba(26,115,232,0.45)] active:scale-95 transition-transform focus:outline-none"
          >
            <LayoutGrid size={26} />
          </button>
        ) : (
          <button
            className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors focus:outline-none ${
              dark ? 'text-white/75 hover:bg-white/15 data-[state=open]:bg-white/15' : 'text-text-secondary hover:bg-surface-3 data-[state=open]:bg-surface-3'}`}
            aria-label={t('header.apps')}
          >
            <LayoutGrid size={18} />
          </button>
        )}
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          side={fab ? 'top' : 'bottom'}
          sideOffset={fab ? 10 : 4}
          collisionPadding={{ top: 12, right: 8, bottom: 12, left: 8 }}
          // Escape inside an edit abandons the edit (WaffleMenu's rule); otherwise it closes the menu.
          onEscapeKeyDown={(e) => { if (editing) { e.preventDefault(); setEditing(false) } }}
          onPointerDownOutside={(e) => { if (editing) e.preventDefault() }}
          onFocusOutside={(e) => { if (editing) e.preventDefault() }}
          // Explicit radius: the global scale brings `rounded-2xl` down to 8px, too sharp for this panel.
          className={`w-[360px] max-w-[calc(100vw-16px)] rounded-[28px] z-[9999] overflow-hidden flex flex-col ${fab ? '' : 'border border-border'}`}
          // A fixed 580px cap, never taller than the room Radix has (trigger side + collision padding): the
          // body scrolls instead of « Favoris » being clipped. Editing takes the whole room, so both zones
          // show while dragging.
          style={{
            ...headerPanelChrome,
            maxHeight: editing
              ? 'var(--radix-dropdown-menu-content-available-height, calc(100vh - 80px))'
              : 'min(580px, var(--radix-dropdown-menu-content-available-height, calc(100vh - 80px)))',
          }}
        >
          <MenuItemHostContext.Provider value={asMenuItem}>
            <WaffleMenu
              apps={apps}
              favorites={saved}
              editing={editing}
              showMarketplace={can(PRIV.MARKETPLACE_MANAGE)}
              marketplaceHref={marketplaceHref}
              onEditModeChanged={(e) => setEditing(e.editing)}
              onFavoritesEdited={(e) => saveFavorites(e.favorites)}
              onAppLaunched={(e) => {
                const app = byId.get(e.id)
                if (app) navigate(launchTarget(app))
              }}
              onOpenMarketplace={() => navigate(marketplaceHref)}
              onCloseRequested={() => setOpen(false)}
            />
          </MenuItemHostContext.Provider>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** The header's launcher button (a designable custom control of the core's shell). */
export const WaffleButton = defineControl(WaffleButtonImpl, {
  category: 'Kubuno',
  icon: 'LayoutGrid',
  defaultEvent: 'OnOpenChanged',
  props: {
    Apps: { kind: 'object', bindable: true, prop: 'allApps' },
    Dark: { kind: 'Bool', default: false, prop: 'dark' },
    Fab: { kind: 'Bool', default: false, prop: 'fab' },
  },
  events: { OnOpenChanged: { prop: 'onOpenChange', args: 'ValueChangedEventArgs<boolean>' } },
  children: 'None',
})

export default WaffleButton
