/**
 * List/details/tiles/content rows. Files AND folders expose the SAME operations
 * as the icon cards (click/Ctrl/Shift selection, checkbox, marquee, drag, menu,
 * open, keyboard cursor) so the actions are identical in every view. Both are
 * the BASE components behind the themable `drive.file-row` / `drive.folder-row`
 * keys (cf. `./themed`).
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Star, MoreVertical } from 'lucide-react'
import { openable, useLongPress, useIsMobile } from '@ui'
import { usePendingKind, pendingBoxClass, pendingBoxStyle } from '@kubuno/sdk'
import { formatSize, type Folder, type FileItem } from '../api'
import type { ThumbSpec } from '../storageSource'
import { FolderGlyph } from '../FolderGlyph'
import { LabelDots } from '../LabelDots'
import { Thumb } from './Thumb'
import { VersionBadge } from './VersionBadge'
import { rowAccentShadow, withRowShadow } from './rowStyles'
import { fileCellText, folderCellText, type DetailsColsView } from './detailsModel'

export function FileRowBase({ file, thumb, selected, preSelected, focused, canMove, mergeTop, mergeBottom, zebra, onSelect, onContextMenu, onLongPress, onOpen, onDragStart, density = 'normal', hideMeta = false, cols }: {
  file: FileItem; thumb: ThumbSpec
  selected: boolean; preSelected?: boolean; focused?: boolean; canMove: boolean; mergeTop?: boolean; mergeBottom?: boolean; zebra?: boolean
  onSelect: (id: string, e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void; onLongPress?: (e: React.MouseEvent) => void; onOpen: () => void; onDragStart?: (e: React.DragEvent) => void
  density?: 'compact' | 'normal'; hideMeta?: boolean; cols?: DetailsColsView
}) {
  const { t, i18n } = useTranslation('drive')
  const pendingKind = usePendingKind(file.id)
  const updated = new Date(file.updated_at).toLocaleDateString(i18n.language, { day: '2-digit', month: 'short', year: 'numeric' })
  // Mobile: the date/size columns don't fit next to the name, so they collapse
  // into a subtitle under it and the row grows to a comfortable tap target.
  const isMobile = useIsMobile()
  const pad = isMobile ? 'px-2 py-3' : density === 'compact' ? 'px-3 py-1' : 'px-4 py-2.5'
  const thumbC = isMobile ? 'w-10 h-10' : density === 'compact' ? 'w-6 h-6' : 'w-8 h-8'
  const longPress = useLongPress(onLongPress ?? onContextMenu)
  return (
    <div data-selectable-id={file.id}
      draggable={canMove} onDragStart={onDragStart}
      className={`group relative flex items-center gap-3 ${pad} transition-colors cursor-default select-none
        ${selected ? 'bg-[#e8f0fe]' : preSelected ? 'bg-[#e8f0fe]' : focused ? 'bg-surface-1' : zebra ? 'bg-[#fdfdfc] hover:bg-surface-2' : 'bg-white hover:bg-surface-1'} ${pendingBoxClass(pendingKind)}`}
      style={withRowShadow(pendingBoxStyle(pendingKind), rowAccentShadow({ selected, preSelected, focused, mergeTop, mergeBottom }))} onContextMenu={onContextMenu}
      {...longPress}
      {...openable<React.MouseEvent>({ select: (e) => { e.preventDefault(); onSelect(file.id, e) }, open: (e) => { e.preventDefault(); onOpen() } })}>
      <div className={`shrink-0 ${thumbC} flex items-center justify-center rounded overflow-hidden bg-surface-2`}>
        <Thumb spec={thumb} file={file} className="w-full h-full object-cover" />
      </div>
      {cols && !isMobile ? (<>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <p className="text-xs text-text-primary truncate">{file.name}</p>
          <VersionBadge file={file} variant="inline" />
          {file.is_starred && <Star size={13} className="shrink-0 fill-yellow-400 text-yellow-400" />}
        </div>
        {cols.order.map(key => (
          key === 'labels'
            ? <span key={key} className="shrink-0 flex items-center overflow-hidden" style={{ width: cols.widths[key] }}><LabelDots kind="file" id={file.id} size={13} /></span>
            : <span key={key} className={`text-xs text-text-tertiary shrink-0 truncate ${key === 'size' ? 'text-right' : ''}`} style={{ width: cols.widths[key] }}>{fileCellText(key, file, t, i18n.language)}</span>
        ))}
      </>) : (<>
      <div className="flex-1 min-w-0">
        {/* The badge follows the name rather than sitting on the thumbnail: at
          * compact density that square is 24 px, where a figure is unreadable. */}
        <div className="flex items-center gap-1.5 min-w-0">
          <p className={`${isMobile ? 'text-[15px]' : 'text-sm'} text-text-primary truncate`}>{file.name}</p>
          <VersionBadge file={file} variant="inline" />
        </div>
        {isMobile ? (
          <p className="text-xs text-text-tertiary truncate">
            {file.updated_at > '1971' && `${t('row.modified')} ${updated} · `}{formatSize(file.size_bytes)}
          </p>
        ) : null}
      </div>
      {!isMobile && !hideMeta && file.updated_at > '1971' && <span className="text-xs text-text-tertiary shrink-0 w-28 text-right">{updated}</span>}
      {!isMobile && !hideMeta && <span className="text-xs text-text-tertiary shrink-0 w-20 text-right">{formatSize(file.size_bytes)}</span>}
      <LabelDots kind="file" id={file.id} size={11} />
      {file.is_starred && <Star size={13} className="shrink-0 fill-yellow-400 text-yellow-400" />}
      </>)}
      <button data-no-drag className="shrink-0 p-2 lg:p-1.5 rounded-full hover:bg-surface-2 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity" onClick={e => { e.stopPropagation(); onContextMenu(e) }}>
        <MoreVertical size={14} className="text-text-secondary" />
      </button>
    </div>
  )
}

// FolderRow - pendant de FileRow pour les dossiers (vues non-icônes) : mêmes
// opérations + cible de dépôt (déplacer DANS le dossier).
export function FolderRowBase({ folder, isDragTarget, selected, preSelected, focused, canMove, mergeTop, mergeBottom, zebra, onSelect, onOpen, onContextMenu, onLongPress, onDragStart, onDragOver, onDragLeave, onDrop, density = 'normal', cols }: {
  folder: Folder; isDragTarget: boolean; selected: boolean; preSelected?: boolean; focused?: boolean; canMove: boolean; mergeTop?: boolean; mergeBottom?: boolean; zebra?: boolean
  onSelect: (id: string, e: React.MouseEvent) => void; onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void; onLongPress?: (e: React.MouseEvent) => void; onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void; onDrop: (e: React.DragEvent) => void
  density?: 'compact' | 'normal'; cols?: DetailsColsView
}) {
  const { t, i18n } = useTranslation('drive')
  const pendingKind = usePendingKind(folder.id)
  const isMobile = useIsMobile()
  const updated = new Date(folder.updated_at).toLocaleDateString(i18n.language, { day: '2-digit', month: 'short', year: 'numeric' })
  const pad = isMobile ? 'px-2 py-3' : density === 'compact' ? 'px-3 py-1' : 'px-4 py-2.5'
  const longPress = useLongPress(onLongPress ?? onContextMenu)
  return (
    <div data-selectable-id={folder.id}
      draggable={canMove} onDragStart={onDragStart} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      className={`group relative flex items-center gap-3 ${pad} transition-colors cursor-default select-none
        ${isDragTarget ? 'bg-primary/10' : selected ? 'bg-[#e8f0fe]' : preSelected ? 'bg-[#e8f0fe]' : focused ? 'bg-surface-1' : zebra ? 'bg-[#fdfdfc] hover:bg-surface-2' : 'bg-white hover:bg-surface-1'} ${pendingBoxClass(pendingKind)}`}
      style={withRowShadow(pendingBoxStyle(pendingKind), rowAccentShadow({ dragTarget: isDragTarget, selected, preSelected, focused, mergeTop, mergeBottom }))} onContextMenu={onContextMenu}
      {...longPress}
      {...openable<React.MouseEvent>({ select: (e) => { e.preventDefault(); onSelect(folder.id, e) }, open: (e) => { e.preventDefault(); e.stopPropagation(); onOpen() } })}>
      {cols && !isMobile ? (<>
        {/* Glyph wrapped in a w-8 box so the name column lines up with file rows. */}
        <div className="shrink-0 w-8 flex items-center justify-center"><FolderGlyph folder={folder} size={20} /></div>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="text-xs text-text-primary truncate">{folder.name}</span>
          {folder.is_starred && <Star size={13} className="shrink-0 fill-yellow-400 text-yellow-400" />}
        </div>
        {cols.order.map(key => (
          key === 'labels'
            ? <span key={key} className="shrink-0 flex items-center overflow-hidden" style={{ width: cols.widths[key] }}><LabelDots kind="folder" id={folder.id} size={13} /></span>
            : <span key={key} className={`text-xs text-text-tertiary shrink-0 truncate ${key === 'size' ? 'text-right' : ''}`} style={{ width: cols.widths[key] }}>{folderCellText(key, folder, t, i18n.language)}</span>
        ))}
      </>) : (<>
      <FolderGlyph folder={folder} size={isMobile ? 26 : 20} className="shrink-0" />
      {isMobile ? (
        <div className="flex-1 min-w-0">
          <p className="text-[15px] text-text-primary truncate">{folder.name}</p>
          <p className="text-xs text-text-tertiary truncate">{t('row.modified')} {updated}</p>
        </div>
      ) : (
        <span className="flex-1 min-w-0 text-sm text-text-primary truncate">{folder.name}</span>
      )}
      <LabelDots kind="folder" id={folder.id} size={11} />
      {folder.is_starred && <Star size={13} className="shrink-0 fill-yellow-400 text-yellow-400" />}
      </>)}
      <button data-no-drag className="shrink-0 p-2 lg:p-1.5 rounded-full hover:bg-surface-2 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity" onClick={e => { e.stopPropagation(); onContextMenu(e) }}>
        <MoreVertical size={14} className="text-text-secondary" />
      </button>
    </div>
  )
}
