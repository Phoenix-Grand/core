/**
 * FolderGlyph - L'icône d'un dossier, centralisée pour TOUTES les vues :
 * grille (DriveApp/StorageExplorer), arbre latéral, menu « Aller à » du fil
 * d'ariane, modales Déplacer / Infos / sélecteur de dossier…
 *
 * Règle : un dossier protégé d'application affiche le logo de l'app À LA PLACE
 * de l'icône de dossier (une seule icône, jamais deux). Priorités :
 *   1. logo de marque du module (FaviconRegistry) si dossier protégé
 *   2. icône Lucide personnalisée du dossier (folder.icon) si elle résout
 *   3. icône Lucide déclarée par le module (sidebar_items) si dossier protégé
 *   4. dossier classique (folder.color, défaut gris)
 */
import React, { useMemo } from 'react'
import { Folder as FolderIcon } from 'lucide-react'
import { useModulesStore, FaviconRegistry, ICON_MAP } from '@kubuno/sdk'

/** Champs minimaux pour décider de l'icône - sous-ensemble de `Folder`. */
export interface FolderGlyphSource {
  name:          string
  is_protected?: boolean
  icon?:         string | null
  color?:        string | null
}

/** Carte nom-de-dossier-protégé → app (logo SVG de marque ou icône Lucide). */
export function useProtectedFolderApps(): Record<string, { logo?: string; icon?: string }> {
  const activeModules = useModulesStore(s => s.activeModules)
  // Re-render quand un module runtime a fini de s'enregistrer (FaviconRegistry,
  // routes…) : les logos de dossier protégé sont alors disponibles.
  const loadedVersion = useModulesStore(s => s.loadedVersion)
  return useMemo(() => {
    const map: Record<string, { logo?: string; icon?: string }> = {}
    for (const mod of activeModules) {
      for (const item of mod.sidebar_items) {
        if (!item.protected_folder) continue
        // Un module « demande » à drive d'afficher SON logo de marque sur son
        // dossier protégé en l'enregistrant via FaviconRegistry (clé = id
        // module/sous-module). Priorité au logo (SVG), repli sur l'icône Lucide.
        const logo = FaviconRegistry.get(item.id)
        map[item.protected_folder] = logo ? { logo } : { icon: item.icon }
      }
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModules, loadedVersion])
}

export function FolderGlyph({ folder, size = 20, className, color, style }: {
  folder:     FolderGlyphSource
  size?:      number
  className?: string
  /** Force la couleur (ex. bleu « actif » dans l'arbre) - sans effet sur un logo de marque. */
  color?:     string
  style?:     React.CSSProperties
}) {
  const apps = useProtectedFolderApps()
  const app  = folder.is_protected ? apps[folder.name] : undefined

  if (app?.logo) {
    return (
      <img
        src={app.logo} alt="" width={size} height={size} className={className}
        // Version grise du logo : les dossiers ne portent aucune couleur vive.
        style={{ borderRadius: Math.max(2, Math.round(size * 0.15)), display: 'block', flexShrink: 0, filter: 'grayscale(1)', opacity: 0.75, ...style }}
      />
    )
  }
  // Icône Lucide seulement si le nom résout (getIcon retombe sur Cloud sinon).
  const Icon = ICON_MAP[folder.icon ?? ''] ?? ICON_MAP[app?.icon ?? '']
  if (Icon) {
    return <Icon size={size} className={className} style={{ color: color ?? '#5f6368', flexShrink: 0, ...style }} />
  }
  return (
    <FolderIcon
      size={size} className={className} fill="currentColor"
      style={{ color: color ?? folder.color ?? '#5f6368', flexShrink: 0, ...style }}
    />
  )
}
