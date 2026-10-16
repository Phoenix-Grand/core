import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export interface AppNotification {
  id: string
  title: string
  body: string
  moduleId: string
  icon?: string
  read: boolean
  createdAt: string
  link?: string
  /**
   * Stable identity of the THING being announced (an alert id, a job id…), as
   * opposed to `id` which identifies this notification row.
   *
   * It exists because a producer that polls - the alert centre does - would
   * otherwise re-announce the same open alert on every refresh, and a bell that
   * cries the same news every minute is a bell people silence. See `pushKeyed`.
   */
  key?: string
}

interface NotificationState {
  /**
   * Bucket key of the ACTIVE account (its user id), announced by the auth
   * store once the session's identity is known. Until then every mutator is a
   * no-op: nothing may be filed under the wrong account.
   */
  activeUserId: string | null
  /**
   * One notification list PER ACCOUNT of this browser (Google-style
   * multi-account). The compartments are both the isolation - a switched-in
   * account only ever sees its own bucket - and the per-row badges of the
   * account panel, which read the OTHER buckets' unread counts.
   */
  byUser: Record<string, AppNotification[]>
  /** Mirror of `byUser[activeUserId]` so existing consumers keep their selectors. */
  notifications: AppNotification[]
  unreadCount: number

  /** Called by the auth store when the session's identity is (re)established. */
  setActiveUser: (userId: string | null) => void
  /** Forgets an account's bucket (its row was removed from the browser). */
  dropUser: (userId: string) => void

  push: (n: Omit<AppNotification, 'id' | 'read' | 'createdAt'>) => void
  /**
   * Announces something at most once. Returns silently when a notification
   * already carries `key`, whether it has been read or not: "already told you"
   * includes "told you and you dismissed it".
   */
  pushKeyed: (key: string, n: Omit<AppNotification, 'id' | 'read' | 'createdAt' | 'key'>) => void
  markRead: (id: string) => void
  markAllRead: () => void
  clear: () => void
}

function computeUnread(notifications: AppNotification[]): number {
  return notifications.filter(n => !n.read).length
}

/** Unread count of ONE account's bucket - the panel's per-row badge. */
export function unreadCountOf(byUser: Record<string, AppNotification[]>, userId: string): number {
  return computeUnread(byUser[userId] ?? [])
}

/**
 * Identifier for one notification row.
 *
 * `crypto.randomUUID` is undefined outside a secure context (a LAN instance
 * reached over plain HTTP), and reading it there throws - which would take the
 * whole header down with it. The fallback is not cryptographic and does not need
 * to be: this is a list key.
 */
function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Newest first, capped per account - the cap is what keeps storage bounded. */
const MAX_NOTIFICATIONS = 50

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set, get) => {
      /** Rewrites the active bucket and refreshes the mirrors. */
      const setActiveBucket = (updated: AppNotification[]) => {
        const { activeUserId, byUser } = get()
        if (!activeUserId) return
        set({
          byUser: { ...byUser, [activeUserId]: updated },
          notifications: updated,
          unreadCount: computeUnread(updated),
        })
      }

      return {
        activeUserId: null,
        byUser: {},
        notifications: [],
        unreadCount: 0,

        setActiveUser: (userId) => {
          const bucket = userId ? (get().byUser[userId] ?? []) : []
          set({
            activeUserId: userId,
            notifications: bucket,
            unreadCount: computeUnread(bucket),
          })
        },

        dropUser: (userId) =>
          set((state) => {
            const byUser = { ...state.byUser }
            delete byUser[userId]
            return { byUser }
          }),

        push: (n) => {
          const notification: AppNotification = {
            ...n,
            id: uid(),
            read: false,
            createdAt: new Date().toISOString(),
          }
          setActiveBucket([notification, ...get().notifications].slice(0, MAX_NOTIFICATIONS))
        },

        pushKeyed: (key, n) => {
          const current = get().notifications
          if (current.some(existing => existing.key === key)) return
          const notification: AppNotification = {
            ...n,
            key,
            id: uid(),
            read: false,
            createdAt: new Date().toISOString(),
          }
          setActiveBucket([notification, ...current].slice(0, MAX_NOTIFICATIONS))
        },

        markRead: (id) =>
          setActiveBucket(get().notifications.map(n => (n.id === id ? { ...n, read: true } : n))),

        markAllRead: () =>
          setActiveBucket(get().notifications.map(n => ({ ...n, read: true }))),

        clear: () => setActiveBucket([]),
      }
    },
    {
      name: 'kubuno-notifications',
      // localStorage, not sessionStorage: the per-account badges of the panel
      // must survive the hard reload a switch performs, and be shared by every
      // tab - a bucket is only ever READ for a non-active account anyway.
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ byUser: state.byUser }),
      // The mirrors are rebuilt when the auth store announces the identity;
      // nothing to recompute here (activeUserId is never persisted).
    }
  )
)
