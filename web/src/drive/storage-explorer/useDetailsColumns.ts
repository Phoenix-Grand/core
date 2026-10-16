/**
 * Details-table columns: which ones are visible (in order, with their widths),
 * the auto-fit action and the header right-click menu that toggles them.
 */
import { useCallback, useMemo } from 'react'
import type { MenuItem } from '@ui'
import type { Folder, FileItem } from '../api'
import {
  DETAILS_COL_ORDER, detailsColLabel, fileCellText, folderCellText,
  type DetailsColsView, type DetailsSettings,
} from './detailsModel'
import type { TFunc } from './types'

export function useDetailsColumns({ details, persistDetails, sortedFolders, filteredFiles, t, lng }: {
  details: DetailsSettings
  persistDetails: (updater: (s: DetailsSettings) => DetailsSettings) => void
  sortedFolders: Folder[]
  filteredFiles: FileItem[]
  t: TFunc
  lng: string
}) {
  // Ordered visible columns + widths → what the detail rows render.
  const detailsView: DetailsColsView = useMemo(
    () => ({ order: DETAILS_COL_ORDER.filter(k => details.visible[k]), widths: details.widths }),
    [details],
  )
  // « Ajuster la taille de toutes les colonnes » - fit each visible column to
  // the widest cell it holds (header label + every folder/file value), measured
  // with a canvas at the row font.
  const autoFitCols = useCallback(() => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.font = '12px Outfit, Inter, system-ui, sans-serif'
    const w = (s: string) => ctx.measureText(s).width
    persistDetails(s => {
      const widths = { ...s.widths }
      for (const key of DETAILS_COL_ORDER) {
        if (!s.visible[key]) continue
        if (key === 'labels') continue // no text cells; keep its width
        let max = w(detailsColLabel(key, t)) + 26 // label + sort-arrow room
        for (const f of sortedFolders) max = Math.max(max, w(folderCellText(key, f, t, lng)) + 20)
        for (const f of filteredFiles) max = Math.max(max, w(fileCellText(key, f, t, lng)) + 20)
        widths[key] = Math.max(64, Math.min(480, Math.ceil(max)))
      }
      return { ...s, widths }
    })
  }, [t, lng, sortedFolders, filteredFiles, persistDetails])
  // Header right-click menu: toggle optional columns + auto-fit.
  const headerMenuItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [
      { type: 'action', label: t('details.fit_all', { defaultValue: 'Ajuster la taille de toutes les colonnes' }), onClick: autoFitCols },
      { type: 'separator' },
      { type: 'action', label: t('common.name'), checked: true, disabled: true, onClick: () => {} },
    ]
    for (const key of DETAILS_COL_ORDER) {
      items.push({
        type: 'action', label: detailsColLabel(key, t), checked: details.visible[key],
        onClick: () => persistDetails(s => ({ ...s, visible: { ...s.visible, [key]: !s.visible[key] } })),
      })
    }
    return items
  }, [t, details.visible, autoFitCols, persistDetails])

  return { detailsView, headerMenuItems }
}
