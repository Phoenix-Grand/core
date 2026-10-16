/**
 * `drive.file` envelopes: card renderer + envelope builder for files copied
 * from the storage explorer ("Copier pour Kubuno"). Lives in the shared chunk
 * so the card is available to every consumer (chat, notes…) even before the
 * drive UI chunk loads. Registered on `core.data-card` at chunk load.
 */
import { useNavigate } from 'react-router-dom'
import { File as FileIcon, FileText, Image as ImageIcon, Film, Music, Archive, FolderOpen } from 'lucide-react'
import { formatSize } from '../utils/format'
import { DataTransferRegistry, type DataCardProps, type KubunoDataEnvelope } from './DataTransferRegistry'

export interface DriveFileData {
  id: string
  name: string
  size_bytes: number
  mime_type: string
  folder_id: string | null
}

export function driveFileEnvelope(f: DriveFileData): KubunoDataEnvelope {
  const href = `/drive?folder=${f.folder_id ?? ''}`
  return {
    kubuno: 1,
    type: 'drive.file',
    module: 'drive',
    title: f.name,
    text: `${f.name} - ${formatSize(f.size_bytes)}\n${location.origin}${href}`,
    href,
    data: f,
  }
}

function iconFor(mime: string) {
  if (mime.startsWith('image/')) return ImageIcon
  if (mime.startsWith('video/')) return Film
  if (mime.startsWith('audio/')) return Music
  if (mime.startsWith('text/') || mime.includes('pdf') || mime.includes('document')) return FileText
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')) return Archive
  return FileIcon
}

export function DriveFileCard({ envelope }: DataCardProps) {
  const navigate = useNavigate()
  const d = envelope.data as DriveFileData | null
  if (!d || typeof d.name !== 'string') return null
  const Icon = iconFor(d.mime_type || '')
  return (
    <div
      className="w-72 max-w-full rounded-xl border border-border bg-surface-0 overflow-hidden cursor-pointer hover:border-strong transition-colors"
      onClick={() => { if (envelope.href) navigate(envelope.href) }}
      role="button"
    >
      <div className="px-3 py-2.5 flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-lg bg-primary-light text-primary flex items-center justify-center flex-shrink-0">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-text-primary truncate">{d.name}</p>
          {/* Size/mime may be unknown in snapshots written outside the explorer. */}
          {(d.size_bytes > 0 || d.mime_type) && (
            <p className="text-[11px] text-text-tertiary truncate">
              {d.size_bytes > 0 ? formatSize(d.size_bytes) : ''}
              {d.size_bytes > 0 && d.mime_type ? ' · ' : ''}{d.mime_type || ''}
            </p>
          )}
        </div>
        <FolderOpen size={14} className="text-text-tertiary flex-shrink-0" />
      </div>
    </div>
  )
}

// Register at shared-chunk load: available to consumers on every install
// (drive's storage explorer ships with the core).
DataTransferRegistry.registerRenderer('drive', {
  types: ['drive.file'],
  Component: DriveFileCard,
})
