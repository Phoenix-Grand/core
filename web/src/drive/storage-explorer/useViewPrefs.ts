/**
 * Per-folder view memory: each directory remembers the view mode AND the
 * details-table settings (column widths + visibility) that were active the last
 * time it was displayed, in a localStorage map keyed by source + folder id.
 * Mobile is excluded - it has its own grid/list toggle and must not clobber the
 * desktop preference.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { VIEW_SPECS, type ViewMode } from '../fileView'
import { DETAILS_DEFAULT, mergeDetails, type DetailsSettings } from './detailsModel'

const VIEW_MODES_KEY = 'kubuno:drive:view-modes'
const DETAILS_KEY = 'kubuno:drive:details'

export function useViewPrefs(dirKey: string, isMobile: boolean) {
  const [viewMode, setViewMode] = useState<ViewMode>('lg')
  const viewModesRef = useRef<Record<string, ViewMode> | null>(null)
  const loadViewModes = () => {
    if (!viewModesRef.current) {
      try { viewModesRef.current = JSON.parse(localStorage.getItem(VIEW_MODES_KEY) ?? '{}') as Record<string, ViewMode> }
      catch { viewModesRef.current = {} }
    }
    return viewModesRef.current
  }
  const detailsStoreRef = useRef<Record<string, DetailsSettings> | null>(null)
  const loadDetailsStore = () => {
    if (!detailsStoreRef.current) {
      try { detailsStoreRef.current = JSON.parse(localStorage.getItem(DETAILS_KEY) ?? '{}') as Record<string, DetailsSettings> }
      catch { detailsStoreRef.current = {} }
    }
    return detailsStoreRef.current
  }
  const [details, setDetails] = useState<DetailsSettings>(DETAILS_DEFAULT)

  // Restore the folder's remembered view mode AND details settings when
  // entering it (read-only - writes happen in the change/persist helpers below,
  // so restore and persist never race). Unseen folders fall back to defaults.
  useEffect(() => {
    if (isMobile) return
    const vm = loadViewModes()[dirKey]
    setViewMode(vm && VIEW_SPECS[vm] ? vm : 'lg')
    setDetails(mergeDetails(loadDetailsStore()[dirKey]))
  }, [dirKey, isMobile]) // eslint-disable-line react-hooks/exhaustive-deps
  // Changing the view records it against the current folder immediately.
  const changeViewMode = useCallback((m: ViewMode) => {
    setViewMode(m)
    if (isMobile) return
    const map = loadViewModes()
    map[dirKey] = m
    try { localStorage.setItem(VIEW_MODES_KEY, JSON.stringify(map)) } catch { /* private mode / quota */ }
  }, [isMobile, dirKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // Persist details settings against the current folder.
  const persistDetails = useCallback((updater: (s: DetailsSettings) => DetailsSettings) => {
    setDetails(prev => {
      const next = updater(prev)
      if (next === prev) return prev
      if (!isMobile) {
        const store = loadDetailsStore()
        store[dirKey] = next
        try { localStorage.setItem(DETAILS_KEY, JSON.stringify(store)) } catch { /* private mode / quota */ }
      }
      return next
    })
  }, [isMobile, dirKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return { viewMode, changeViewMode, details, persistDetails }
}
