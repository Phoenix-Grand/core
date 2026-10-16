/**
 * Item context menu - builds the <MenuDropdown> item list, gated by the source
 * capabilities. The dynamic submenus (« Ouvrir avec » + the colour grid of
 * « Organiser ») are embedded as `custom` items rendering the existing
 * components as-is.
 */
import {
  Trash2, Pencil, Share2, Download, Image, History,
  Scissors, Copy, ClipboardPaste, Archive, Link, Info, Package,
} from 'lucide-react'
import type { MenuItem } from '@ui'
import type { Folder, FileItem } from '../api'
import type { StorageSource } from '../storageSource'
import { openWithMenuItem, organiseMenuItem } from '../filesShared'
import type { FileContextAction } from '../StorageExplorer'
import type { MenuTarget } from './types'

export interface ItemMenuHandlers {
  caps: StorageSource['capabilities']
  navigate: (p: string) => void
  onClose: () => void
  onRename: () => void
  onMove: () => void
  onStar: () => void
  onTrash: () => void
  onDelete: () => void
  onShare: () => void
  onGetLink: () => void
  onInfo: () => void
  onEditPaint: () => void
  onVersionHistory: () => void
  onDownload: () => void
  onCut: () => void
  onCopy: () => void
  onCopyCard: () => void
  onPaste: () => void
  onCompress: () => void
  onSetColor: (color: string | null) => void
  clipboard: { action: 'cut' | 'copy'; type: 'file' | 'folder'; id: string; name: string } | null
  fileContextActions?: FileContextAction[]
  isPlaying?: boolean
}

export function buildItemMenuItems(
  menu: NonNullable<MenuTarget>,
  tr: (k: string) => string,
  h: ItemMenuHandlers,
): MenuItem[] {
  const { caps, clipboard, fileContextActions, isPlaying = false } = h
  const isFile = menu.type === 'file'
  const isFolder = menu.type === 'folder'
  const starred = isFile ? (menu.item as FileItem).is_starred : (menu.item as Folder).is_starred
  const folderColor = isFolder ? (menu.item as Folder).color : null
  const isProtected = isFolder && !!(menu.item as Folder).is_protected
  const trashDisabled = isProtected || isPlaying

  const items: MenuItem[] = []

  // Actions contextuelles fournies par le parent (fichiers uniquement).
  if (isFile && fileContextActions && fileContextActions.length > 0) {
    fileContextActions
      .filter(a => (a.visible ? a.visible(menu.item as FileItem) : true))
      .forEach(action => {
        const Icon = action.icon
        items.push({
          type: 'action',
          label: action.label,
          danger: action.danger,
          icon: Icon ? <Icon size={14} /> : undefined,
          onClick: () => action.onClick(menu.item as FileItem),
        })
      })
    items.push({ type: 'separator' })
  }

  items.push({ type: 'action', label: isFolder ? tr('ctx.download_zip') : tr('common.download'), icon: <Download size={14} />, onClick: h.onDownload })
  if (caps.rename) items.push({ type: 'action', label: tr('common.rename'), shortcut: 'F2', icon: <Pencil size={14} />, onClick: h.onRename, disabled: isProtected })
  if (isFile && caps.openWith) items.push(openWithMenuItem(menu.item as FileItem, h.navigate, tr))
  if (isFile && caps.openWith && (menu.item as FileItem).mime_type.startsWith('image/'))
    items.push({ type: 'action', label: tr('ctx.edit_paint'), icon: <Image size={14} />, onClick: h.onEditPaint })

  if (caps.share || caps.getLink || caps.richModals) items.push({ type: 'separator' })
  if (caps.share) items.push({ type: 'action', label: tr('ctx.share'), icon: <Share2 size={14} />, onClick: h.onShare })
  if (caps.getLink) items.push({ type: 'action', label: tr('ctx.get_link'), icon: <Link size={14} />, onClick: h.onGetLink })
  if (caps.richModals)
    items.push(organiseMenuItem({
      isFolder, starred, folderColor, isProtected,
      onMove: h.onMove, onStar: h.onStar, onSetColor: h.onSetColor, tr,
    }))

  if (caps.move || caps.copy || caps.compress) items.push({ type: 'separator' })
  if (caps.move) items.push({ type: 'action', label: tr('ctx.cut'), icon: <Scissors size={14} />, onClick: h.onCut, disabled: isProtected })
  if (caps.copy) items.push({ type: 'action', label: tr('ctx.copy'), icon: <Copy size={14} />, onClick: h.onCopy })
  // Cross-module copy: JSON envelope pasteable as a rich card in chat, notes…
  if (isFile) items.push({ type: 'action', label: tr('ctx.copy_card'), icon: <Package size={14} />, onClick: h.onCopyCard })
  if (isFolder && clipboard && (caps.move || caps.copy)) items.push({ type: 'action', label: tr('ctx.paste'), icon: <ClipboardPaste size={14} />, onClick: h.onPaste })
  if (isFile && caps.compress) items.push({ type: 'action', label: tr('ctx.compress'), icon: <Archive size={14} />, onClick: h.onCompress })

  if (caps.info || (isFile && caps.versions)) items.push({ type: 'separator' })
  if (caps.info) items.push({ type: 'action', label: isFolder ? tr('ctx.info_folder') : tr('ctx.info_file'), icon: <Info size={14} />, onClick: h.onInfo })
  if (isFile && caps.versions) items.push({ type: 'action', label: tr('version.title'), icon: <History size={14} />, onClick: h.onVersionHistory })

  if (caps.delete) {
    items.push({ type: 'separator' })
    items.push({
      type: 'action',
      label: caps.trash ? (isFile ? tr('ctx.trash') : tr('ctx.trash_folder')) : tr('common.delete'),
      icon: <Trash2 size={14} />,
      danger: true,
      // Mirrors the Delete key wired in useExplorerKeyboard (same scheduleDelete path).
      shortcut: 'Suppr',
      disabled: trashDisabled,
      // caps.trash → onTrash (file) / onDelete (folder) ; sinon onDelete.
      onClick: () => (caps.trash && isFile ? h.onTrash : h.onDelete)(),
    })
  }

  return items
}
