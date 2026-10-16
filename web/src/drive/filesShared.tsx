/**
 * filesShared - éléments communs aux deux navigateurs de fichiers
 * (`FilesApp` et `ModuleFileBrowser`) : palette de couleurs de dossier, icône de
 * fichier par type, et les sous-menus contextuels « Ouvrir avec » et « Organiser ».
 *
 * Source unique : éviter la double maintenance (toute correction ici profite aux
 * deux navigateurs).
 */

import { type ReactNode, useState, useRef, useLayoutEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  AppWindow, ChevronRight, FolderInput, Move, Star, Palette,
  Image, Film, Music, FileText, Package, Box, Type,
} from 'lucide-react'
import { filesApi, type FileItem } from './api'
import { SlotRegistry } from '@kubuno/sdk'
import { FileTypeRegistry } from '@kubuno/sdk'
import { getIcon } from '@kubuno/sdk'
import { useModulesStore } from '@kubuno/sdk'
import { FilesOpenWithContext } from './FilesOpenWithContext'
import { type MenuItem } from '@ui'

type NavFn = (p: string) => void

// ── Couleurs de dossier ─────────────────────────────────────────────────────────

export const FOLDER_COLORS: Array<string | null> = [
  null,
  '#e53935', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5',
  '#2196f3', '#03a9f4', '#00bcd4', '#009688', '#4caf50',
  '#8bc34a', '#cddc39', '#ffc107', '#ff9800', '#ff5722',
  '#795548', '#9e9e9e', '#607d8b',
]

// ── Icône de fichier par type ────────────────────────────────────────────────────

export function getFileIcon(mimeType: string, name?: string): ReactNode {
  const e0 = (name ?? '').split('.').pop()?.toLowerCase() ?? ''
  if (mimeType.includes('vnd.kubuno') || e0.startsWith('kb')) {
    const iconName = FileTypeRegistry.iconFor({ mime_type: mimeType, name: name ?? '' })
    if (iconName) { const Ic = getIcon(iconName); return <Ic size={34} className="text-primary" strokeWidth={1.6} /> }
  }
  if (mimeType.startsWith('image/'))  return <Image   size={36} className="text-blue-400" />
  if (mimeType.startsWith('video/'))  return <Film    size={36} className="text-purple-400" />
  if (mimeType.startsWith('audio/'))  return <Music   size={36} className="text-green-400" />
  if (mimeType === 'application/pdf') return <FileText size={36} className="text-red-400" />
  if (mimeType.includes('word') || mimeType.includes('opendocument.text'))
    return <FileText size={36} className="text-blue-500" />
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet') || mimeType.includes('csv'))
    return <FileText size={36} className="text-green-500" />
  if (mimeType.includes('powerpoint') || mimeType.includes('presentation'))
    return <FileText size={36} className="text-orange-400" />
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z'))
    return <Package size={36} className="text-text-tertiary" />
  const ext = (name ?? '').split('.').pop()?.toLowerCase()
  if (mimeType.startsWith('model/') || (ext && ['glb', 'gltf', 'obj', 'stl', 'ply'].includes(ext)))
    return <Box size={36} className="text-cyan-500" />
  if (
    mimeType.startsWith('font/') ||
    mimeType === 'application/x-font-ttf' || mimeType === 'application/x-font-otf' ||
    mimeType === 'application/font-woff'  || mimeType === 'application/font-woff2'  ||
    mimeType === 'application/vnd.ms-fontobject' ||
    (ext && ['ttf', 'otf', 'woff', 'woff2', 'eot'].includes(ext))
  )
    return <Type size={36} className="text-violet-500" />
  return <FileText size={36} className="text-text-tertiary" />
}

// ── Sous-menu « Ouvrir avec » ─────────────────────────────────────────────────────

export function OpenWithSubmenu({ file, onClose }: { file: FileItem; onClose: () => void }) {
  const { t } = useTranslation('drive')
  const navigate          = useNavigate()
  const [open, setOpen]   = useState(false)
  const timeoutRef        = useRef<ReturnType<typeof setTimeout> | null>(null)
  const subRef            = useRef<HTMLDivElement>(null)
  const activeModules     = useModulesStore(s => s.activeModules)
  const activeIds         = new Set(activeModules.map(m => m.module_id))
  // Ne garder que les contributeurs actifs ET réellement applicables au fichier
  // (un contributeur sans prédicat est supposé toujours applicable). C'est cette
  // liste - et non le simple nombre d'enregistrements - qui détermine si le
  // sous-menu aura du contenu, donc s'il faut griser « Ouvrir avec ».
  const contributors      = SlotRegistry.getSlot('files-open-with')
    .filter(e => activeIds.has(e.moduleId))
    .filter(e => !e.match || e.match(file))
  const openers           = FileTypeRegistry.openersFor(file)

  const handleEnter = () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); setOpen(true) }
  const handleLeave = () => { timeoutRef.current = setTimeout(() => setOpen(false), 120) }

  useLayoutEffect(() => {
    const el = subRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.right > window.innerWidth - 8) {
      el.style.left = 'auto'
      el.style.right = '100%'
    } else {
      el.style.left = ''
      el.style.right = ''
    }
  }, [open])

  const chooseOpener = (decl: { moduleId: string; open?: (f: FileItem, nav: (p: string) => void) => void }) => {
    decl.open?.(file, navigate)
    filesApi.setOpenWith(file.id, decl.moduleId).catch(() => {})
    onClose()
  }

  // Aucune app ni contributeur : « Ouvrir avec » désactivé (grisé), pas de sous-menu.
  if (openers.length === 0 && contributors.length === 0) {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        className="flex items-center justify-between w-full px-3 py-2 text-sm
                   text-text-tertiary cursor-not-allowed select-none"
      >
        <span className="flex items-center gap-3">
          <AppWindow size={14} />
          {t('ctx.open_with')}
        </span>
        <ChevronRight size={14} className="text-text-tertiary opacity-50" />
      </button>
    )
  }

  return (
    <FilesOpenWithContext.Provider value={file}>
      <div className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
        <button
          className="flex items-center justify-between w-full px-3 py-2 text-sm
                     text-text-primary hover:bg-surface-1 cursor-pointer"
        >
          <span className="flex items-center gap-3">
            <AppWindow size={14} />
            {t('ctx.open_with')}
          </span>
          <ChevronRight size={14} className="text-text-tertiary" />
        </button>
        {open && (
          <div
            ref={subRef}
            className="absolute left-full top-0 z-[210] bg-white border border-border rounded-[5px]
                       shadow-lg py-1 min-w-[190px]"
            onMouseEnter={handleEnter}
            onMouseLeave={handleLeave}
          >
            {openers.map(decl => {
              const Ic = decl.icon ? getIcon(decl.icon) : AppWindow
              return (
                <button
                  key={decl.moduleId}
                  onClick={() => chooseOpener(decl)}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-primary
                             hover:bg-surface-1 cursor-pointer outline-none transition-colors"
                >
                  <Ic size={15} className="text-text-secondary" />
                  {decl.label}
                </button>
              )
            })}
            {contributors.map(({ moduleId, Component }) => <Component key={moduleId} />)}
          </div>
        )}
      </div>
    </FilesOpenWithContext.Provider>
  )
}

// ── Sous-menu « Organiser » ───────────────────────────────────────────────────────

export function OrganiserSubmenu({
  isFolder,
  starred,
  folderColor,
  isProtected,
  disabled,
  onMove,
  onStar,
  onSetColor,
  onClose,
}: {
  isFolder: boolean
  starred: boolean
  folderColor?: string | null
  isProtected?: boolean
  disabled?: boolean
  onMove: () => void
  onStar: () => void
  onSetColor: (color: string | null) => void
  onClose: () => void
}) {
  const { t } = useTranslation('drive')
  const [open, setOpen] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const subRef     = useRef<HTMLDivElement>(null)
  const handleEnter = () => { if (disabled) return; if (timeoutRef.current) clearTimeout(timeoutRef.current); setOpen(true) }
  const handleLeave = () => { timeoutRef.current = setTimeout(() => setOpen(false), 120) }

  useLayoutEffect(() => {
    const el = subRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.right > window.innerWidth - 8) {
      el.style.left = 'auto'
      el.style.right = '100%'
    } else {
      el.style.left = ''
      el.style.right = ''
    }
  }, [open])

  return (
    <div className={`relative ${disabled ? 'opacity-40' : ''}`} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button disabled={disabled} className={`flex items-center justify-between w-full px-3 py-2 text-sm
                         text-text-primary outline-none ${disabled ? 'cursor-not-allowed' : 'hover:bg-surface-1 cursor-pointer'}`}>
        <span className="flex items-center gap-3">
          <FolderInput size={14} />
          {t('ctx.organize')}
        </span>
        <ChevronRight size={14} className="text-text-tertiary" />
      </button>
      {open && (
        <div
          ref={subRef}
          className="absolute left-full top-0 z-[210] bg-white border border-border rounded-[5px]
                     shadow-lg py-1 min-w-[210px]"
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
        >
          <button
            onClick={isProtected ? undefined : () => { onMove(); onClose() }}
            disabled={isProtected}
            className={`w-full flex items-center gap-3 px-3 py-2 text-sm text-text-primary outline-none
                        ${isProtected ? 'opacity-40 cursor-not-allowed' : 'hover:bg-surface-1 cursor-pointer'}`}
          >
            <Move size={14} />
            {t('ctx.move')}
          </button>
          <div className="my-1 h-px bg-border mx-2" />
          <button
            onClick={() => { onStar(); onClose() }}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-primary
                       hover:bg-surface-1 cursor-pointer outline-none"
          >
            <Star size={14} className={starred ? 'fill-yellow-400 text-yellow-400' : ''} />
            {starred ? t('ctx.unstar') : t('ctx.star')}
          </button>
          {isFolder && (
            <>
              <div className="my-1 h-px bg-border mx-2" />
              <div className="px-3 py-2">
                <p className="flex items-center gap-1.5 text-xs text-text-tertiary mb-2 font-medium">
                  <Palette size={12} />
                  {t('ctx.folder_color')}
                </p>
                <div className="grid grid-cols-6 gap-1.5">
                  {FOLDER_COLORS.map((c, i) => (
                    <button
                      key={i}
                      title={c ?? t('ctx.no_color')}
                      onClick={() => { onSetColor(c); onClose() }}
                      className="w-6 h-6 rounded-full border-2 flex items-center justify-center
                                 hover:scale-110 transition-transform"
                      style={{
                        backgroundColor: c ?? '#f1f3f4',
                        borderColor: c === folderColor ? '#1a73e8' : (c ? c : '#dadce0'),
                        boxShadow: c === folderColor ? `0 0 0 2px #fff, 0 0 0 4px #1a73e8` : undefined,
                      }}
                    >
                      {c === null && <span style={{ fontSize: 10, color: '#80868b', lineHeight: 1 }}>✕</span>}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Sous-menus NATIFS (type 'submenu' du MenuDropdown) ───────────────────────────
// Ces helpers remplacent les composants `custom` ci-dessus : le MenuDropdown rend
// alors « Ouvrir avec » / « Organiser » avec le MÊME style que les autres items
// (icône/police/espacement) et déploie le sous-menu dans son propre portal - donc
// jamais rogné par le défilement du menu parent. Source unique pour les deux
// navigateurs de fichiers (StorageExplorer + module Drive).

/** Grille de couleurs de dossier, embarquée dans le sous-menu « Organiser ». */
export function FolderColorGrid({ current, onPick }: { current?: string | null; onPick: (c: string | null) => void }) {
  const { t } = useTranslation('drive')
  return (
    <div className="px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs text-text-tertiary mb-2 font-medium">
        <Palette size={12} />
        {t('ctx.folder_color')}
      </p>
      <div className="grid grid-cols-6 gap-1.5">
        {FOLDER_COLORS.map((c, i) => (
          <button
            key={i}
            title={c ?? t('ctx.no_color')}
            onClick={() => onPick(c)}
            className="w-6 h-6 rounded-full border-2 flex items-center justify-center hover:scale-110 transition-transform"
            style={{
              backgroundColor: c ?? '#f1f3f4',
              borderColor: c === current ? '#1a73e8' : (c ? c : '#dadce0'),
              boxShadow: c === current ? '0 0 0 2px #fff, 0 0 0 4px #1a73e8' : undefined,
            }}
          >
            {c === null && <span style={{ fontSize: 10, color: '#80868b', lineHeight: 1 }}>✕</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Construit l'item de menu natif « Ouvrir avec » (apps + contributeurs de modules). */
export function openWithMenuItem(file: FileItem, navigate: NavFn, tr: (k: string) => string): MenuItem {
  const activeIds = new Set(useModulesStore.getState().activeModules.map(m => m.module_id))
  const openers = FileTypeRegistry.openersFor(file)
  const contributors = SlotRegistry.getSlot('files-open-with')
    .filter(e => activeIds.has(e.moduleId))
    .filter(e => !e.match || e.match(file))

  const items: MenuItem[] = openers.map(decl => {
    const Ic = decl.icon ? getIcon(decl.icon) : AppWindow
    return {
      type: 'action' as const,
      label: decl.label,
      icon: <Ic size={14} />,
      onClick: () => { decl.open?.(file, navigate); filesApi.setOpenWith(file.id, decl.moduleId).catch(() => {}) },
    }
  })
  for (const { moduleId, Component } of contributors) {
    items.push({
      type: 'custom',
      render: () => (
        <FilesOpenWithContext.Provider value={file}>
          <Component key={moduleId} />
        </FilesOpenWithContext.Provider>
      ),
    })
  }

  return {
    type: 'submenu',
    label: tr('ctx.open_with'),
    icon: <AppWindow size={14} />,
    disabled: items.length === 0,
    items,
  }
}

/** Construit l'item de menu natif « Organiser » (Déplacer / Étoiler / couleur). */
export function organiseMenuItem(opts: {
  isFolder: boolean
  starred: boolean
  folderColor?: string | null
  isProtected?: boolean
  disabled?: boolean
  onMove: () => void
  onStar: () => void
  onSetColor: (c: string | null) => void
  tr: (k: string) => string
}): MenuItem {
  const { isFolder, starred, folderColor, isProtected, disabled, onMove, onStar, onSetColor, tr } = opts
  const items: MenuItem[] = [
    { type: 'action', label: tr('ctx.move'), icon: <Move size={14} />, onClick: onMove, disabled: isProtected },
    { type: 'separator' },
    {
      type: 'action',
      label: starred ? tr('ctx.unstar') : tr('ctx.star'),
      icon: <Star size={14} className={starred ? 'fill-yellow-400 text-yellow-400' : ''} />,
      onClick: onStar,
    },
  ]
  if (isFolder) {
    items.push({ type: 'separator' })
    items.push({ type: 'custom', render: (close) => <FolderColorGrid current={folderColor} onPick={(c) => { onSetColor(c); close() }} /> })
  }
  return {
    type: 'submenu',
    label: tr('ctx.organize'),
    icon: <FolderInput size={14} />,
    disabled,
    items,
  }
}
