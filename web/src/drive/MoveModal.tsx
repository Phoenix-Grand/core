import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderInput, Home, ChevronRight, Loader2 } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { filesApi, type FileItem, type Folder } from './api'
import { FolderGlyph } from './FolderGlyph'
import { FloatingWindow } from '@ui'
import { ConflictDialog, type ConflictChoice } from '@ui'
import { Button } from '@ui'

type Target =
  | { type: 'folder'; item: Folder }
  | { type: 'file';   item: FileItem }

interface Props {
  target:  Target | null
  onClose: () => void
}

interface MutateArgs {
  overwrite: boolean
  /** strict=true : le serveur retourne 409 si conflit au lieu d'auto-renommer.
   *  Utilisé lors du premier envoi pour attraper les conflits dans les dossiers partagés
   *  dont le cache client serait périmé. */
  strict: boolean
}

export default function MoveModal({ target, onClose }: Props) {
  const { t } = useTranslation('drive')
  const [browseFolderId, setBrowseFolderId] = useState<string | null>(null)
  const [path,     setPath]     = useState<Array<{ id: string; name: string }>>([])
  const [conflict, setConflict] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['move-folders', browseFolderId],
    queryFn:  () => filesApi.listFolders(browseFolderId),
    enabled:  !!target,
  })

  // Fichiers dans le dossier de destination (pour la détection de conflits)
  const { data: destFilesData } = useQuery({
    queryKey: ['move-dest-files', browseFolderId],
    queryFn:  () => filesApi.listFiles(browseFolderId),
    enabled:  !!target,
  })

  const { mutate, isPending, error } = useMutation<unknown, { message: string; code: string }, MutateArgs>({
    mutationFn: ({ overwrite, strict }) =>
      target?.type === 'folder'
        ? filesApi.moveFolder(target.item.id, browseFolderId, overwrite, strict)
        : filesApi.moveFile(target!.item.id, browseFolderId, overwrite, strict),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['folders'] })
      qc.invalidateQueries({ queryKey: ['files'] })
      handleClose()
    },
    onError: (err) => {
      // Le serveur a détecté un conflit que le cache client avait raté (dossier partagé)
      if (err.code === 'CONFLICT') {
        const conflictingName = err.message.replace(/^Conflit: /, '')
        setConflict(conflictingName)
      }
    },
  })

  const handleClose = () => {
    setBrowseFolderId(null)
    setPath([])
    setConflict(null)
    onClose()
  }

  const navigateInto = (folder: Folder) => {
    setPath(p => [...p, { id: folder.id, name: folder.name }])
    setBrowseFolderId(folder.id)
  }

  const navigateTo = (index: number) => {
    if (index < 0) {
      setPath([])
      setBrowseFolderId(null)
    } else {
      const newPath = path.slice(0, index + 1)
      setPath(newPath)
      setBrowseFolderId(newPath[newPath.length - 1].id)
    }
  }

  const handleMoveHere = () => {
    if (!target) return
    const targetName = target.item.name
    const destFolders = (data?.folders ?? []).filter(f => f.id !== target.item.id)
    const destFiles   = destFilesData?.files ?? []
    const allNames    = [...destFolders.map(f => f.name), ...destFiles.map(f => f.name)]

    // Conflit détecté localement (cache à jour) → demander à l'utilisateur sans aller au serveur
    if (allNames.includes(targetName)) {
      setConflict(targetName)
      return
    }

    // Sinon : envoyer avec strict=true pour attraper les conflits concurrents (dossiers partagés)
    mutate({ overwrite: false, strict: true })
  }

  const handleConflictChoice = (choice: ConflictChoice) => {
    setConflict(null)
    if (choice === 'cancel') return
    // strict=false car l'utilisateur a déjà choisi
    mutate({ overwrite: choice === 'overwrite', strict: false })
  }

  if (!target) return null

  const excludeId = target.type === 'folder' ? target.item.id : null
  const folders   = (data?.folders ?? []).filter(f => f.id !== excludeId)

  // Erreurs autres que conflit
  const displayError = error && error.code !== 'CONFLICT' ? error.message : null

  return (
    <>
      <FloatingWindow
        title={t('move.title')}
        icon={<FolderInput size={16} className="text-primary" />}
        onClose={handleClose}
        defaultWidth={440}
        backdrop={!conflict}
      >
        <div className="p-5 flex flex-col gap-4 overflow-hidden">
          {/* Fil d'Ariane */}
          <nav className="flex items-center gap-1 text-xs text-text-secondary flex-wrap">
            <button
              onClick={() => navigateTo(-1)}
              className="flex items-center gap-1 hover:text-primary"
            >
              <Home size={11} /> My files
            </button>
            {path.map((p, i) => (
              <span key={p.id} className="flex items-center gap-1">
                <ChevronRight size={11} />
                <button
                  onClick={() => navigateTo(i)}
                  className={i === path.length - 1 ? 'text-text-primary font-medium' : 'hover:text-primary'}
                >
                  {p.name}
                </button>
              </span>
            ))}
          </nav>

          {/* Liste des dossiers */}
          <div className="border border-border rounded-lg overflow-hidden min-h-[160px] max-h-64 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center h-32 text-text-secondary">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : folders.length === 0 ? (
              <p className="flex items-center justify-center h-32 text-xs text-text-tertiary">

                No subfolders here
              </p>
            ) : (
              folders.map(f => (
                <button
                  key={f.id}
                  onClick={() => navigateInto(f)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2
                             text-left text-sm text-text-primary border-b border-border last:border-0"
                >
                  <FolderGlyph folder={f} size={16} className="shrink-0" />
                  <span className="truncate">{f.name}</span>
                  <ChevronRight size={14} className="ml-auto text-text-tertiary shrink-0" />
                </button>
              ))
            )}
          </div>

          {displayError && (
            <p className="text-xs text-danger">{displayError}</p>
          )}

          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={handleClose}>{t('common.cancel')}</Button>
            <Button onClick={handleMoveHere} loading={isPending}>{t('common.move_here')}</Button>
          </div>
        </div>
      </FloatingWindow>

      {conflict && target && (
        <ConflictDialog
          type={target.type}
          name={conflict}
          onChoice={handleConflictChoice}
        />
      )}
    </>
  )
}
