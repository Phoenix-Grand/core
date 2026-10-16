import { create } from 'zustand'
import type React from 'react'

export interface SearchConfig {
  moduleId:        string
  // Préfixe de route qui active cette config (ex: '/files', '/calendar')
  // Le préfixe le plus long gagne (most-specific wins)
  routePrefix:     string
  // Texte affiché dans le champ quand ce module est actif
  placeholder:     string
  // Clé i18n (ex: 'agenda:search_ph') résolue réactivement par la SearchBar.
  // Prioritaire sur `placeholder` ; permet la traduction au changement de langue.
  placeholderKey?: string
  // Appelé à chaque frappe dans le champ de recherche core
  onSearch?:       (query: string) => void
  // Remplacement complet de la SearchBar - le module contrôle toute l'UI de recherche
  // Si absent, on utilise le champ par défaut avec le placeholder ci-dessus
  SearchComponent?: React.ComponentType
  // Contenu du dropdown de filtres (injected par le module actif)
  // Rendu dans le panneau qui s'ouvre sous la searchbar
  FilterPanel?: React.ComponentType<{ onClose: () => void }>
  // Recherche par image : si défini, la SearchBar affiche un bouton appareil photo
  // qui ouvre un sélecteur d'image et appelle ce callback (images similaires).
  onImageSearch?: (file: File) => void
  // Opt-out du système loupe → mode recherche : à `true`, le module conserve la
  // barre de recherche INLINE permanente dans l'en-tête (ancienne méthode), au lieu
  // de la loupe qui déploie le mode recherche plein en-tête. Ex : mail.
  inline?: boolean
}

/**
 * A request from a module to the SHELL to open (or close) its search surface.
 *
 * The shell owns the magnifier and the search mode it expands into, so a module
 * cannot open it by itself - and its own search component is not even mounted
 * while the mode is closed, which is exactly when a global shortcut has to work.
 * `seq` makes each request distinct, so asking twice in a row is honoured twice.
 */
export interface SearchOpenSignal { seq: number; open: boolean }

interface SearchState {
  configs:   SearchConfig[]
  // Current text of the shell search field (controlled). Modules can seed it
  // (e.g. restoring a search from the URL after a refresh) via setQuery - this
  // only updates the field; running the search stays the caller's job.
  query:     string
  setQuery:  (q: string) => void
  /** Latest open/close request. `seq: 0` = nothing asked yet. */
  openSignal: SearchOpenSignal
  /** Ask the shell to enter (or leave) search mode. */
  requestSearchOpen: (open: boolean) => void
  register:  (config: SearchConfig) => void
  unregister: (moduleId: string) => void
}

export const useSearchStore = create<SearchState>((set) => ({
  configs: [],
  query:   '',

  openSignal: { seq: 0, open: false },

  setQuery: (query) => set({ query }),

  requestSearchOpen: (open) =>
    set((s) => ({ openSignal: { seq: s.openSignal.seq + 1, open } })),

  register: (config) =>
    set((s) => ({
      configs: [...s.configs.filter((c) => c.moduleId !== config.moduleId), config],
    })),

  unregister: (moduleId) =>
    set((s) => ({
      configs: s.configs.filter((c) => c.moduleId !== moduleId),
    })),
}))

// Trouve la config active selon le pathname courant.
// Plus le préfixe est long, plus il est spécifique → il gagne.
export function resolveSearchConfig(
  configs: SearchConfig[],
  pathname: string,
): SearchConfig | null {
  return (
    configs
      .filter((c) => pathname === c.routePrefix || pathname.startsWith(c.routePrefix + '/'))
      .sort((a, b) => b.routePrefix.length - a.routePrefix.length)[0] ?? null
  )
}
