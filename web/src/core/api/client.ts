import axios, { type AxiosError } from 'axios'
import { requestReauth } from '../store/reauthStore'
import { invalidatePublicConfig } from './publicConfig'
import { clearSignedUrlCache } from './signedUrl'

export const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true, // pour le cookie refresh_token
})

// Injecte le Bearer token depuis le store
api.interceptors.request.use((config) => {
  // Import dynamique pour éviter la dépendance circulaire
  const token = getAccessToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Refresh token automatique sur 401
let isRefreshing = false
let refreshQueue: Array<(token: string) => void> = []

api.interceptors.response.use(
  (response) => {
    // If the server returned HTML instead of JSON, the module isn't running.
    const ct = String(response.headers['content-type'] ?? '')
    if (ct.includes('text/html') && response.config.url && !response.config.url.includes('/auth/')) {
      return Promise.reject({ message: 'Module non disponible (service inactif)', code: 'MODULE_UNAVAILABLE' })
    }
    // A settings write may have changed a PUBLIC setting (instance name, logo,
    // theme, idle timeout…), which `getPublicConfig` holds a short-lived copy
    // of. Dropping that copy here rather than in each panel is what keeps the
    // console truthful: a panel added later cannot forget to do it, and the
    // next read goes back to the server instead of repainting a stale value.
    const method = String(response.config.method ?? '').toLowerCase()
    const url    = String(response.config.url ?? '')
    if (method !== 'get' && /(^|\/)(admin\/)?settings/.test(url)) {
      invalidatePublicConfig()
    }
    return response
  },
  async (error: AxiosError) => {
    const original = error.config!

    // ── Instance pas encore installée ───────────────────────────────────────
    // Avant la toute première installation, le core ne sert que l'assistant : il
    // répond 503 { setup_required } à tout le reste de l'API. On y va, plutôt
    // que d'afficher une erreur incompréhensible sur une instance neuve. Rien
    // n'est interrogé en plus au démarrage : c'est le premier appel d'API qui
    // nous l'apprend.
    if (
      error.response?.status === 503 &&
      (error.response?.data as { setup_required?: boolean } | undefined)?.setup_required &&
      // Tout le parcours d'installation, pas seulement sa première page : une
      // étape porte son propre chemin (/setup/database…), et une comparaison
      // stricte renvoyait l'assistant à l'accueil au moindre appel d'API - ce
      // qui vidait l'étape en cours à chaque rechargement.
      !window.location.pathname.startsWith('/setup')
    ) {
      window.location.replace('/setup')
      return new Promise(() => {})   // la navigation est en cours : ne pas rejeter
    }

    // ── Réauthentification avant action sensible ────────────────────────────
    // Le core refuse par un 403 PORTEUR D'UN CODE (`REAUTH_REQUIRED`) - c'est ce
    // qui distingue ce refus d'un « accès refusé » ordinaire et permet de
    // proposer le bon écran plutôt que d'échouer sans recours. On obtient une
    // preuve fraîche, puis on rejoue la requête telle quelle.
    //
    // Volontairement un 403 et non un 401 : un 401 déclencherait la branche de
    // renouvellement ci-dessous, or re-signer un jeton d'accès n'est justement
    // PAS ce qui manque ici.
    const code = (error.response?.data as { error?: string } | undefined)?.error
    if (
      error.response?.status === 403 &&
      code === 'REAUTH_REQUIRED' &&
      !(original as { _reauth?: boolean })._reauth
    ) {
      ;(original as { _reauth?: boolean })._reauth = true
      const proof = await requestReauth()
      if (!proof) return Promise.reject(normalizeError(error))
      original.headers['X-Reauth-Token'] = proof
      return api(original)
    }

    // Ne pas retenter sur l'endpoint de refresh lui-même (évite la boucle infinie)
    const isRefreshEndpoint = original.url?.includes('/auth/refresh')
    if (error.response?.status !== 401 || (original as { _retry?: boolean })._retry || isRefreshEndpoint) {
      return Promise.reject(normalizeError(error))
    }

    ;(original as { _retry?: boolean })._retry = true

    if (isRefreshing) {
      return new Promise((resolve) => {
        refreshQueue.push((token: string) => {
          original.headers.Authorization = `Bearer ${token}`
          resolve(api(original))
        })
      })
    }

    isRefreshing = true
    try {
      const { data } = await axios.post('/api/v1/auth/refresh', {}, { withCredentials: true })
      const newToken: string = data.access_token
      setAccessToken(newToken)
      refreshQueue.forEach((cb) => cb(newToken))
      refreshQueue = []
      original.headers.Authorization = `Bearer ${newToken}`
      return api(original)
    } catch {
      refreshQueue = []
      clearAccessToken()
      // Pas de window.location.href ici : React Router gère la redirection
      // via ProtectedRoute → <Navigate to="/login" /> quand user === null
      return Promise.reject(error)
    } finally {
      isRefreshing = false
    }
  }
)

function normalizeError(error: AxiosError): { message: string; code: string } {
  const data = error.response?.data as { message?: string; error?: string } | undefined
  return {
    message: data?.message ?? error.message ?? 'Erreur inconnue',
    code: data?.error ?? 'UNKNOWN',
  }
}

// Callbacks pour lire/écrire le token sans créer de cycle d'import
let _getToken: (() => string | null) = () => null
let _setToken: ((t: string) => void) = () => {}
let _clearToken: (() => void) = () => {}

export function registerTokenHandlers(
  get: () => string | null,
  set: (t: string) => void,
  clear: () => void
) {
  _getToken = get
  _setToken = set
  _clearToken = clear
}

/**
 * Called whenever the access token changes hands (sign-in, refresh, switch,
 * sign-out).
 *
 * The access token is NEVER written to a cookie any more: a script-readable
 * cookie handed the whole API to any XSS. Requests the browser makes without
 * the `Authorization` header (`<img>`, `<video>`, downloads, sockets) use
 * signed tickets instead (`./signedUrl`). This only erases the cookie older
 * versions of this client wrote, and forgets the tickets cached for the
 * previous account.
 */
export function onAccessTokenChanged(): void {
  document.cookie = 'access_token=; path=/; SameSite=Strict; max-age=0'
  clearSignedUrlCache()
}

function getAccessToken() { return _getToken() }

/** Whether a session access token is held (false on anonymous public pages). */
export function hasAccessToken(): boolean { return !!_getToken() }
function setAccessToken(t: string) { _setToken(t) }
function clearAccessToken() { _clearToken(); onAccessTokenChanged() }
