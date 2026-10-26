import { create } from 'zustand'
import { api, registerTokenHandlers, onAccessTokenChanged } from '../api/client'
import { authApi } from '../api/auth'
import { useNotificationStore } from './notificationStore'
import type { User } from '../types'
import type { EffectivePrivileges } from '../authz/types'

/**
 * Per-account feature switches served by `GET /api/v1/me`.
 *
 * These say whether a whole surface EXISTS for this account, as opposed to what
 * it may do inside one - which is what `privileges` answers. The distinction
 * matters because a switched-off feature must leave no trace in the interface:
 * no disabled button, no greyed menu entry, nothing to ask about.
 *
 * They arrive with `/me` rather than being discovered by calling each feature's
 * own route: the answer is needed before the first paint, and a section that
 * appears half a second late reads as a defect.
 */
export interface MeFeatures {
  /**
   * "Download my data" - the self-service data export. Governed by
   * `data_export.self_service`, resolved by the server for THIS account through
   * the scope chain (instance / organisational unit / group / account).
   */
  data_export_self_service?: boolean
}

/** The shape of `GET /api/v1/me`: the account row, and what it may do. */
interface MeResponse {
  user: User
  privileges?: EffectivePrivileges
  features?: MeFeatures
}

// Synchronise le logout entre tous les onglets/fenêtres du même navigateur
// qui partagent la même session (même cookie refresh_token).
const authChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('kubuno-auth')
  : null

/** Root of the module the tab is currently on ('/drive', '/calendar', '/'…). */
const currentModuleRoot = () => '/' + (window.location.pathname.split('/')[1] ?? '')

/**
 * Tells the OTHER tabs the active account changed. The refresh cookie is shared
 * by every tab: a tab left un-reloaded would keep showing account A's interface
 * while silently fetching as account B on its next token refresh - mixed
 * identities, the exact thing the hard reload exists to prevent.
 */
export function announceAccountSwitched() {
  authChannel?.postMessage({ type: 'account-switched' })
}

interface AuthState {
  user: User | null
  accessToken: string | null
  isLoading: boolean
  isInitialized: boolean
  /** Présent uniquement entre la vérification du mot de passe et celle du code TOTP. */
  totpSession: string | null
  /**
   * The caller's own effective privileges, straight from `/me`. `null` means
   * "not loaded yet", never "holds nothing" - an account holding nothing comes
   * back with an empty `privileges` array.
   */
  privileges: EffectivePrivileges | null
  /**
   * The feature switches of `/me`. `null` means "not loaded yet", and every
   * reader treats that as "absent": hiding a section a moment too long is
   * recoverable, showing one the server would refuse is not.
   */
  features: MeFeatures | null
  /**
   * Loads `/me` once. Idempotent, and deduplicated across concurrent callers.
   * `force` re-reads even when a block is already held - what a role write does,
   * since granting or revoking can change what the *operator* themselves may see.
   */
  loadPrivileges: (force?: boolean) => Promise<void>

  login: (email: string, password: string, captcha?: { id: string; answer: string }) => Promise<{ requiresTotp: boolean }>
  /** `kind` says whether the submitted value is a time-based or a backup code. */
  verifyTotp: (code: string, kind?: 'totp' | 'backup') => Promise<void>
  logout: () => Promise<void>
  /**
   * Google-style account switch: makes the account parked in `slot` the active
   * session, then HARD-reloads onto the current module's root. The reload is
   * the isolation guarantee - every store, cache and module state is rebuilt
   * under the new identity, nothing of the previous account can leak through.
   */
  switchAccount: (slot: number) => Promise<void>
  /** « Se déconnecter de tous les comptes » : closes every slot of this browser. */
  logoutAll: () => Promise<void>
  refreshToken: () => Promise<void>
  updateUser: (updates: Partial<User>) => void
  initialize: () => Promise<void>
  setToken: (token: string) => void
}

// In-flight `/me` call, so the several components that mount at once and all ask
// for the privileges produce a single request.
let privilegesInFlight: Promise<void> | null = null

export const useAuthStore = create<AuthState>((set, get) => {
  // Enregistrer les callbacks pour l'API client (pas de cycle d'import)
  registerTokenHandlers(
    () => get().accessToken,
    (t) => { set({ accessToken: t }) },
    () => {
      // Session expirée via l'intercepteur Axios → notifier les autres onglets
      set({ accessToken: null, user: null, privileges: null, features: null })
      onAccessTokenChanged()
      useNotificationStore.getState().setActiveUser(null)
      authChannel?.postMessage({ type: 'logout' })
    }
  )

  // Écouter les événements des autres onglets (même navigateur, même session)
  if (authChannel) {
    authChannel.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data?.type === 'logout') {
        set({ user: null, accessToken: null, privileges: null, features: null })
        onAccessTokenChanged()
      }
      // Un AUTRE onglet a basculé de compte : le cookie actif ne correspond
      // plus à l'identité affichée ici → rechargement immédiat sur la racine
      // du module (le deep-link courant appartient à l'ancien compte).
      if (event.data?.type === 'account-switched') {
        window.location.href = currentModuleRoot()
      }
    }
  }

  return {
    user: null,
    accessToken: null,
    isLoading: false,
    isInitialized: false,
    totpSession: null,
    privileges: null,
    features: null,

    setToken: (token) => set({ accessToken: token }),

    // `initialize()` already reads `/me` and keeps the block it returns, so a page
    // load costs nothing extra. This covers the paths that obtain a user without
    // going through it - signing in, and the OAuth callback.
    loadPrivileges: async (force = false) => {
      if (!force && get().privileges) return
      if (force || !privilegesInFlight) {
        const call: Promise<void> = api
          .get<MeResponse>('/me')
          .then(({ data }) => { set({ user: data.user, privileges: data.privileges ?? null, features: data.features ?? null }) })
          .catch(() => { /* a network failure is not a verdict: retried on the next mount */ })
          .finally(() => { if (privilegesInFlight === call) privilegesInFlight = null })
        privilegesInFlight = call
      }
      await privilegesInFlight
    },

    login: async (login, password, captcha) => {
      set({ isLoading: true })
      try {
        const { data } = await authApi.login({
          login,
          password,
          device_name: navigator.userAgent.slice(0, 255),
          // Sent only once the sign-in gate has demanded a CAPTCHA.
          ...(captcha ? { captcha_id: captcha.id, captcha_answer: captcha.answer } : {}),
        })
        if ('requires_totp' in data && data.requires_totp) {
          set({ totpSession: data.totp_session })
          return { requiresTotp: true }
        }
        // A new session belongs to a new subject: whatever was resolved for the
        // previous one must not survive into it.
        set({ user: (data as { access_token: string; user: User }).user, accessToken: (data as { access_token: string; user: User }).access_token, privileges: null, features: null })
        onAccessTokenChanged()
        useNotificationStore.getState().setActiveUser((data as { access_token: string; user: User }).user.id)
        return { requiresTotp: false }
      } finally {
        set({ isLoading: false })
      }
    },

    verifyTotp: async (code, kind = 'totp') => {
      const { totpSession } = get()
      if (!totpSession) throw new Error('No TOTP session in progress')
      set({ isLoading: true })
      try {
        const payload = kind === 'backup'
          ? { backup_code: code, totp_session: totpSession }
          : { code, totp_session: totpSession }
        const { data } = await authApi.totpVerify(payload)
        set({ user: data.user, accessToken: data.access_token, totpSession: null, privileges: null, features: null })
        onAccessTokenChanged()
        useNotificationStore.getState().setActiveUser(data.user.id)
      } finally {
        set({ isLoading: false })
      }
    },

    logout: async () => {
      try {
        await authApi.logout()
      } catch {
        // Ignorer les erreurs réseau au logout
      }
      set({ user: null, accessToken: null, privileges: null, features: null })
      onAccessTokenChanged()
      useNotificationStore.getState().setActiveUser(null)
      // Déconnecter tous les autres onglets du même navigateur
      authChannel?.postMessage({ type: 'logout' })
    },

    switchAccount: async (slot) => {
      // The server re-points the HttpOnly refresh cookie at the slot; the
      // response is only a success signal - the hard reload below re-runs
      // `initialize()` which picks the new session up from the cookie.
      await authApi.switchAccount(slot)
      // The other tabs share the cookie: they must reload too.
      announceAccountSwitched()
      // Land on the CURRENT module's root, not the current URL: a deep link
      // (file id, folder, mail thread) belongs to the previous account and
      // would 404 under the new one. Same behaviour as Google products.
      window.location.href = currentModuleRoot()
    },

    logoutAll: async () => {
      try {
        await authApi.logout({ all: true })
      } catch {
        // Ignorer les erreurs réseau au logout
      }
      set({ user: null, accessToken: null, privileges: null, features: null })
      onAccessTokenChanged()
      useNotificationStore.getState().setActiveUser(null)
      authChannel?.postMessage({ type: 'logout' })
    },

    refreshToken: async () => {
      const { data } = await authApi.refresh()
      set({ accessToken: data.access_token })
      onAccessTokenChanged()
    },

    updateUser: (updates) =>
      set((state) => ({
        user: state.user ? { ...state.user, ...updates } : null,
      })),

    initialize: async () => {
      set({ isLoading: true })
      try {
        await get().refreshToken()
        const { data } = await api.get<MeResponse>('/me')
        set({ user: data.user, privileges: data.privileges ?? null, features: data.features ?? null })
        // Notifications are compartmented PER ACCOUNT: only now that the
        // session's identity is known may the bell read (and file into) the
        // right bucket - never another account's.
        useNotificationStore.getState().setActiveUser(data.user.id)
      } catch {
        set({ user: null, accessToken: null, privileges: null, features: null })
        onAccessTokenChanged()
      } finally {
        set({ isLoading: false, isInitialized: true })
      }
    },
  }
})

/**
 * One feature switch of `/me`, as a boolean.
 *
 * Strictly `=== true`: "not loaded yet" and "the server said nothing about it"
 * both read as absent, which is the safe direction for a switch whose job is to
 * make a surface disappear.
 */
export function useFeature(name: keyof MeFeatures): boolean {
  return useAuthStore((s) => s.features?.[name] === true)
}
