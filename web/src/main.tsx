import { StrictMode } from 'react'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactRouterDom from 'react-router-dom'
import { BrowserRouter } from 'react-router-dom'
import * as TanstackReactQuery from '@tanstack/react-query'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as Zustand from 'zustand'
import * as ReactI18next from 'react-i18next'
import * as I18next from 'i18next'
import { useAuthStore } from './core/store/authStore'

// ── Shim `require` global pour les bundles de modules (chargés à l'exécution) ──
// Une dépendance CJS bundlée dans un module (ex. use-sync-external-store tiré par
// @react-three) fait `require("react")`. Avec react EXTERNAL, le helper require de
// rolldown lève « Calling require for react in an environment that doesn't expose
// require » → le chunk plante → vite:preloadError → boucle de rechargement.
// Le helper rolldown utilise `globalThis.require` s'il existe : on le fournit, mappé
// sur les instances UNIQUES du host (mêmes que celles résolues par l'import map).
{
  const shared: Record<string, unknown> = {
    'react': React,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOM,
    'react/jsx-runtime': ReactJsxRuntime,
    'react/jsx-dev-runtime': ReactJsxRuntime,
    'react-router-dom': ReactRouterDom,
    '@tanstack/react-query': TanstackReactQuery,
    'zustand': Zustand,
    'react-i18next': ReactI18next,
    'i18next': I18next,
  }
  const g = globalThis as unknown as { require?: (id: string) => unknown }
  if (typeof g.require === 'undefined') {
    g.require = (id: string) => {
      if (id in shared) return shared[id]
      throw new Error(`require("${id}") indisponible dans le navigateur`)
    }
  }
}
import { useModulesStore } from './core/store/modulesStore'
import { useWsStore } from './core/store/wsStore'
import { useThemeStore } from './core/store/themeStore'
import './core/i18n'
import './core/i18n/nav'
import './core/widgets/coreWidgets'
import { installDefaultMentionSource, installDirectoryMentions } from './core/registry/MentionRegistry'
import { applyUserLanguage, syncInstanceLanguage } from './core/i18n'
// The .kbview runtime's host side (components, icons, {Res} through i18next).
import './core/viewsHost'
import App from './App'
import './index.css'

// Robustesse déploiement : après une mise à jour, les chunks lazy (hash changé)
// référencés par un onglet déjà ouvert renvoient 404 → tout `import()` dynamique
// (ex. ouverture d'un fichier kb*** via FileTypeRegistry → `import('./api')`)
// échoue silencieusement. On recharge UNE fois pour récupérer le nouveau manifest.
// Garde anti-boucle via sessionStorage, réinitialisée à chaque chargement réussi.
const RELOAD_AT = 'kb_chunk_reload_at'
function handleChunkError() {
  // Garde anti-boucle robuste : au plus un rechargement par 30 s. Si l'erreur
  // PERSISTE après rechargement (chunk définitivement cassé, pas juste périmé),
  // on n'entre PAS dans une boucle infinie - on laisse l'erreur visible.
  const last = Number(sessionStorage.getItem(RELOAD_AT) || 0)
  if (Date.now() - last < 30_000) return
  sessionStorage.setItem(RELOAD_AT, String(Date.now()))
  window.location.reload()
}
window.addEventListener('vite:preloadError', (e) => { e.preventDefault(); handleChunkError() })
window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e.reason && (e.reason.message || e.reason)) || '')
  if (/dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError/i.test(msg)) {
    handleChunkError()
  }
})

// Langue d'instance : lue sur /api/v1/config (réglage public), appliquée
// seulement si ni l'utilisateur ni son compte n'ont décidé. Lancée ici, sans
// attente, pour que la page de connexion - servie AVANT toute authentification -
// s'y conforme dès qu'elle a la réponse.
void syncInstanceLanguage()

// Bridge the @ui mention fields to the host provider registry ('mentions.provider').
// Modules (contacts, mail…) register their provider; fields with no explicit
// `providers` discover them through this source. Idempotent, side-effect free.
installDefaultMentionSource()
// And the core's own people, so `@` always has something to offer: an instance
// without a contacts module still has colleagues.
installDirectoryMentions()

const queryClient = new QueryClient({
  defaultOptions: {
    // `gcTime` 60 s (défaut TanStack = 5 min) : une fois une requête sans
    // observateur (page quittée), ses données - p.ex. un listing de dossier
    // drive de plusieurs milliers d'entrées - sont libérées ~5× plus vite.
    // `staleTime` 30 s inchangé : un retour sur la page re-fetch de toute façon.
    queries: { retry: 1, staleTime: 30_000, gcTime: 60_000 },
  },
})

// Monter React immédiatement - App gère l'état isInitialized via ProtectedRoute
const root = document.getElementById('root')
if (!root) throw new Error('Root element manquant')

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>
)

// Connecter/déconnecter le WebSocket et recharger les modules à chaque changement de session
useAuthStore.subscribe((state, prev) => {
  if (state.user && !prev.user) {
    // Login ou restore de session
    applyUserLanguage((state.user.preferences as { language?: string } | undefined)?.language)
    useModulesStore.getState().fetchModules()
    if (state.accessToken) {
      useWsStore.getState().connect(state.accessToken)
    }
  }
  if (!state.user && prev.user) {
    // Logout
    useWsStore.getState().disconnect()
    useModulesStore.getState().fetchModules()
  }
})

/**
 * Recharge la liste des modules, en REGROUPANT les rafales.
 *
 * Ces événements n'arrivent presque jamais seuls : quand le serveur redémarre,
 * les modules installés se réenregistrent tous en quelques secondes, et chaque
 * onglet ouvert lançait alors une requête par module - une quinzaine pour
 * apprendre une seule et même chose. Une courte fenêtre d'attente n'en laisse
 * partir qu'une, et retarde d'autant la prise en compte d'un module isolé qui
 * apparaît ou disparaît : imperceptible pour ce que ça change à l'écran.
 */
const MODULES_RELOAD_DEBOUNCE_MS = 1500
let modulesReloadTimer: ReturnType<typeof setTimeout> | undefined
function scheduleModulesReload() {
  if (modulesReloadTimer) clearTimeout(modulesReloadTimer)
  modulesReloadTimer = setTimeout(() => {
    modulesReloadTimer = undefined
    void useModulesStore.getState().fetchModules()
  }, MODULES_RELOAD_DEBOUNCE_MS)
}

// Réagir aux events WebSocket : recharger les modules et invalider les stats admin
useWsStore.subscribe((state, prev) => {
  if (state.messages.length !== prev.messages.length) {
    const lastMsg = state.messages[state.messages.length - 1]
    if (lastMsg?.type === 'event') {
      const evtType = (lastMsg.payload as { type?: string })?.type
      if (
        evtType === 'ModuleRegistered' ||
        evtType === 'ModuleUnregistered' ||
        evtType === 'ModuleHealthChanged'
      ) {
        scheduleModulesReload()
        queryClient.invalidateQueries({ queryKey: ['admin-stats'] })
      }
      if (
        evtType === 'UserCreated' ||
        evtType === 'UserDeleted' ||
        evtType === 'UserUpdated' ||
        evtType === 'QuotaUpdated' ||
        evtType === 'FileUploaded' ||
        evtType === 'FileDeleted'
      ) {
        queryClient.invalidateQueries({ queryKey: ['admin-stats'] })
      }
    }
  }
})

// Bootstrap asynchrone après le montage initial
async function bootstrap() {
  // Charger les thèmes en premier pour éviter le flash de thème par défaut
  const themesPromise = useThemeStore.getState().fetchThemes()
  // Charger les modules dès le démarrage, SANS attendre l'authentification : les
  // routes publiques des modules (ex. forms/public/:token pour un répondant
  // anonyme) doivent voir leurs bundles importés et leurs routes enregistrées
  // avant le rendu. Idempotent : un nouveau fetch après login ne recharge rien.
  useModulesStore.getState().fetchModules()
  const { initialize } = useAuthStore.getState()
  await initialize()
  // Apply the user's per-user theme preference (follows them across devices),
  // but ONLY when this browser has no explicit local choice. Otherwise a theme
  // just applied via the admin panel (which stores it locally) would be reverted -
  // and clobbered - on every reload by a stale server-side preference.
  // `fetchThemes` already honours localStorage first, so this is purely the
  // cross-device fallback for a fresh browser.
  await themesPromise
  const userTheme = useAuthStore.getState().user?.preferences?.theme
  if (typeof userTheme === 'string' && !localStorage.getItem('kubuno_theme')) {
    useThemeStore.getState().applyTheme(userTheme)
  }
}

bootstrap()
