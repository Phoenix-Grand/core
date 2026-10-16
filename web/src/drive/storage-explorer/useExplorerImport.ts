/**
 * Import side of the explorer: tracked uploads, the shared conflict pipeline
 * (any imported file OR folder whose name already exists prompts the user -
 * overwrite / keep both / cancel, at any depth), the hidden <input> triggers and
 * the « Nouveau dossier » entry point (rich modal or prompt).
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { prompt } from '@kubuno/sdk'
import type { UploadEntry } from '../store'
import type { StorageSource } from '../storageSource'
import { useImportConflicts } from '../useImportConflicts'
import type { TFunc } from './types'

export function useExplorerImport({ src, caps, effectiveFolderId, invalidate, t, addUpload, updateUpload, onRegisterActions }: {
  src: StorageSource
  caps: StorageSource['capabilities']
  effectiveFolderId: string | null
  invalidate: () => void
  t: TFunc
  addUpload: (entry: UploadEntry) => void
  updateUpload: (id: string, patch: Partial<UploadEntry>) => void
  onRegisterActions?: (a: { importFiles: () => void; importFolder: () => void; newFolder: () => void }) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)

  const uploadFileTracked = useCallback((file: File, targetFolderId: string | null, overwrite = false) => {
    const id = crypto.randomUUID()
    addUpload({ id, name: file.name, progress: 0, status: 'uploading' })
    src.uploadFile(file, targetFolderId, pct => updateUpload(id, { progress: pct }), overwrite)
      .then((result) => {
        if (!result) { updateUpload(id, { status: 'error', error: t('app.module_unavailable') }); return }
        updateUpload(id, { progress: 100, status: 'done' }); invalidate()
      })
      .catch(err => updateUpload(id, { status: 'error', error: (err as Error).message ?? t('common.error') }))
  }, [addUpload, updateUpload, invalidate, src, t])

  // Shared import-with-conflict pipeline: any imported file OR folder whose name
  // already exists prompts the user (overwrite / keep both / cancel), at any depth.
  const { importFiles, importEntries, importWebkitFolder, conflictDialog } = useImportConflicts({
    list: (fid) => src.list(fid),
    createFolder: async (name, parentId) => { await src.createFolder(name, parentId); const { folders } = await src.list(parentId); return { id: folders.find(f => f.name === name)?.id ?? parentId } },
    uploadFile: uploadFileTracked,
    canMkdir: caps.mkdir,
  })

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void importFiles(files, effectiveFolderId) }
  // Import d'un DOSSIER (<input webkitdirectory>) - arborescence + conflits gérés par le hook.
  const handleFolderInput = (e: ChangeEvent<HTMLInputElement>) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (caps.mkdir) void importWebkitFolder(files, effectiveFolderId) }

  // Nouveau dossier (modale locale ou prompt distant).
  const openNewFolder = useCallback(() => {
    if (caps.richModals) { setNewFolderOpen(true); return }
    void (async () => {
      const n = await prompt({ title: t('newfolder.title', { defaultValue: 'Nouveau dossier' }), defaultValue: '' })
      if (n) { await src.createFolder(n, effectiveFolderId); invalidate() }
    })()
  }, [caps.richModals, src, effectiveFolderId, invalidate, t])

  // Expose les déclencheurs au parent (bouton « Nouveau » de la sidebar).
  useEffect(() => {
    onRegisterActions?.({
      importFiles:  () => fileInputRef.current?.click(),
      importFolder: () => folderInputRef.current?.click(),
      newFolder:    openNewFolder,
    })
  }, [onRegisterActions, openNewFolder])

  return {
    fileInputRef, folderInputRef, handleFileInput, handleFolderInput,
    openNewFolder, newFolderOpen, setNewFolderOpen,
    importFiles, importEntries, conflictDialog,
  }
}
