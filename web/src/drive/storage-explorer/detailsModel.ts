/**
 * Details-view model: which optional columns exist, their defaults, and how a
 * folder/file renders into each cell. Pure data + formatting - no React.
 */
import { formatSize, type Folder, type FileItem } from '../api'
import { mimeLabel } from '../FileInfoModal'
import type { SortField, TFunc } from './types'

/** Sort fields reachable from the details header (same union as the toolbar). */
export type DetailsSortField = SortField

// Optional (toggleable) columns of the details table, in display order. « Nom »
// is always shown first and is not part of this list.
export type DetailsColKey = 'labels' | 'date' | 'type' | 'size' | 'created'
export const DETAILS_COL_ORDER: DetailsColKey[] = ['labels', 'date', 'type', 'size', 'created']
// Per-column → sort field (a header click sorts by it). Columns absent here
// (e.g. « Étiquettes ») aren't sortable.
export const DETAILS_COL_SORT: Partial<Record<DetailsColKey, DetailsSortField>> = { date: 'date', type: 'type', size: 'size', created: 'created' }

// Details-view settings remembered PER FOLDER: column widths + which columns
// are visible.
export type DetailsSettings = { widths: Record<DetailsColKey, number>; visible: Record<DetailsColKey, boolean> }
export const DETAILS_DEFAULT: DetailsSettings = {
  widths: { labels: 120, date: 180, type: 170, size: 96, created: 170 },
  visible: { labels: true, date: true, type: true, size: true, created: false },
}
// What a row needs to render its detail cells: the ordered visible columns and
// their widths.
export type DetailsColsView = { order: DetailsColKey[]; widths: Record<DetailsColKey, number> }

export function mergeDetails(d?: Partial<DetailsSettings>): DetailsSettings {
  return {
    widths: { ...DETAILS_DEFAULT.widths, ...(d?.widths ?? {}) },
    visible: { ...DETAILS_DEFAULT.visible, ...(d?.visible ?? {}) },
  }
}

export function detailsColLabel(key: DetailsColKey, t: TFunc): string {
  switch (key) {
    case 'labels':  return t('details.col_labels', { defaultValue: 'Étiquettes' })
    case 'date':    return t('info.field_modified')
    case 'type':    return t('info.field_type')
    case 'size':    return t('common.size')
    case 'created': return t('details.col_created', { defaultValue: 'Date de création' })
  }
}
export function longDate(iso: string, lng: string): string {
  return new Date(iso).toLocaleString(lng, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
export function fileCellText(key: DetailsColKey, file: FileItem, t: TFunc, lng: string): string {
  switch (key) {
    case 'labels':  return '' // rendered as <LabelDots>, not text
    case 'date':    return file.updated_at > '1971' ? longDate(file.updated_at, lng) : ''
    case 'created': return file.created_at > '1971' ? longDate(file.created_at, lng) : ''
    case 'type':    return mimeLabel(file.mime_type, file.name, t)
    case 'size':    return formatSize(file.size_bytes)
  }
}
export function folderCellText(key: DetailsColKey, folder: Folder, t: TFunc, lng: string): string {
  switch (key) {
    case 'labels':  return '' // rendered as <LabelDots>, not text
    case 'date':    return folder.updated_at > '1971' ? longDate(folder.updated_at, lng) : ''
    case 'created': return folder.created_at > '1971' ? longDate(folder.created_at, lng) : ''
    case 'type':    return t('info.type_folder')
    case 'size':    return ''
  }
}

/** Sort direction wording, phrased per field (« De A à Z » only fits a name). */
export function sortDirLabels(field: SortField, t: TFunc): { asc: string; desc: string } {
  if (field === 'name' || field === 'type') {
    return { asc: t('sort.a_to_z'), desc: t('sort.z_to_a') }
  }
  if (field === 'size') {
    return { asc: t('sort.smallest'), desc: t('sort.largest') }
  }
  return { asc: t('sort.oldest'), desc: t('sort.newest') }
}
