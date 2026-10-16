/**
 * Le fil d'Ariane de l'explorateur : racine avec icône Maison, segments
 * cliquables, dernier segment = dossier courant. Un bouton déroulant en fin de
 * fil permet de sauter directement dans un SOUS-DOSSIER du dossier courant.
 *
 * Depuis l'extraction de la primitive `Breadcrumb` de `@ui`, ce composant ne
 * dessine plus rien lui-même : il traduit un chemin de dossiers en segments et
 * ajoute le seul élément qui lui est propre - le saut vers un enfant. Le rendu,
 * les chevrons, la troncature et l'accessibilité viennent du composant partagé,
 * si bien que la console d'administration et l'explorateur affichent exactement
 * le même fil. Reste la base thémable de la clé `drive.breadcrumb`.
 */
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Breadcrumb, type Crumb } from '@ui'

export function StorageBreadcrumbBase({ rootName, crumbs, onNavigate, onOpenMenu, ariaLabel }: {
  rootName: string
  crumbs: Array<{ id: string; name: string }>
  onNavigate: (idx: number) => void            // -1 = racine, sinon index du segment
  /** Opens the current folder's own action menu, hung off the last segment. */
  onOpenMenu?: (e: React.MouseEvent) => void
  ariaLabel?: string
}) {
  const { t } = useTranslation('drive')

  const items: Crumb[] = [
    { label: rootName, title: rootName, onClick: () => onNavigate(-1) },
    ...crumbs.map((crumb, idx) => ({
      label:   crumb.name,
      title:   crumb.name,
      onClick: () => onNavigate(idx),
    })),
  ]

  return (
    <Breadcrumb
      items={items}
      ariaLabel={ariaLabel}
      // Un chemin de dossiers descend plus profond qu'un menu : on garde six
      // segments avant de replier, contre quatre pour la console.
      maxVisible={6}
      maxSegmentWidth="16rem"
      size="lg"
      trailing={onOpenMenu ? (
        <button
          type="button"
          aria-label={t('breadcrumb.folder_menu', { defaultValue: 'Actions du dossier' })}
          title={t('breadcrumb.folder_menu', { defaultValue: 'Actions du dossier' })}
          onClick={onOpenMenu}
          className="ms-1 inline-flex items-center justify-center rounded-full p-1 text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors focus:outline-none"
        >
          <ChevronDown size={20} className="shrink-0" />
        </button>
      ) : undefined}
    />
  )
}
