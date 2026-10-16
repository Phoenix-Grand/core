/**
 * Folder navigation: current folder, breadcrumb trail and the optional two-way
 * sync with an URL parameter (so the sidebar can drive the main pane and a
 * deep link restores the position).
 */
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Folder } from '../api'
import type { StorageSource } from '../storageSource'

export function useExplorerNavigation({ src, pathParam, onNavigated }: {
  src: StorageSource
  /** URL parameter mirroring the position (ex. "path" remote, "folder" local). */
  pathParam?: string
  /** Called on every position change (used to drop the current selection). */
  onNavigated: () => void
}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string; name: string }>>([])

  // Écrit la position dans l'URL (paramètre `pathParam`) si demandé - permet à la
  // sidebar de piloter le volet principal et le deep-link (cas distant : id = chemin).
  const writeUrl = useCallback((id: string | null) => {
    if (!pathParam) return
    setSearchParams(prev => {
      const n = new URLSearchParams(prev)
      if (id) n.set(pathParam, id); else n.delete(pathParam)
      return n
    }, { replace: false })
  }, [pathParam, setSearchParams])

  function navigateTo(folder: Folder) {
    setCurrentFolderId(folder.id)
    setBreadcrumbs(prev => [...prev, { id: folder.id, name: folder.name }])
    onNavigated()
    writeUrl(folder.id)
  }
  function navigateUp(idx: number) {
    if (idx < 0) { setCurrentFolderId(null); setBreadcrumbs([]); writeUrl(null) }
    else { setCurrentFolderId(breadcrumbs[idx].id); setBreadcrumbs(breadcrumbs.slice(0, idx + 1)); writeUrl(breadcrumbs[idx].id) }
    onNavigated()
  }

  // Sync URL → état (navigation déclenchée par la sidebar ou un deep-link).
  // Le fil d'Ariane est reconstruit via `resolveAncestors` → marche pour des ids
  // chemin (distant) comme UUID (local, noms d'ancêtres résolus via l'API).
  const urlPath = pathParam ? (searchParams.get(pathParam) ?? '') : ''
  useEffect(() => {
    if (!pathParam) return
    const cur = currentFolderId ?? ''
    if (urlPath === cur) return
    setCurrentFolderId(urlPath || null)
    onNavigated()
    if (!urlPath) { setBreadcrumbs([]); return }
    let alive = true
    src.resolveAncestors(urlPath).then(a => { if (alive) setBreadcrumbs(a) }).catch(() => {})
    return () => { alive = false }
  }, [urlPath, pathParam]) // eslint-disable-line react-hooks/exhaustive-deps

  return { currentFolderId, breadcrumbs, navigateTo, navigateUp }
}
