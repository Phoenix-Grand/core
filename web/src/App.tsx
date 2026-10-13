import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { KubunoLogo, ToastProvider } from '@ui'
import { useAuthStore } from './core/store/authStore'
import { useModulesStore } from './core/store/modulesStore'
import { RouteRegistry } from './core/registry/RouteRegistry'
import Shell from './core/shell/views/Shell'
import { DocumentTitle } from './core/shell/pages/DocumentTitle'
import { useAdminConsoleApp } from './core/admin/useAdminConsoleApp'
import LoginPage from './core/auth/LoginPage'
import RegisterPage from './core/auth/RegisterPage'
import ResetPasswordPage from './core/auth/ResetPasswordPage'
import OAuthCallback from './core/auth/OAuthCallback'
import ForcePasswordChange from './core/auth/ForcePasswordChange'
import HomePage from './core/views/HomePage'

// Pages lourdes ou peu fréquentes : chargées à la demande (React.lazy) pour les
// sortir du chunk eager kubuno-shared et alléger la RAM du host — la console
// d'admin pèse à elle seule ~2,5 Mo de source, inutile pour un non-admin. Le
// carve-out correspondant est dans vite.config.ts (manualChunks).
const AdminPage = lazy(() => import('./core/admin/views/AdminPage'))
const SettingsPage = lazy(() => import('./core/settings/SettingsPage'))
const SetupWizard = lazy(() => import('./core/setup/SetupWizard'))
import ModulesPage from './core/views/ModulesPage'
import AboutPage from './core/views/AboutPage'
import LabelsPage from './core/views/LabelsPage'
import PromptHost from './core/components/PromptHost'
import ReauthHost from './core/components/ReauthHost'
import ImagePickerHost from './core/components/ImagePickerHost'
import ShareHost from './core/components/ShareHost'
import LabelPickerHost from './core/components/LabelPickerHost'
import ClipboardPaneHost from './core/components/ClipboardPaneHost'
import PendingDeletionHost from './core/components/PendingDeletionHost'
import { TextFieldMenuHost } from './core/shell/pages/TextFieldMenuHost'

// ── Modules ───────────────────────────────────────────────────────────────────
// Le host ne nomme AUCUN module : ils sont chargés à l'exécution depuis le
// registre du core (cf. core/modules/loadRemoteModules.ts, déclenché par
// modulesStore.fetchModules) via leurs bundles publiés /modules/<id>/entry.js.
// (Plus d'import statique : chaque module vit dans son propre dépôt.)

// Écran de chargement initial (avant que la session soit résolue).
// Rounded (pointy-top) hexagon matching the logo's silhouette, drawn once in a
// 0–100 viewBox. A thick round-capped segment travels along it (stroke-dashoffset
// animation) so a line runs around the logo's hexagon while the app loads.
const HEX_PATH =
  'M 41.34 9.00 Q 50.00 4.00 58.66 9.00 L 81.18 22.00 Q 89.84 27.00 89.84 37.00 ' +
  'L 89.84 63.00 Q 89.84 73.00 81.18 78.00 L 58.66 91.00 Q 50.00 96.00 41.34 91.00 ' +
  'L 18.82 78.00 Q 10.16 73.00 10.16 63.00 L 10.16 37.00 Q 10.16 27.00 18.82 22.00 Z'

function LoadingSplash() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6">
      <div className="relative flex items-center justify-center" style={{ width: 210, height: 210 }}>
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" fill="none" aria-hidden="true">
          <defs>
            {/* Two-colour gradient (previous → next) that flows along the line: its
                two stops step through the palette in lock-step (stop 2 always one
                colour ahead of stop 1), so the colour changes continuously; and the
                gradient rotates in sync with the travelling segment (same 1.4s
                period), so its direction follows the line's motion. */}
            <linearGradient id="loader-ring-grad" gradientUnits="userSpaceOnUse" x1="8" y1="50" x2="92" y2="50">
              <stop offset="0%" stopColor="#52AAEE">
                <animate attributeName="stop-color" values="#52AAEE;#A12090;#E2318D;#E9813B;#F4D347;#A8DD53;#52AAEE" dur="1.5s" repeatCount="indefinite" />
              </stop>
              <stop offset="100%" stopColor="#A12090">
                <animate attributeName="stop-color" values="#A12090;#E2318D;#E9813B;#F4D347;#A8DD53;#52AAEE;#A12090" dur="1.5s" repeatCount="indefinite" />
              </stop>
              <animateTransform attributeName="gradientTransform" type="rotate" from="0 50 50" to="360 50 50" dur="1.4s" repeatCount="indefinite" />
            </linearGradient>
          </defs>
          <path
            d={HEX_PATH}
            pathLength={100}
            stroke="url(#loader-ring-grad)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray="24 76"
          >
            <animate attributeName="stroke-dashoffset" values="0;-100" dur="1.4s" repeatCount="indefinite" />
          </path>
        </svg>
        <KubunoLogo size={156} className="relative animate-pulse" />
      </div>
      <span className="text-text-secondary text-sm">Chargement…</span>
    </div>
  )
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isInitialized } = useAuthStore()
  const modulesReady = useModulesStore((s) => s.modulesReady)
  const location = useLocation()
  if (!isInitialized) return <LoadingSplash />
  // Déconnexion (token expiré sur le même onglet) → on mémorise la page courante
  // pour y revenir après reconnexion (sauf l'accueil, inutile).
  if (!user) {
    // L'URL courante pourrait être une route PUBLIQUE de module pas encore
    // enregistrée (bundles chargés à l'exécution). Tant que le premier chargement
    // des modules n'est pas terminé, patienter au lieu de rediriger vers /login —
    // sinon un répondant anonyme d'un formulaire public serait expulsé.
    if (!modulesReady) return <LoadingSplash />
    const from = location.pathname + location.search
    return <Navigate to="/login" replace state={from !== '/' ? { from } : undefined} />
  }
  // Account still carrying the seeded default password: the WHOLE shell is
  // replaced by the change screen, whatever route was asked for. Nothing to
  // dismiss and no page behind it — typing /admin or /settings lands here too.
  if (user.must_change_password) return <ForcePasswordChange />
  return <>{children}</>
}

// Pages publiques (login, register…) : rediriger vers l'accueil si déjà connecté —
// ou vers la page d'origine si on a été redirigé ici par une déconnexion.
function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const { user, isInitialized } = useAuthStore()
  const location = useLocation()
  if (!isInitialized) return <LoadingSplash />
  if (user) {
    const from = (location.state as { from?: string } | null)?.from
    return <Navigate to={from ?? '/'} replace />
  }
  return <>{children}</>
}

function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <p className="text-6xl font-bold text-text-tertiary mb-4">404</p>
      <p className="text-lg font-medium text-text-primary mb-2">Page introuvable</p>
      <a href="/" className="text-primary hover:underline text-sm">Retour à l'accueil</a>
    </div>
  )
}

// Route non reconnue. Sur un rechargement dur d'une route de module, les bundles
// UI se chargent à l'exécution : tant que ce premier chargement n'est pas terminé,
// la route du module n'existe pas encore dans RouteRegistry → on afficherait un 404
// fugace. On patiente avec un écran de chargement jusqu'à ce que les modules soient
// prêts ; seulement alors une route toujours non résolue est un vrai 404.
function UnmatchedRoute() {
  const ready = useModulesStore((s) => s.modulesReady)
  return ready ? <NotFoundPage /> : <LoadingSplash />
}

export default function App() {
  // Se re-rend quand un bundle de module est chargé à l'exécution : les routes
  // enregistrées par le module (RouteRegistry, non réactif) sont alors prises en compte.
  useModulesStore((s) => s.loadedVersion)
  // `t` du host : les libellés internes de la primitive (« Fermer ») suivent la
  // langue de l'utilisateur au lieu des repères anglais de @ui.
  const { t } = useTranslation()
  // The administration console is an app like a module's: brand, favicon, title.
  useAdminConsoleApp()
  return (
    // Mounted ABOVE <Routes>: the toast host must survive a route change and
    // cover the whole application — the authentication screens and the admin
    // console included, neither of which lives inside <Shell>. It portals to
    // <body> (no PortalHostContext here), so a toast is never clipped by a
    // scroll container, and it is the single stack every `useToast()` in the
    // host or in a runtime-loaded module writes into.
    <ToastProvider t={t}>
    <DocumentTitle />
    <Routes>
      {/* Pages publiques core — redirigent vers l'accueil si déjà connecté */}
      {/* Installation initiale — servie AVANT toute authentification : sur une
          instance neuve, il n'existe aucun compte. */}
      <Route path="/setup" element={<Suspense fallback={<LoadingSplash />}><SetupWizard /></Suspense>} />
      <Route path="/setup/:step" element={<Suspense fallback={<LoadingSplash />}><SetupWizard /></Suspense>} />

      <Route path="/login"           element={<PublicOnlyRoute><LoginPage /></PublicOnlyRoute>} />
      <Route path="/register"        element={<PublicOnlyRoute><RegisterPage /></PublicOnlyRoute>} />
      <Route path="/forgot-password" element={<PublicOnlyRoute><LoginPage initialStep="forgot" /></PublicOnlyRoute>} />
      {/* Cible du lien envoyé par « mot de passe oublié ». Le jeton arrive en
          query string ; la page est publique par nature (aucune session). */}
      <Route path="/reset-password"  element={<PublicOnlyRoute><ResetPasswordPage /></PublicOnlyRoute>} />
      <Route path="/auth/oauth/:provider/callback" element={<OAuthCallback />} />

      {/* Pages publiques des modules */}
      {RouteRegistry.getPublicRoutes().map(({ path, Component, props = {} }) => (
        <Route key={path} path={`/${path}`} element={
          <Suspense fallback={null}><Component {...props} /></Suspense>
        } />
      ))}

      {/* Shell protégé */}
      <Route path="/" element={<ProtectedRoute><Shell /></ProtectedRoute>}>
        <Route index         element={<HomePage />} />
        <Route path="modules"  element={<ModulesPage />} />
        <Route path="settings" element={<Suspense fallback={null}><SettingsPage /></Suspense>} />
        {/* La console d'administration met le LIEU dans le chemin —
            `/admin/<section>[/<fiche>[/<volet>]]` — et le reste (filtres,
            recherche, verbe d'action) en query string. AdminPage lit lui-même
            location.pathname : la forme de chaque section est déclarée dans
            adminNav.ts et interprétée par adminRoute.ts, qui redirige aussi
            toute adresse historique (`/admin?tab=users&user=…`). */}
        <Route path="admin"                  element={<Suspense fallback={null}><AdminPage /></Suspense>} />
        <Route path="admin/:tab"             element={<Suspense fallback={null}><AdminPage /></Suspense>} />
        <Route path="admin/:tab/:record"     element={<Suspense fallback={null}><AdminPage /></Suspense>} />
        <Route path="admin/:tab/:record/:pane" element={<Suspense fallback={null}><AdminPage /></Suspense>} />
        <Route path="about"    element={<AboutPage />} />
        <Route path="labels"   element={<LabelsPage />} />

        {/* Routes des modules — enregistrées dynamiquement dans register.ts */}
        {RouteRegistry.getShellRoutes().map(({ path, Component, props = {} }) => (
          <Route key={path} path={path} element={
            <Suspense fallback={null}><Component {...props} /></Suspense>
          } />
        ))}

        <Route path="*" element={<UnmatchedRoute />} />
      </Route>
    </Routes>
    <PromptHost />
    <ReauthHost />
    <ImagePickerHost />
    <ShareHost />
    <LabelPickerHost />
    <ClipboardPaneHost />
    <PendingDeletionHost />
    <TextFieldMenuHost />
    </ToastProvider>
  )
}
