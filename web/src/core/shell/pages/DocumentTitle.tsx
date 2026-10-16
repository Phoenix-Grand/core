import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { WaffleAppRegistry } from '../../registry/WaffleAppRegistry'
import { FaviconRegistry, KUBUNO_FAVICON } from '../../registry/FaviconRegistry'
import { useDocumentTitleStore } from '../../store/documentTitleStore'
import { useModulesStore } from '../../store/modulesStore'

// Gère le titre de l'onglet ET le favicon selon le contexte courant.
//
// Titre  : « nom du fichier - sous-module - module - Kubuno » (chaque segment
//          n'est inclus que s'il existe ; les doublons sont retirés - ex. l'app
//          racine d'un module dont le sous-module = le module).
// Favicon: celui du sous-module, sinon du module, sinon celui de Kubuno.
//
// Composant sans rendu : à monter une fois dans le shell (sous le Router).
export function DocumentTitle() {
  const location = useLocation()
  const fileName = useDocumentTitleStore((s) => s.fileName)
  // Les modules chargés à l'exécution enregistrent leur favicon/WaffleApp APRÈS le
  // premier rendu : on se ré-exécute quand un bundle de module est chargé.
  const loadedVersion = useModulesStore((s) => s.loadedVersion)
  // Translated app names (the administration console's) follow the language.
  const { i18n } = useTranslation()

  useEffect(() => {
    const resolved = WaffleAppRegistry.resolveByPath(location.pathname)

    // ── Titre ────────────────────────────────────────────────────────────────
    const segments = [fileName, resolved?.subLabel, resolved?.moduleLabel, 'Kubuno']
    const seen = new Set<string>()
    const title = segments
      .filter((s): s is string => !!s && s.trim().length > 0)
      .filter((s) => {
        const k = s.toLowerCase()
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      .join(' - ')
    document.title = title || 'Kubuno'

    // ── Favicon ──────────────────────────────────────────────────────────────
    const href =
      (resolved &&
        (FaviconRegistry.get(resolved.subId) ?? FaviconRegistry.get(resolved.moduleId))) ||
      KUBUNO_FAVICON

    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    if (link.getAttribute('href') !== href) {
      link.setAttribute('href', href)
      link.setAttribute('type', href.endsWith('.png') ? 'image/png' : 'image/svg+xml')
    }
  }, [location.pathname, fileName, loadedVersion, i18n.language])

  return null
}
