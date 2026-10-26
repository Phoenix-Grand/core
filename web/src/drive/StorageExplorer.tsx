/**
 * StorageExplorer - LA zone d'exploration de fichiers, générique et partagée par
 * TOUS les types de stockage (local + montages distants). Pilotée par une
 * `StorageSource` ; chaque source déclare ses capacités → on masque les fonctions
 * non supportées. Calqué visuellement sur « Mon Drive » (barre de sélection, tri/
 * type/affichage, dossiers/fichiers, multi-sélection, marquee, glisser-déposer,
 * menu contextuel). Cf. [[project_storage_explorer_generalized]].
 *
 * Ce fichier est le POINT D'ENTRÉE qui compose ; les unités (vues, lignes,
 * cartes, menus, hooks d'état) vivent dans `./storage-explorer/`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Folder as FolderIcon, Upload, Loader2, CloudUpload, FolderPlus, RefreshCw, AlertTriangle, Info,
} from 'lucide-react'
import { copyKubunoData } from '../core/registry/DataTransferRegistry'
import { driveFileEnvelope } from '../core/registry/DriveFileCard'
import { filesApi, type Folder, type FileItem } from './api'
import { useFilesStore } from './store'
import { useFilesPaintStore } from './filesPaintStore'
import { useAuthStore, api, prompt, useConfirm, type User } from '@kubuno/sdk'
import { ViewMenu, type ViewMode } from './fileView'
import NewFolderModal from './NewFolderModal'
import BatchRenameModal, { type BatchRenameItem } from './BatchRenameModal'
import { useBatchRenameStore } from './batchRenameStore'
import MoveModal from './MoveModal'
import ShareModal, { type ShareTarget } from './ShareModal'
import VersionHistoryModal from './VersionHistoryModal'
import { MenuDropdown, ConfirmDialog, type MenuItem, useIsMobile, isCoarsePointer, Spinner } from '@ui'
import { useDriveLabels } from './useDriveLabels'
import { DriveLabelsCtx } from './LabelDots'
import { bumpAllImageCache, usePendingDeletionStore, type DeletionKind, type PendingItem } from '@kubuno/sdk'
import { useFilesMediaPlayerStore } from './filesMediaPlayerStore'
import { useFilesVideoPlayerStore } from './filesVideoPlayerStore'
import { useMarqueeSelection } from './useMarqueeSelection'
import { localSource, type StorageSource, type ItemRef } from './storageSource'
import FilesTextViewer from './FilesTextViewer'
import { SortFilterBar, UploadPanel } from './storage-explorer/themed'
import { SelectingCtx } from './storage-explorer/selectingContext'
import { MediaViewer } from './storage-explorer/MediaViewer'
import { MobileControlBar } from './storage-explorer/toolbars'
import { ExplorerHeader } from './storage-explorer/ExplorerHeader'
import { DetailsTable, FilesSection, FoldersSection } from './storage-explorer/sections'
import { DriveDetailsPanel, DRIVE_DETAILS_PANEL } from './storage-explorer/DetailsSidePanel'
import { useDetailsTargetStore, type DetailsTarget } from './detailsTargetStore'
import { useRightPanelStore } from '../core/store/rightPanelStore'
import { buildItemMenuItems } from './storage-explorer/itemMenu'
import { DND_MIME, type MenuTarget, type SortField } from './storage-explorer/types'
import { useExplorerNavigation } from './storage-explorer/useExplorerNavigation'
import { useExplorerData } from './storage-explorer/useExplorerData'
import { useExplorerSorting } from './storage-explorer/useExplorerSorting'
import { useViewPrefs } from './storage-explorer/useViewPrefs'
import { useProgressiveWindow } from './storage-explorer/useProgressiveWindow'
import { useExplorerImport } from './storage-explorer/useExplorerImport'
import { useExplorerDnd } from './storage-explorer/useExplorerDnd'
import { useExplorerKeyboard } from './storage-explorer/useExplorerKeyboard'
import { useDetailsColumns } from './storage-explorer/useDetailsColumns'
import { useFileOpen } from './storage-explorer/useFileOpen'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FileContextAction {
  id:       string
  label:    string
  icon?:    React.ComponentType<{ size?: number; className?: string }>
  danger?:  boolean
  visible?: (file: FileItem) => boolean
  onClick:  (file: FileItem) => void
}

export interface StorageExplorerProps {
  /** Source de stockage. Par défaut = stockage local (`folderPathPrefix`). */
  source?:             StorageSource
  /** Préfixe racine pour la source locale par défaut (ex. "Office/Documents"). */
  folderPathPrefix?:   string
  title:               string
  onOpenFile?:         (file: FileItem) => boolean | void
  fileContextActions?: FileContextAction[]
  toolbarContent?:     React.ReactNode
  hideImport?:         boolean
  importMenuItems?:    MenuItem[]
  renderFileCard?:     (file: FileItem, defaultCard: React.ReactNode) => React.ReactNode
  emptyState?:         React.ReactNode
  acceptedMimeTypes?:  string[]
  fileTypeModuleId?:   string
  /** Dépôt d'un élément provenant d'une AUTRE source (vue double-volet). */
  onExternalDrop?:     (payload: ExternalDragItem, targetParentId: string | null) => void
  /** Synchronise la navigation avec un paramètre d'URL (ex. "path" pour le
   *  distant, "folder" pour le local). Le fil d'Ariane est reconstruit via
   *  `source.resolveAncestors`, donc valable pour des ids chemin OU UUID. */
  pathParam?:          string
  /** Expose les déclencheurs d'actions (Importer fichiers/dossier, Nouveau
   *  dossier) pour qu'un parent (ex. le bouton « Nouveau » de la sidebar) les
   *  pilote dans le dossier courant de CE composant. Appelé au montage. */
  onRegisterActions?:  (a: { importFiles: () => void; importFolder: () => void; newFolder: () => void }) => void
}

/** Charge utile d'un glisser inter-volets (sérialisée dans le dataTransfer). */
export interface ExternalDragItem { sourceKey: string; id: string; type: 'file' | 'folder'; name: string }

// ── Composant principal ──────────────────────────────────────────────────────────

export default function StorageExplorer({
  source, folderPathPrefix, title, onOpenFile, fileContextActions, toolbarContent,
  hideImport, importMenuItems, renderFileCard, emptyState, acceptedMimeTypes,
  fileTypeModuleId, onExternalDrop, pathParam, onRegisterActions,
}: StorageExplorerProps) {
  const { t, i18n } = useTranslation('drive')
  const navigate = useNavigate()
  const qc = useQueryClient()
  const src = useMemo(() => source ?? localSource({ rootPrefix: folderPathPrefix, rootName: title }), [source, folderPathPrefix, title])
  const caps = src.capabilities

  const { addUpload, updateUpload, clipboard, setClipboard, clearClipboard } = useFilesStore()
  const { updateUser } = useAuthStore()
  const { confirmState, handleConfirm, handleCancel } = useConfirm()
  const refreshUser = useCallback(() => { api.get<{ user: User }>('/me').then(res => updateUser(res.data.user)).catch(() => {}) }, [updateUser])

  const playingAudioFileId = useFilesMediaPlayerStore(s => s.file?.id ?? null)
  const playingVideoFileId = useFilesVideoPlayerStore(s => s.file?.id ?? null)
  const playingFileIds = useMemo(() => {
    const s = new Set<string>()
    if (playingAudioFileId) s.add(playingAudioFileId)
    if (playingVideoFileId) s.add(playingVideoFileId)
    return s
  }, [playingAudioFileId, playingVideoFileId])

  // ── Sélection ──────────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastSelectedIdxRef = useRef<number>(-1)
  // Curseur clavier (flèches) - id de l'item focalisé dans la grille/liste.
  const [cursorId, setCursorId] = useState<string | null>(null)
  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const handleMarqueeSelect = useCallback((ids: Set<string>, additive: boolean) => {
    setSelectedIds(additive ? prev => new Set([...prev, ...ids]) : ids)
  }, [])
  const { containerRef: marqueeContainerRef, marqueeStyle, preSelectedIds,
    onPointerDown: onMarqueeDown, onPointerMove: onMarqueeMove, onPointerUp: onMarqueeUp, onPointerCancel: onMarqueeCancel } = useMarqueeSelection(handleMarqueeSelect)

  // ── Navigation ───────────────────────────────────────────────────────────────
  const { currentFolderId, breadcrumbs, navigateTo, navigateUp } = useExplorerNavigation({ src, pathParam, onNavigated: clearSelection })

  // ── Tri / filtres / affichage ───────────────────────────────────────────────
  // Mobile n'expose que deux vues (grille 2 colonnes / liste) : les 8 modes du
  // menu « Afficher » n'ont pas de place - ni d'intérêt - sur un téléphone.
  const isMobile = useIsMobile()
  const [mobileGrid, setMobileGrid] = useState(true)
  const [showHidden, setShowHidden] = useState(false)
  const [sortField, setSortField] = useState<SortField>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [typeFilter, setTypeFilter] = useState<string | null>(null)

  // ── Menus & modales ─────────────────────────────────────────────────────────
  const [menu, setMenu] = useState<MenuTarget>(null)
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null)
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null)
  const { open: batchOpen, items: batchItems, close: closeBatch } = useBatchRenameStore()
  const [moveTarget, setMoveTarget] = useState<{ type: 'folder'; item: Folder } | { type: 'file'; item: FileItem } | null>(null)
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null)
  const [versionTarget, setVersionTarget] = useState<FileItem | null>(null)

  // ── Données via la source ───────────────────────────────────────────────────
  const { rootLoading, rootResolved, effectiveFolderId, dirKey, isLoading, error, folders, files, itemTypeMap } =
    useExplorerData({ src, caps, currentFolderId, acceptedMimeTypes, fileTypeModuleId })
  const { viewMode, changeViewMode, details, persistDetails } = useViewPrefs(dirKey, isMobile)
  const view: ViewMode = isMobile ? (mobileGrid ? 'lg' : 'details') : viewMode
  // The listing returns a folder's children, never the folder itself - fetch its
  // record so the trail's menu can offer the real actions (a folder whose
  // protection is unknown must not be offered to the bin).
  const { data: currentFolder } = useQuery({
    queryKey: ['explorer', src.key, 'folder', effectiveFolderId],
    queryFn:  () => src.statFolder!(effectiveFolderId as string),
    enabled:  !!effectiveFolderId && !!src.statFolder,
    staleTime: 30_000,
  })
  const openFolderMenu = useCallback((e: React.MouseEvent) => {
    const id = effectiveFolderId
    if (!id) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const item = currentFolder ?? ({ id, name: breadcrumbs[breadcrumbs.length - 1]?.name ?? '' } as Folder)
    setMenu({ type: 'folder', item, x: r.left, y: r.bottom + 4, fromCrumb: true })
  }, [effectiveFolderId, currentFolder, breadcrumbs])

  const { filteredFiles, sortedFolders, orderedIds } = useExplorerSorting({ folders, files, sortField, sortDir, typeFilter, showHidden })

  const detailsOpen = useRightPanelStore(s => s.activeModuleId) === DRIVE_DETAILS_PANEL
  const togglePanel = useRightPanelStore(s => s.togglePanel)
  useEffect(() => {
    const store = useRightPanelStore.getState()
    store.registerEntry({
      moduleId: DRIVE_DETAILS_PANEL, icon: Info, label: t('info.title'), panelComponent: DriveDetailsPanel,
    })
    return () => useRightPanelStore.getState().unregisterEntry(DRIVE_DETAILS_PANEL)
  }, [t])
  const detailsTarget = useMemo((): DetailsTarget => {
    if (selectedIds.size !== 1) return null
    const id = [...selectedIds][0]
    const folder = sortedFolders.find(f => f.id === id)
    if (folder) return { type: 'folder', item: folder }
    const file = filteredFiles.find(f => f.id === id)
    return file ? { type: 'file', item: file } : null
  }, [selectedIds, sortedFolders, filteredFiles])

  const detailsFolderName = breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].name : title
  useEffect(() => {
    useDetailsTargetStore.getState().setDetails(detailsTarget, detailsFolderName)
  }, [detailsTarget, detailsFolderName])



  // Touch multi-selection: on a phone, having ≥1 item selected puts the explorer
  // in "pick" mode - the header turns into a selection bar and a tap toggles
  // instead of opening. Desktop keeps click-to-select / double-click-to-open.
  const mobileSelecting = isMobile && selectedIds.size > 0
  const isMenuItemPlaying = useMemo(() => menu?.type === 'file' && playingFileIds.has((menu.item as FileItem).id), [menu, playingFileIds])
  const hasPlayingInSelection = useMemo(() => [...selectedIds].some(id => playingFileIds.has(id)), [selectedIds, playingFileIds])
  const allItemsSelected = orderedIds.length > 0 && orderedIds.every(id => selectedIds.has(id))
  const toggleSelectAll = () => allItemsSelected ? setSelectedIds(new Set()) : setSelectedIds(new Set(orderedIds))

  const { visibleCount, hasMore, loadSentinelRef } = useProgressiveWindow({
    totalItems: sortedFolders.length + filteredFiles.length,
    resetKey: `${dirKey}|${sortField}|${sortDir}|${typeFilter}|${showHidden}`,
    containerRef: marqueeContainerRef, isLoading, rootResolved,
  })
  const visibleFolders = useMemo(() => sortedFolders.slice(0, visibleCount), [sortedFolders, visibleCount])
  const visibleFiles = useMemo(
    () => filteredFiles.slice(0, Math.max(0, visibleCount - sortedFolders.length)),
    [filteredFiles, sortedFolders.length, visibleCount],
  )

  const handleItemSelect = useCallback((id: string, e: React.MouseEvent) => {
    const currentIdx = orderedIds.indexOf(id)
    // Anchor the keyboard cursor on the clicked item so arrows continue from it.
    setCursorId(id)
    if (e.shiftKey && lastSelectedIdxRef.current >= 0) {
      const from = Math.min(lastSelectedIdxRef.current, currentIdx), to = Math.max(lastSelectedIdxRef.current, currentIdx)
      const range = orderedIds.slice(from, to + 1)
      setSelectedIds(prev => { const next = new Set(prev); range.forEach(r => next.add(r)); return next })
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
      lastSelectedIdxRef.current = currentIdx
    } else { setSelectedIds(new Set([id])); lastSelectedIdxRef.current = currentIdx }
  }, [orderedIds])
  const handleItemToggle = useCallback((id: string) => {
    setCursorId(id)
    setSelectedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
    lastSelectedIdxRef.current = orderedIds.indexOf(id)
  }, [orderedIds])

  const invalidate = useCallback(() => { qc.invalidateQueries({ queryKey: ['explorer', src.key] }); refreshUser() }, [qc, src.key, refreshUser])

  // ── Import / upload ─────────────────────────────────────────────────────────
  const {
    fileInputRef, folderInputRef, handleFileInput, handleFolderInput,
    openNewFolder, newFolderOpen, setNewFolderOpen, importFiles, importEntries, conflictDialog,
  } = useExplorerImport({ src, caps, effectiveFolderId, invalidate, t, addUpload, updateUpload, onRegisterActions })

  // ── Glisser-déposer ─────────────────────────────────────────────────────────
  const { isDragOver, dragOverFolderId, setDragOverFolderId, setDraggingItem,
    handleDragEnter, handleDragLeave, handleDragOver, handleDrop } =
    useExplorerDnd({ src, caps, effectiveFolderId, selectedIds, itemTypeMap, folders, files, invalidate, importEntries, importFiles, onExternalDrop })

  // ── Suppression différée (5 s) ──────────────────────────────────────────────
  const scheduleDelete = (items: PendingItem[], forcePermanent = false) => {
    if (items.length === 0) return
    const permanent = forcePermanent || !caps.trash
    const kind: DeletionKind = permanent ? 'permanent' : 'trash'
    usePendingDeletionStore.getState().schedule({
      kind, items,
      label: t(kind === 'permanent' ? 'app.del_pending_perm' : 'app.del_pending_trash', { count: items.length }),
      undoLabel: t('common.cancel'),
      commit: (its) => {
        const refs: ItemRef[] = its.map(it => ({ id: it.id, type: it.type, name: '' }))
        return (permanent ? src.remove(refs) : src.trash(refs)).then(() => { invalidate() })
      },
    })
  }
  const deleteSelection = () => {
    scheduleDelete([...selectedIds].map(id => ({ id, type: itemTypeMap.get(id) === 'file' ? 'file' : 'folder' })))
    setSelectedIds(new Set())
  }
  const downloadSelection = () => {
    [...selectedIds].forEach(id => {
      if (itemTypeMap.get(id) !== 'file') return
      const f = files.find(x => x.id === id)
      if (f) src.download({ id: f.id, type: 'file', name: f.name })
    })
  }

  // ── Ouverture d'un fichier ──────────────────────────────────────────────────
  const { viewerFile, setViewerFile, textFile, setTextFile, openFile } = useFileOpen({ src, caps, navigate, onOpenFile })

  // ── Menu contextuel ──────────────────────────────────────────────────────────
  const openMenu = (e: React.MouseEvent, type: 'folder' | 'file', item: Folder | FileItem) => {
    e.preventDefault(); e.stopPropagation()
    // Right-clicking an item that isn't part of the current selection makes it
    // the sole selection; right-clicking within a multi-selection keeps it (so
    // the menu still acts on the whole group). On touch the kebab (⋮) is a
    // single-item affordance - selecting the item there would flip the header
    // into selection mode behind the action sheet, so we skip it.
    if (!selectedIds.has(item.id) && !(isMobile && isCoarsePointer())) {
      setSelectedIds(new Set([item.id]))
      lastSelectedIdxRef.current = orderedIds.indexOf(item.id)
    }
    setMenu({ type, item, x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 360) } as MenuTarget)
  }
  const asRef = (m: NonNullable<MenuTarget>): ItemRef => ({ id: m.item.id, type: m.type, name: m.item.name })

  const doRename = async () => {
    if (!menu) return
    if (caps.richModals) {
      const multi = selectedIds.size > 1 && selectedIds.has(menu.item.id)
      const ids = multi ? [...selectedIds] : [menu.item.id]
      const out: BatchRenameItem[] = []
      for (const id of ids) {
        const fo = folders.find(x => x.id === id); if (fo) { out.push({ id: fo.id, name: fo.name, type: 'folder' }); continue }
        const fi = files.find(x => x.id === id); if (fi) out.push({ id: fi.id, name: fi.name, type: 'file' })
      }
      useBatchRenameStore.getState().start(out)
    } else {
      const nn = await prompt({ title: t('common.rename', { defaultValue: 'Rename' }), defaultValue: menu.item.name })
      if (nn && nn !== menu.item.name) { await src.rename(asRef(menu), nn); invalidate() }
    }
  }

  const handleGetLink = async () => {
    if (!menu) return
    try {
      const opts = menu.type === 'file' ? { file_id: menu.item.id, can_download: true } : { folder_id: menu.item.id, can_download: true }
      const { share } = await filesApi.createShare(opts)
      if (share.token) await navigator.clipboard.writeText(`${window.location.origin}/api/v1/drive/share/${share.token}`)
    } catch { /* ignore */ }
  }

  const handlePaste = (targetFolderId: string | null) => {
    if (!clipboard) return
    const ref: ItemRef = { id: clipboard.id, type: clipboard.type, name: clipboard.name }
    if (clipboard.action === 'copy') src.copy(ref, targetFolderId).then(invalidate)
    else src.move(ref, targetFolderId).then(() => { invalidate(); clearClipboard() })
  }

  // ── Navigation au clavier (flèches = déplacer le curseur ; Entrée = ouvrir) ──
  useExplorerKeyboard({
    orderedIds, selectedIds, setSelectedIds, cursorId, setCursorId, lastSelectedIdxRef,
    itemTypeMap, canDelete: caps.delete, hasPlayingInSelection, scheduleDelete,
    sortedFolders, filteredFiles, navigateTo, openFile, containerRef: marqueeContainerRef,
  })

  // ── Rendu ────────────────────────────────────────────────────────────────────
  // Labels exist only for the LOCAL drive source: remote/module mounts have no
  // `drive.file`/`drive.folder` identity to attach one to.
  const labelsOf = useDriveLabels(src.key === 'local')

  const isEmpty = !isLoading && folders.length === 0 && filteredFiles.length === 0
  const hideType = (!!acceptedMimeTypes && acceptedMimeTypes.length > 0) || !!fileTypeModuleId
  const { detailsView, headerMenuItems } = useDetailsColumns({ details, persistDetails, sortedFolders, filteredFiles, t, lng: i18n.language })

  // Shared row props - the SAME operations (selection/checkbox/marquee/drag/
  // menu/open/cursor) in every view, including the details table.
  const folderRowProps = (folder: Folder) => ({
    folder, isDragTarget: dragOverFolderId === folder.id,
    selected: selectedIds.has(folder.id), preSelected: preSelectedIds.has(folder.id), focused: cursorId === folder.id, canMove: caps.move,
    onSelect: handleItemSelect,
    onOpen: () => { if (mobileSelecting) { handleItemToggle(folder.id); return } navigateTo(folder) },
    onContextMenu: (e: React.MouseEvent) => openMenu(e, 'folder', folder),
    // Long-press on touch enters selection mode; the kebab (⋮) and
    // desktop right-click keep opening the context menu.
    onLongPress: (e: React.MouseEvent) => { if (isMobile && isCoarsePointer()) { handleItemToggle(folder.id); return } openMenu(e, 'folder', folder) },
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData(DND_MIME, JSON.stringify({ sourceKey: src.key, id: folder.id, type: 'folder', name: folder.name })); if (!selectedIds.has(folder.id)) { setSelectedIds(new Set([folder.id])); lastSelectedIdxRef.current = orderedIds.indexOf(folder.id) } setDraggingItem({ type: 'folder', id: folder.id }) },
    onDragOver: (e: React.DragEvent) => { if (caps.move) { e.preventDefault(); e.stopPropagation(); setDragOverFolderId(folder.id) } },
    onDragLeave: () => setDragOverFolderId(null), onDrop: (e: React.DragEvent) => handleDrop(e, folder.id),
  })
  const fileRowProps = (file: FileItem) => ({
    file, thumb: src.thumbnail(file),
    selected: selectedIds.has(file.id), preSelected: preSelectedIds.has(file.id), focused: cursorId === file.id, canMove: caps.move,
    onSelect: handleItemSelect,
    onContextMenu: (e: React.MouseEvent) => openMenu(e, 'file', file),
    onLongPress: (e: React.MouseEvent) => { if (isMobile && isCoarsePointer()) { handleItemToggle(file.id); return } openMenu(e, 'file', file) },
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData(DND_MIME, JSON.stringify({ sourceKey: src.key, id: file.id, type: 'file', name: file.name })); if (!selectedIds.has(file.id)) { setSelectedIds(new Set([file.id])); lastSelectedIdxRef.current = orderedIds.indexOf(file.id) } setDraggingItem({ type: 'file', id: file.id }) },
    onOpen: () => { if (mobileSelecting) { handleItemToggle(file.id); return } openFile(file) },
  })

  return (
    <DriveLabelsCtx.Provider value={labelsOf}>
    <SelectingCtx.Provider value={mobileSelecting}>
    <div className="relative flex flex-col flex-1 min-h-0 overflow-hidden bg-white"
      onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={handleDragOver} onDrop={e => handleDrop(e)}>
      <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileInput} />
      {/* @ts-expect-error webkitdirectory n'est pas dans les types React */}
      <input ref={folderInputRef} type="file" hidden webkitdirectory="" directory="" onChange={handleFolderInput} />


      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-primary/5 transition-all">
          <CloudUpload size={52} className="text-primary opacity-80" />
          <p className="text-primary font-medium text-sm">{t('mfb.drop_here')}</p>
          <p className="text-primary/60 text-xs">{t('app.accepted')}</p>
        </div>
      )}

      <ExplorerHeader
        mobileSelecting={mobileSelecting} selectedIds={selectedIds} itemTypeMap={itemTypeMap}
        allItemsSelected={allItemsSelected} toggleSelectAll={toggleSelectAll} clearSelection={clearSelection}
        onDownloadSelection={downloadSelection} onDeleteSelection={deleteSelection}
        canDelete={caps.delete} hasPlayingInSelection={hasPlayingInSelection}
        title={title} breadcrumbs={breadcrumbs} onNavigate={navigateUp}
        onFolderMenu={effectiveFolderId ? openFolderMenu : undefined}
        viewControls={!isMobile ? (
          <div className="flex items-center gap-1.5">
            <ViewMenu value={viewMode} onChange={changeViewMode} showHidden={showHidden} onShowHidden={setShowHidden} t={t} />
            <button
              onClick={() => togglePanel(DRIVE_DETAILS_PANEL)}
              title={t('info.title')}
              aria-label={t('info.title')}
              aria-pressed={detailsOpen}
              className={`flex items-center justify-center h-8 w-8 rounded-full border transition-colors ${
                detailsOpen ? 'bg-primary-light text-primary border-transparent' : 'border-border text-text-secondary hover:bg-surface-1'
              }`}
            >
              <Info size={16} />
            </button>
          </div>
        ) : undefined}
        toolbarContent={toolbarContent} t={t}
      />

      {/* Contenu défilable */}
      <div ref={marqueeContainerRef} className="flex-1 min-h-0 overflow-y-auto px-6 pb-6"
        onContextMenu={e => {
          // Right-clicking empty space drops the current selection. (Item cards
          // stop propagation in openMenu, so this only fires on the backdrop.)
          setSelectedIds(new Set())
          // Sur le Drive principal (source locale, route /drive), le menu de fond est fourni
          // par le ContextMenuProvider du core (FilesContextMenuItems) → laisser remonter,
          // ne pas ouvrir le menu local (sinon DOUBLON). Pour les autres explorateurs
          // (module browsers, montages distants, système, volet distant), on gère localement
          // et on stoppe la propagation pour que le menu global ne s'ouvre pas en plus.
          if (src.key === 'local' && window.location.pathname.startsWith('/drive')) return
          e.preventDefault(); e.stopPropagation(); setEmptyMenu({ x: e.clientX, y: e.clientY })
        }}
        onPointerDown={onMarqueeDown} onPointerMove={onMarqueeMove} onPointerUp={onMarqueeUp} onPointerCancel={onMarqueeCancel}>
        {rootLoading ? (
          <div className="flex items-center gap-2 text-text-secondary text-sm py-16 justify-center"><Loader2 size={18} className="animate-spin" />{t('common.loading')}</div>
        ) : !rootResolved ? (
          <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
            <FolderIcon size={48} className="text-text-tertiary opacity-30" />
            <p className="text-text-secondary text-sm">{t('mfb.folder_not_found')}</p>
            <p className="text-text-tertiary text-xs">{t('mfb.created_on_save')}</p>
          </div>
        ) : isLoading ? (
          <div className="flex items-center gap-2 text-text-secondary text-sm py-16 justify-center"><Loader2 size={18} className="animate-spin" />{t('common.loading')}</div>
        ) : error ? (
          // Before the empty state, never after: a listing that failed leaves no
          // items either, and "dossier vide" would report a wrong fact.
          <div className="flex flex-col items-center justify-center py-24 text-center gap-3 px-6">
            <AlertTriangle size={44} className="text-warning" />
            <p className="text-text-primary text-sm font-medium">{t('app.listing_failed')}</p>
            {error.message && <p className="text-text-secondary text-xs max-w-md">{error.message}</p>}
            {error.code === 'MOUNT_CONFIG_UNREADABLE' && (
              <p className="text-text-tertiary text-xs max-w-md">{t('app.mount_reconnect_hint')}</p>
            )}
          </div>
        ) : isEmpty ? (
          emptyState ? <>{emptyState}</> : (
            <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
              <CloudUpload size={52} className="text-text-tertiary" />
              <p className="text-text-secondary text-sm">{t('app.empty_folder')}</p>
              {caps.upload && <p className="text-text-tertiary text-xs">{t('mfb.drop_hint')}</p>}
            </div>
          )
        ) : (
          // Details table sits flush under the sort bar (no vertical gap).
          <div className={!isMobile && view === 'details' ? undefined : 'space-y-6'}>
            {isMobile ? (
              // La barre de tri/vue reste utile même sans fichier (dossiers seuls).
              <MobileControlBar
                sortField={sortField} sortDir={sortDir}
                onSortField={setSortField} onSortDir={setSortDir}
                grid={mobileGrid} onGrid={setMobileGrid} t={t}
              />
            ) : files.length > 0 && (
              <SortFilterBar sortField={sortField} sortDir={sortDir} typeFilter={typeFilter}
                onSortField={setSortField} onSortDir={setSortDir} onTypeFilter={setTypeFilter} hideType={hideType} />
            )}

            {!isMobile && view === 'details' ? (
              <DetailsTable
                visibleFolders={visibleFolders} visibleFiles={visibleFiles} selectedIds={selectedIds}
                folderRowProps={folderRowProps} fileRowProps={fileRowProps}
                details={details} onDetails={persistDetails} detailsView={detailsView}
                sortField={sortField} sortDir={sortDir} onSortField={setSortField} onSortDir={setSortDir}
                onHeaderMenu={e => { e.preventDefault(); e.stopPropagation(); setHeaderMenu({ x: e.clientX, y: e.clientY }) }}
              />
            ) : (<>
            {sortedFolders.length > 0 && (
              <FoldersSection
                visibleFolders={visibleFolders} view={view} isMobile={isMobile}
                selectedIds={selectedIds} folderRowProps={folderRowProps} t={t}
              />
            )}

            {visibleFiles.length > 0 && (
              <FilesSection
                visibleFiles={visibleFiles} filteredFiles={filteredFiles} files={files} typeFilter={typeFilter}
                view={view} isMobile={isMobile} selectedIds={selectedIds}
                fileRowProps={fileRowProps} renderFileCard={renderFileCard}
                allowVideoPreview={caps.thumbnails === 'url'} t={t}
              />
            )}
            </>)}
            {/* Progressive-loading sentinel: entering view grows the window - first
                to fill the visible area, then as the user scrolls. The ring spins
                while more items remain to be mounted. */}
            {hasMore && (
              <div ref={loadSentinelRef} className="flex justify-center py-8">
                <Spinner size="lg" label={t('common.loading')} />
              </div>
            )}
          </div>
        )}
      </div>


      {menu && (
        <MenuDropdown
          pos={{ top: menu.y, left: menu.x }}
          onClose={() => setMenu(null)}
          items={[
            ...(menu.type === 'folder' && menu.fromCrumb && caps.mkdir
              ? [{ type: 'action' as const, label: t('newfolder.title'), icon: <FolderPlus size={14} />, onClick: () => { setMenu(null); openNewFolder() } },
                 { type: 'separator' as const }]
              : []),
            ...buildItemMenuItems(menu, t, {
            caps, navigate, isPlaying: isMenuItemPlaying, onClose: () => setMenu(null),
            onRename: doRename,
            onMove: () => { setMoveTarget({ type: menu.type, item: menu.item } as typeof moveTarget) },
            onStar: () => { src.star?.(asRef(menu)).then(invalidate) },
            onTrash: () => { scheduleDelete([{ id: menu.item.id, type: menu.type }]) },
            onDelete: () => { scheduleDelete([{ id: menu.item.id, type: menu.type }]) },
            onShare: () => { if (menu.type === 'file') setShareTarget({ type: 'file', item: menu.item as FileItem }); else setShareTarget({ type: 'folder', item: menu.item as Folder }) },
            onGetLink: handleGetLink,
            onInfo: () => { setSelectedIds(new Set([menu.item.id])); useRightPanelStore.getState().setActive(DRIVE_DETAILS_PANEL) },
            onEditPaint: () => { if (menu.type === 'file') useFilesPaintStore.getState().openEditor(menu.item as FileItem) },
            onVersionHistory: () => { if (menu.type === 'file') setVersionTarget(menu.item as FileItem) },
            onDownload: () => { src.download(asRef(menu)) },
            onCut: () => { setClipboard({ action: 'cut', type: menu.type, id: menu.item.id, name: menu.item.name }) },
            onCopy: () => { setClipboard({ action: 'copy', type: menu.type, id: menu.item.id, name: menu.item.name }) },
            onCopyCard: () => {
              if (menu.type !== 'file') return
              const f = menu.item as FileItem
              copyKubunoData(driveFileEnvelope({ id: f.id, name: f.name, size_bytes: f.size_bytes, mime_type: f.mime_type, folder_id: f.folder_id })).catch(() => {})
            },
            onPaste: () => handlePaste(menu.type === 'folder' ? menu.item.id : effectiveFolderId),
            onCompress: () => { const name = menu.item.name; if (menu.type === 'file') filesApi.compressDownload([menu.item.id], [], name + '.zip'); else filesApi.compressDownload([], [menu.item.id], name + '.zip') },
            onSetColor: (color) => { if (menu.type === 'folder') src.setFolderColor?.(menu.item.id, color).then(invalidate) },
            clipboard, fileContextActions,
            }),
          ]}
        />
      )}

      {marqueeStyle && marqueeStyle.width > 2 && marqueeStyle.height > 2 && (
        <div className="pointer-events-none z-50 rounded border border-primary/50 bg-primary/10" style={marqueeStyle} />
      )}

      {emptyMenu && (
        <MenuDropdown pos={{ top: emptyMenu.y, left: emptyMenu.x }} onClose={() => setEmptyMenu(null)}
          items={[
            ...(caps.mkdir ? [{ type: 'action' as const, label: t('newfolder.title'), icon: <FolderPlus size={14} />, onClick: openNewFolder }] : []),
            ...(caps.upload && !hideImport
              ? [{ type: 'action' as const, label: t('common.import'), icon: <Upload size={14} />, onClick: () => fileInputRef.current?.click() },
                 ...(importMenuItems ?? [])]
              : []),
            { type: 'separator' as const },
            { type: 'action' as const, label: t('actions.refresh'), icon: <RefreshCw size={14} />, onClick: () => { bumpAllImageCache(); invalidate() } },
          ]} />
      )}

      {headerMenu && (
        <MenuDropdown pos={{ top: headerMenu.y, left: headerMenu.x, minWidth: 240 }} onClose={() => setHeaderMenu(null)}
          items={headerMenuItems} />
      )}

      {/* Modales locales (gardées montées ; déclenchées seulement si richModals) */}
      {caps.richModals && <>
        <NewFolderModal open={newFolderOpen} onClose={() => setNewFolderOpen(false)} parentId={effectiveFolderId} />
        {batchOpen && <BatchRenameModal items={batchItems} onClose={closeBatch} />}
        <MoveModal target={moveTarget} onClose={() => setMoveTarget(null)} />
        <ShareModal target={shareTarget} onClose={() => setShareTarget(null)} />
        <VersionHistoryModal file={versionTarget} onClose={() => setVersionTarget(null)} />
      </>}

      <UploadPanel />

      {conflictDialog}
      {confirmState && <ConfirmDialog {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />}
      {viewerFile && (() => {
        const isImg = viewerFile.mime_type.startsWith('image/')
        const gallery = isImg ? filteredFiles.filter(f => f.mime_type.startsWith('image/')) : [viewerFile]
        const start = Math.max(0, gallery.findIndex(f => f.id === viewerFile.id))
        return <MediaViewer files={gallery} start={start} contentOf={f => src.content(f)} onClose={() => setViewerFile(null)} />
      })()}

      {textFile && (
        <FilesTextViewer
          name={textFile.name}
          load={() => src.readBlob({ id: textFile.id, name: textFile.name })}
          onClose={() => setTextFile(null)}
        />
      )}
    </div>
    </SelectingCtx.Provider>
    </DriveLabelsCtx.Provider>
  )
}
