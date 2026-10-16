import { SDK_VERSION } from '@kubuno/sdk'
import { VIEWS_ABI } from '@kubuno/views'
import type { ActiveModule } from '../types'
import { useThemeStore } from '../store/themeStore'
import { useModuleLoadStore } from './moduleLoadStore'

/**
 * Chargement À L'EXÉCUTION des bundles UI des modules.
 *
 * Le host ne nomme aucun module : il lit la liste renvoyée par le core
 * (`GET /api/v1/modules`) et importe le `frontend_entry` de chacun. Chaque
 * bundle externalise react/@ui/@kubuno/sdk, résolus par l'import map du host →
 * instances uniques partagées. Un module cassé ou incompatible est ignoré sans
 * jamais faire tomber le shell (try/catch + allSettled).
 */
// Modules dont le bundle a été chargé ET `register()` exécuté avec succès.
const loaded = new Set<string>()
// Chargements EN COURS (clé = module_id) : permet à des appels concurrents de
// `loadRemoteModules` (boot + events WebSocket ModuleRegistered/HealthChanged…)
// d'ATTENDRE le même chargement au lieu de le considérer « déjà fait » et de
// rendre `modulesReady` vrai avant que les routes du module soient enregistrées
// (sinon : 404 fugace à la place de l'écran de chargement).
const inflight = new Map<string, Promise<boolean>>()

export async function loadRemoteModules(modules: ActiveModule[]): Promise<number> {
  const targets = modules.filter((m) => m.frontend_entry && !loaded.has(m.module_id))
  if (targets.length === 0) return 0
  // Pour chaque cible : réutiliser le chargement en cours s'il existe, sinon en
  // lancer un nouveau. La boucle map est synchrone → l'enregistrement dans
  // `inflight` est atomique vis-à-vis d'un autre appel concurrent.
  const promises = targets.map((m) => {
    const existing = inflight.get(m.module_id)
    if (existing) return existing
    const p = loadOne(m).finally(() => inflight.delete(m.module_id))
    inflight.set(m.module_id, p)
    return p
  })
  const results = await Promise.allSettled(promises)
  return results.filter((r) => r.status === 'fulfilled' && r.value).length
}

async function loadOne(m: ActiveModule): Promise<boolean> {
  const entry = m.frontend_entry as string

  try {
    // Feuille de style du module (best-effort), injectée avant le JS. L'entrée
    // est content-hashée par le core (`entry-<hash>.js`) ; on dérive le CSS en
    // gardant le MÊME hash (`entry-<hash>.css`) - le core réécrit vers le vrai
    // entry.css. Sinon iOS resert un CSS périmé. (Le `(\?.*)?` couvre encore
    // l'ancien format `?v=` par sécurité pendant une transition.)
    const cssHref = entry.replace(/\.js(\?.*)?$/, '.css$1')
    if (cssHref !== entry && !document.querySelector(`link[data-kbmod="${m.module_id}"]`)) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = cssHref
      link.dataset.kbmod = m.module_id
      document.head.appendChild(link)
    }

    const mod = await import(/* @vite-ignore */ entry)

    // Handshake de version : un module bâti contre un autre SDK est ignoré.
    const v = typeof mod.sdkVersion === 'number' ? mod.sdkVersion : undefined
    if (v !== undefined && v !== SDK_VERSION) {
      console.warn(`[modules] ${m.module_id} : SDK v${v} ≠ host v${SDK_VERSION} - ignoré`)
      useModuleLoadStore.getState().recordFailure({
        moduleId: m.module_id,
        reason: 'sdk-mismatch',
        detail: `SDK v${v} ≠ host v${SDK_VERSION}`,
      })
      return false
    }
    // Same handshake for the .kbview runtime: a module whose views were compiled for another plan ABI
    // (`viewsAbi`, exported next to `sdkVersion` by modules that use views) cannot be rendered by this host.
    const abi = typeof mod.viewsAbi === 'number' ? mod.viewsAbi : undefined
    if (abi !== undefined && abi !== VIEWS_ABI) {
      console.warn(`[modules] ${m.module_id} : views ABI ${abi} ≠ host ${VIEWS_ABI} - ignoré`)
      useModuleLoadStore.getState().recordFailure({
        moduleId: m.module_id,
        reason: 'views-mismatch',
        detail: `views ABI ${abi} ≠ host ${VIEWS_ABI}`,
      })
      return false
    }
    if (typeof mod.register !== 'function') {
      console.warn(`[modules] ${m.module_id} : pas d'export register() - ignoré`)
      useModuleLoadStore.getState().recordFailure({
        moduleId: m.module_id,
        reason: 'no-register',
        detail: "pas d'export register()",
      })
      return false
    }

    mod.register()
    // Un chargement réussi efface un échec précédent (une tentative a récupéré).
    useModuleLoadStore.getState().clearFailure(m.module_id)
    // Marqué chargé SEULEMENT après un register() réussi : tant que ce n'est pas
    // fait, un appel concurrent attend `inflight` plutôt que de l'ignorer.
    loaded.add(m.module_id)
    // Le thème actif peut cibler ce module (CSS/JS) : appliquer ses overrides
    // maintenant que le bundle est enregistré (best-effort, jamais bloquant).
    try {
      useThemeStore.getState().applyThemeModuleAssets(m.module_id)
    } catch (e) {
      console.error(`[theme] application des overrides du module ${m.module_id}`, e)
    }
    return true
  } catch (err) {
    // Isolation : l'échec d'un module ne casse jamais le shell ni les autres -
    // mais il ne doit plus disparaître en silence : on le recense pour la cloche
    // (cf. useModuleLoadAlerts). Le cas le plus courant est une erreur de liaison
    // ES (« does not provide an export named 'X' ») d'un module bâti contre une
    // surface SDK plus récente que celle servie par le host.
    console.error(`[modules] ${m.module_id} : échec de chargement du bundle UI`, err)
    useModuleLoadStore.getState().recordFailure({
      moduleId: m.module_id,
      reason: 'import-error',
      detail: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
