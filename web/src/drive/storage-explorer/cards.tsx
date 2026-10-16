/**
 * Icon-view cards: a folder chip and a file card (thumbnail + extension badge).
 * Both are the BASE components behind the themable `drive.folder-card` /
 * `drive.file-card` keys (cf. `./themed`).
 */
import React from 'react'
import { Star, MoreVertical } from 'lucide-react'
import { openable, useLongPress, useIsMobile } from '@ui'
import { usePendingKind, pendingBoxClass, pendingBoxStyle } from '@kubuno/sdk'
import type { Folder, FileItem } from '../api'
import type { ThumbSpec } from '../storageSource'
import { FolderGlyph } from '../FolderGlyph'
import { LabelDots } from '../LabelDots'
import { getFileIcon } from '../filesShared'
import { Thumb } from './Thumb'
import { VersionBadge } from './VersionBadge'

// ── FolderCard ─────────────────────────────────────────────────────────────────

export function FolderCardBase({ folder, isDragTarget, selected, preSelected, focused, canMove, onSelect, onOpen, onContextMenu, onLongPress, onDragStart, onDragOver, onDragLeave, onDrop }: {
  folder: Folder; isDragTarget: boolean; selected: boolean; preSelected?: boolean; focused?: boolean; canMove: boolean
  onSelect: (id: string, e: React.MouseEvent) => void; onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void; onLongPress?: (e: React.MouseEvent) => void; onDragStart: (e: React.DragEvent) => void; onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void; onDrop: (e: React.DragEvent) => void
}) {
  const pendingKind = usePendingKind(folder.id)
  const longPress = useLongPress(onLongPress ?? onContextMenu)
  // Mobile: folder cards are full-width (one per line), so the name gets a
  // comfortable single truncated line and a taller tap target.
  const isMobile = useIsMobile()
  return (
    <div data-selectable-id={folder.id}
      className={`group relative flex items-center ${isMobile ? 'gap-3 px-3 py-3' : 'gap-2.5 px-3 py-2.5'} rounded-xl border transition-all cursor-default select-none min-w-0
        ${isDragTarget ? 'border-primary bg-primary/10 ring-2 ring-primary/20'
          : selected ? 'border-primary ring-2 ring-primary ring-inset bg-[#c9defa]'
          : preSelected ? 'border-primary/50 bg-[#c9defa]'
          : focused ? 'border-primary/60 ring-2 ring-primary/20 bg-[#f3f4f5]'
          : 'border-[#e8eaed] bg-[#f3f4f5] hover:border-border hover:bg-[#e4ecf7] hover:shadow-sm'} ${pendingBoxClass(pendingKind)}`}
      style={pendingBoxStyle(pendingKind)} draggable={canMove}
      {...openable<React.MouseEvent>({
        select: (e) => { e.preventDefault(); onSelect(folder.id, e) },
        open:   (e) => { e.preventDefault(); e.stopPropagation(); onOpen() },
      })}
      {...longPress}
      onContextMenu={onContextMenu} onDragStart={onDragStart} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <FolderGlyph folder={folder} size={isMobile ? 24 : 20} className="shrink-0" />
      <span className={`text-text-primary flex-1 min-w-0 ${isMobile ? 'text-[15px] truncate' : 'text-sm truncate'}`}>{folder.name}</span>
      <LabelDots kind="folder" id={folder.id} size={isMobile ? 12 : 11} />
      {folder.is_starred && <Star size={isMobile ? 14 : 12} className="shrink-0 fill-yellow-400 text-yellow-400" />}
      <button className={`shrink-0 rounded-full hover:bg-black/10 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity ${isMobile ? 'p-1.5' : 'p-1'}`} onClick={e => { e.stopPropagation(); onContextMenu(e) }}>
        <MoreVertical size={isMobile ? 16 : 14} className="text-text-secondary" />
      </button>
    </div>
  )
}

// ── FileCard (vue icônes) ────────────────────────────────────────────────────────

export function FileCardBase({ file, thumb, selected, preSelected, focused, canMove, allowVideoPreview, onSelect, onContextMenu, onLongPress, onDragStart, onOpen, thumbH = 128, iconScale = 1, dense = false }: {
  file: FileItem; thumb: ThumbSpec; selected: boolean; preSelected?: boolean; focused?: boolean; canMove: boolean; allowVideoPreview: boolean
  onSelect: (id: string, e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void; onLongPress?: (e: React.MouseEvent) => void; onDragStart: (e: React.DragEvent) => void; onOpen: () => void
  thumbH?: number; iconScale?: number; dense?: boolean
}) {
  const pendingKind = usePendingKind(file.id)
  const isImage = file.mime_type.startsWith('image/')
  const isVideo = file.mime_type.startsWith('video/')
  const hasBigThumb = (thumb.kind !== 'none') && (isImage || (isVideo && allowVideoPreview))
  // Extension badge shown on the thumbnail (e.g. "DOCX", "PDF"). Skipped for
  // dotless names, hidden files (".gitignore") and non-extension-looking tails.
  const badgeExt = (() => {
    const dot = file.name.lastIndexOf('.')
    if (dot <= 0 || dot === file.name.length - 1) return ''
    const e = file.name.slice(dot + 1)
    return /^[a-z0-9]{1,5}$/i.test(e) ? e.toUpperCase() : ''
  })()
  const longPress = useLongPress(onLongPress ?? onContextMenu)
  const isMobile = useIsMobile()
  return (
    <div data-selectable-id={file.id}
      className={`group relative rounded-xl border hover:shadow-[0_1px_6px_rgba(0,0,0,0.1)] transition-all min-w-0 select-none cursor-default
        ${selected ? 'border-primary ring-2 ring-primary ring-inset bg-[#ddeafc]' : preSelected ? 'border-primary/50 bg-[#ddeafc]' : focused ? 'border-primary/60 ring-2 ring-primary/20 bg-surface-1' : 'border-[#e8eaed] bg-surface-1 hover:border-border hover:bg-[#e4ecf7]'} ${pendingBoxClass(pendingKind)}`}
      style={pendingBoxStyle(pendingKind)} draggable={canMove}
      onContextMenu={onContextMenu} onDragStart={onDragStart}
      {...longPress}
      {...openable<React.MouseEvent>({
        select: (e) => { e.preventDefault(); onSelect(file.id, e) },
        open:   (e) => { e.preventDefault(); onOpen() },
      })}>
      {/* En-tête : icône de type + nom + étoile + menu */}
      <div className={`flex items-center ${isMobile ? 'gap-1.5 px-2 py-1.5 items-start' : `gap-2 ${dense ? 'px-2 h-8' : 'px-3 h-10'}`}`}>
        <span className="shrink-0 flex items-center [&_svg]:w-[18px] [&_svg]:h-[18px]">{getFileIcon(file.mime_type, file.name)}</span>
        <span
          className={`text-text-primary flex-1 min-w-0 ${isMobile ? 'text-sm leading-tight line-clamp-2 break-words' : `${dense ? 'text-xs' : 'text-sm'} truncate`}`}
          title={file.name}
        >{file.name}</span>
        <LabelDots kind="file" id={file.id} size={11} />
        {file.is_starred && <Star size={12} className="shrink-0 fill-yellow-400 text-yellow-400" />}
        <button className="shrink-0 -mr-1 p-1 rounded-full hover:bg-black/10 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity" onClick={e => { e.stopPropagation(); onContextMenu(e) }}>
          <MoreVertical size={14} className="text-text-secondary" />
        </button>
      </div>
      {/* Aperçu : miniature pleine zone, sinon grande icône de type centrée */}
      <div className={`relative overflow-hidden rounded-lg bg-white ${dense ? 'mx-1.5 mb-1.5' : 'mx-2 mb-2'}`} style={{ height: thumbH }}>
        {/* Kept revisions, top-left - the extension badge holds the opposite corner. */}
        <VersionBadge file={file} variant="overlay" />
        {hasBigThumb ? (
          <Thumb spec={thumb} file={file} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <div style={{ transform: `scale(${iconScale})` }}>{getFileIcon(file.mime_type, file.name)}</div>
          </div>
        )}
      </div>
      {/* Extension badge - bottom-right of the preview. The outer span uses
          `background-color: inherit` so its padding ring matches the card's own
          background in EVERY state (hover/selected/focused) live, carving a
          seamless notch into the white preview area around the white pill.
          Inline styles so it never depends on arbitrary Tailwind utilities. */}
      {badgeExt && (
        <span
          className="absolute z-10 inline-block pointer-events-none"
          style={{
            bottom: '4px', right: '4px',
            padding: dense ? '5px' : '7px', borderRadius: dense ? '10px 0 0 0' : '12px 0 0 0',
            backgroundColor: 'inherit',
            // Match the card's `transition-all` (150ms) so the notch colour
            // animates in lockstep with the card background on hover/select.
            transition: 'background-color 150ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <span
            className="block font-semibold uppercase"
            style={{
              fontSize: '10px', lineHeight: 1, padding: '2px 5px', letterSpacing: '0.04em',
              borderRadius: '6px', color: 'var(--color-text-secondary)',
            }}
          >
            {badgeExt}
          </span>
        </span>
      )}
    </div>
  )
}
