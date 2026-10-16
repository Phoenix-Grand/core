/**
 * `AccountButton` - the header's avatar button and the popover that carries the `AccountMenu` user control
 * (contract: vskubuno `docs/SHELL-CONTROLS.md`). The popover is platform chrome, kept out of the user
 * control: portalled to <body> above the page (never clipped by an ancestor's overflow, transform or stacking
 * context), anchored to the button's bottom-end corner, flipped above it when there is more room there and
 * clamped to the viewport, closed by Escape and a click outside, the focus going back to the button.
 *
 * It is also the web host of the panel's data and actions: the account, the accounts signed into this
 * browser (`GET /auth/accounts`, read at every opening), the accounts of other instances, each account's
 * unread count, the photo crop/upload, switching, removing, signing out and navigating.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import * as Avatar from '@radix-ui/react-avatar'

import { defineControl } from '@kubuno/views'
import AvatarCropModal, { type AvatarCrop } from '@ui/AvatarCropModal'
import { useAuthStore } from '../../store/authStore'
import { useNotificationStore, unreadCountOf } from '../../store/notificationStore'
import { usePrivileges } from '../../authz/usePrivileges'
import { useLinkedAccountsStore } from '../../store/linkedAccountsStore'
import { api } from '../../api/client'
import { authApi, type BrowserAccount } from '../../api/auth'
import { initialsOf, type AccountEntry, type AccountEventArgs, type AccountUser } from './model'
import AccountMenu from './AccountMenu'
import { headerPanelChrome } from './panelChrome'

/** The panel's width (`w-80`) and its distance to the viewport's edges. */
const WIDTH = 320
const MARGIN = 8
/** Between the button and the panel (the launcher's Radix `sideOffset`). */
const GAP = 4

interface Placement {
  top: number
  left: number
  maxHeight: number
}

/**
 * Where the panel goes: under the button, its end edge on the button's end edge, clamped to the viewport;
 * above the button when the room under it is too short and the room above larger. Its height is capped by
 * the room on its side (and, as always, by the viewport less the header).
 */
export function placePanel(anchor: DOMRect, height: number, vw: number, vh: number, rtl: boolean): Placement {
  const below = vh - (anchor.bottom + GAP) - MARGIN
  const above = anchor.top - GAP - MARGIN
  const flip = height > below && above > below
  const room = flip ? above : below
  const maxHeight = Math.max(0, Math.min(vh - 70, room))
  const shown = Math.min(height, maxHeight)
  const top = flip ? anchor.top - GAP - shown : anchor.bottom + GAP
  let left = rtl ? anchor.left : anchor.right - WIDTH
  left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - WIDTH - MARGIN))
  return { top, left, maxHeight }
}

export interface AccountButtonProps {
  /** Opens the add-account dialog; `prefill` reconnects a « Déconnecté » row. */
  onAddAccount?: (prefill?: { email: string; slot: number }) => void
}

function AccountButtonImpl({ onAddAccount }: AccountButtonProps) {
  const navigate = useNavigate()
  const { user, logout, logoutAll, switchAccount, updateUser } = useAuthStore()
  const { isAdmin } = usePrivileges()
  const { accounts: remoteAccounts, remove: removeRemote } = useLinkedAccountsStore()
  // Each row shows ITS account's unread count (last known while that account was active).
  const notifByUser = useNotificationStore((s) => s.byUser)
  const dropNotifUser = useNotificationStore((s) => s.dropUser)

  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<Placement | null>(null)
  const [browserAccounts, setBrowserAccounts] = useState<BrowserAccount[]>([])
  const [switching, setSwitching] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [cropOpen, setCropOpen] = useState(false)

  const close = useCallback((refocus = true) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus({ preventScroll: true })
  }, [])

  // The cookie jar is the roster: read it again every time the panel opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    authApi.accounts()
      .then(({ data }) => { if (!cancelled) setBrowserAccounts(data.accounts) })
      .catch(() => { /* the panel still renders without the list */ })
    return () => { cancelled = true }
  }, [open])

  // Escape closes (not while the crop dialog, portalled outside the panel, is open).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !cropOpen) close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, cropOpen, close])

  // Anchored to the button, measured again whenever the panel, the window or an ancestor changes.
  useLayoutEffect(() => {
    if (!open) { setPlace(null); return }
    const update = () => {
      const a = buttonRef.current
      const p = panelRef.current
      if (!a) return
      const rtl = getComputedStyle(a).direction === 'rtl'
      const height = p ? p.scrollHeight : 0
      setPlace(placePanel(a.getBoundingClientRect(), height, window.innerWidth, window.innerHeight, rtl))
    }
    update()
    const ro = new ResizeObserver(update)
    if (panelRef.current) ro.observe(panelRef.current)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  const others = useMemo(() => browserAccounts.filter((a) => !a.active), [browserAccounts])

  const menuUser = useMemo<AccountUser | undefined>(() => user ? {
    name: user.display_name ?? user.username,
    email: user.email,
    initials: user.display_name ? initialsOf(user.display_name) : user.username.slice(0, 2).toUpperCase(),
    avatar: user.avatar_url ?? undefined,
  } : undefined, [user])

  const accounts = useMemo<AccountEntry[]>(() => [
    ...others.map((a) => {
      const name = a.user.display_name ?? a.user.email
      return {
        id: String(a.slot), name, email: a.user.email, server: window.location.hostname, initials: initialsOf(name),
        avatar: a.user.avatar_url ?? undefined, connected: a.connected, unread: unreadCountOf(notifByUser, a.user.id),
      }
    }),
    // Accounts living on ANOTHER Kubuno instance: opened in a new tab (another server cannot share this session).
    ...remoteAccounts.map((a) => {
      const name = a.display_name ?? a.email
      let host = a.instance_url
      try { host = new URL(a.instance_url).hostname } catch { /* keep the address */ }
      return { id: a.id, name, email: a.email, server: host, initials: initialsOf(name), avatar: a.avatar_url ?? undefined, connected: true, remote: true }
    }),
  ], [others, remoteAccounts, notifByUser])

  if (!user) return null

  const initials = menuUser?.initials ?? '?'

  // The crop confirmed: upload the cropped blob (and the original when newly imported), keep the crop.
  const handleCropSave = async (blob: Blob, original: File | null, crop: AvatarCrop) => {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('avatar', blob, 'avatar.jpg')
      if (original) fd.append('original', original, original.name || 'original')
      const res = await api.post<{ user: typeof user }>('/me/avatar', fd)
      const pr = await api.patch<{ user: typeof user }>('/me', { preferences: { avatar_crop: crop } })
      // Cache-bust: the same avatar URL must be fetched again at once.
      const url = res.data.user.avatar_url
      updateUser({ avatar_url: url ? `${url.split('?')[0]}?v=${Date.now()}` : null, preferences: pr.data.user.preferences })
      setCropOpen(false)
    } catch {
      // silently ignored, as before
    } finally {
      setUploading(false)
    }
  }

  const go = (path: string) => { close(false); navigate(path) }

  const signOut = async () => {
    close(false)
    if (others.length > 0) await logoutAll()
    else await logout()
    navigate('/login')
  }

  const openAccount = async (id: string) => {
    const remote = remoteAccounts.find((a) => a.id === id)
    if (remote) { window.open(remote.instance_url, '_blank', 'noopener,noreferrer'); return }
    const account = browserAccounts.find((a) => String(a.slot) === id)
    if (!account) return
    if (!account.connected) {
      // « Connexion » on a dead session: the add-account dialog, pre-filled.
      close(false)
      onAddAccount?.({ email: account.user.email, slot: account.slot })
      return
    }
    if (switching) return
    setSwitching(true)
    try {
      await switchAccount(account.slot) // reloads the page on success
    } catch {
      // The session died since the list was read: the row becomes « Déconnecté ».
      setBrowserAccounts((prev) => prev.map((a) => (a.slot === account.slot ? { ...a, connected: false } : a)))
      setSwitching(false)
    }
  }

  const removeAccount = async (id: string) => {
    if (remoteAccounts.some((a) => a.id === id)) { removeRemote(id); return }
    const slot = Number(id)
    try { await authApi.logout({ slot }) } catch { /* best effort */ }
    const removed = browserAccounts.find((a) => a.slot === slot)
    if (removed) dropNotifUser(removed.user.id)
    setBrowserAccounts((prev) => prev.filter((a) => a.slot !== slot))
  }

  const panelStyle: CSSProperties = {
    ...headerPanelChrome,
    top: place?.top ?? 0,
    left: place?.left ?? 0,
    maxHeight: place?.maxHeight ?? 'calc(100vh - 70px)',
    // Measured before it shows: no flash at the wrong place.
    visibility: place ? 'visible' : 'hidden',
  }

  return (
    <>
      {/* Same template as the header's other icons (36px circles everywhere). */}
      <button
        ref={buttonRef}
        onClick={() => (open ? close(false) : setOpen(true))}
        className="w-9 h-9 ml-0.5 flex items-center justify-center flex-shrink-0 rounded-full outline-none focus:outline-none"
      >
        <Avatar.Root className="w-9 h-9 rounded-full overflow-hidden bg-primary flex items-center justify-center">
          {user.avatar_url ? (
            <Avatar.Image src={user.avatar_url} alt={user.display_name ?? user.username} className="w-full h-full object-cover" />
          ) : null}
          <Avatar.Fallback className="text-white font-medium text-sm">{initials}</Avatar.Fallback>
        </Avatar.Root>
      </button>

      {open && createPortal(
        <>
          {/* A click outside closes (the backdrop takes it, as the panel always did). */}
          <div className="fixed inset-0 z-[9990]" onClick={() => close()} />
          {/* The panel - the launcher's visual language: the tinted ground, 28px radius (explicit: the global
              radius scale flattens rounded-2xl to 8px), the same elevation, white cards on the tint. */}
          <div
            ref={panelRef}
            className="fixed z-[9991] w-80 rounded-[28px] overflow-hidden border border-border flex flex-col"
            style={panelStyle}
          >
            <AccountMenu
              user={menuUser}
              accounts={accounts}
              showAdmin={isAdmin}
              busy={switching}
              avatarBusy={uploading}
              manageHref="/settings"
              labelsHref="/labels"
              adminHref="/admin"
              onManageAccount={() => go('/settings')}
              onOpenLabels={() => go('/labels')}
              onOpenAdmin={() => go('/admin')}
              onAddAccount={() => { close(false); onAddAccount?.() }}
              onOpenAccount={(e: AccountEventArgs) => { void openAccount(e.id) }}
              onRemoveAccount={(e: AccountEventArgs) => { void removeAccount(e.id) }}
              onSignOut={() => { void signOut() }}
              onChangeAvatar={() => setCropOpen(true)}
              onCloseRequested={() => close()}
            />
          </div>
          {cropOpen && (
            <AvatarCropModal
              initialSrc={user.avatar_url ? `/api/v1/users/${user.id}/avatar/original?v=${Date.now()}` : null}
              initialCrop={(user.preferences?.avatar_crop as AvatarCrop) ?? null}
              saving={uploading}
              onCancel={() => setCropOpen(false)}
              onSave={handleCropSave}
            />
          )}
        </>,
        document.body,
      )}
    </>
  )
}

/** The header's account button (a designable custom control of the core's shell). */
export const AccountButton = defineControl(AccountButtonImpl, {
  category: 'Kubuno',
  icon: 'CircleUser',
  defaultEvent: 'OnAddAccount',
  props: {},
  events: { OnAddAccount: { prop: 'onAddAccount', args: 'EventArgs' } },
  children: 'None',
})

export default AccountButton
