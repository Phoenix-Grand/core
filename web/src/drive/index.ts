/**
 * `@kubuno/drive` - service plateforme d'accès aux fichiers (couche partagée).
 *
 * Extrait du module `drive` car 6 modules (office, paintsharp, media, code, flow)
 * en dépendent au build. Chargé À LA DEMANDE (chunk `drive-shared`, non-eager) :
 * pour les consommateurs statiques via leurs chunks lazy, pour le bundle runtime
 * `drive` via l'import map. Instance unique de `filesApi`/des stores partagée.
 */
export * from './api'
export * from './FolderGlyph'
export * from './store'
export * from './storageSource'
export * from './filesShared'
export * from './fileView'
export * from './useMarqueeSelection'
export * from './useImportConflicts'
export * from './FilesOpenWithContext'
export * from './batchRenameStore'
export * from './filesDialogStore'
export * from './filesMediaPlayerStore'
export * from './filesPaintStore'
export * from './filesVideoPlayerStore'

// Composants à export par défaut (+ leurs exports nommés/types éventuels).
export { default as StorageExplorer } from './StorageExplorer'
export * from './StorageExplorer'
export { default as FilesTextViewer, isTextFile } from './FilesTextViewer'
export { default as ModuleFileBrowser } from './ModuleFileBrowser'
export * from './ModuleFileBrowser'
export { default as ModuleStartPage } from './ModuleStartPage'
export * from './ModuleStartPage'
export { default as RenameModal } from './RenameModal'
export * from './RenameModal'
export { default as MoveModal } from './MoveModal'
export * from './MoveModal'
export { default as ShareModal } from './ShareModal'
export * from './ShareModal'
export { default as NewFolderModal } from './NewFolderModal'
export * from './NewFolderModal'
export { default as FileInfoModal } from './FileInfoModal'
export * from './FileInfoModal'
export { default as VersionHistoryModal } from './VersionHistoryModal'
export * from './VersionHistoryModal'
export { default as BatchRenameModal } from './BatchRenameModal'
export * from './BatchRenameModal'
export { default as UploadPanel } from './UploadPanel'
export * from './UploadPanel'
