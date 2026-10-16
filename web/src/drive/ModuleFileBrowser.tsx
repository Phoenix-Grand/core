/**
 * ModuleFileBrowser - navigateur de fichiers pour les sous-modules.
 *
 * Devenu un **wrapper mince** autour de `StorageExplorer` (la zone d'exploration
 * générique, partagée par tous les types de stockage). Il fixe la source sur le
 * stockage local enraciné à `folderPathPrefix` et préserve l'API publique
 * historique consommée par office/paintsharp/media/code/flow.
 * Cf. [[project_storage_explorer_generalized]].
 */
import { useMemo } from 'react'
import StorageExplorer, { type StorageExplorerProps, type FileContextAction } from './StorageExplorer'
import { localSource, resolveRootFolder } from './storageSource'

export type { FileContextAction }
export { resolveRootFolder }

export interface ModuleFileBrowserProps {
  /** Préfixe du chemin du dossier racine (ex: "Office/Documents") */
  folderPathPrefix:    string
  title:               string
  onOpenFile?:         StorageExplorerProps['onOpenFile']
  fileContextActions?: FileContextAction[]
  toolbarContent?:     StorageExplorerProps['toolbarContent']
  hideImport?:         boolean
  importMenuItems?:    StorageExplorerProps['importMenuItems']
  renderFileCard?:     StorageExplorerProps['renderFileCard']
  emptyState?:         StorageExplorerProps['emptyState']
  acceptedMimeTypes?:  string[]
  fileTypeModuleId?:   string
}

export default function ModuleFileBrowser(props: ModuleFileBrowserProps) {
  // Source = stockage local enraciné au préfixe.
  const source = useMemo(
    () => localSource({ rootPrefix: props.folderPathPrefix, rootName: props.title }),
    [props.folderPathPrefix, props.title],
  )
  return <StorageExplorer {...props} source={source} />
}
