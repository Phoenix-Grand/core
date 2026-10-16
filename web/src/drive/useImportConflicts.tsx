// Shared import pipeline with name-conflict prompting - used by every drive
// import surface (StorageExplorer, DriveApp). Whenever an imported file OR folder
// already exists in its target directory, the user is asked: overwrite / keep
// both / cancel. Works for loose files, drag-dropped trees and folder imports,
// at any depth (folders merge on overwrite; "keep both" auto-renames).
import { useCallback, useRef, useState, type ReactNode } from 'react'
import ConflictDialog, { type ConflictChoice } from '../ui/ConflictDialog'

export interface ImportTargetListing { files: { name: string }[]; folders: { id: string; name: string }[] }

export interface ImportConflictsOptions {
  /** List a folder's direct children (for conflict detection). */
  list: (folderId: string | null) => Promise<ImportTargetListing>
  /** Create a folder and return its id (null if it couldn't be resolved → skip subtree). */
  createFolder: (name: string, parentId: string | null) => Promise<{ id: string | null }>
  /** Fire-and-forget tracked upload (progress handled by the caller). */
  uploadFile: (file: File, folderId: string | null, overwrite: boolean) => void
  /** Whether folders can be created in this source. */
  canMkdir?: boolean
}

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
    if (!batch.length) break
    all.push(...batch)
  }
  return all
}

function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 1000; i++) { const n = `${base} (${i})${ext}`; if (!taken.has(n)) return n }
  return `${base} (${Date.now()})${ext}`
}

export function useImportConflicts({ list, createFolder, uploadFile, canMkdir = true }: ImportConflictsOptions) {
  const [dialog, setDialog] = useState<{ type: 'file' | 'folder'; name: string } | null>(null)
  const resolverRef = useRef<((c: ConflictChoice) => void) | null>(null)
  // Per-run cache of folder listings (names present) so we don't re-list constantly.
  const cacheRef = useRef<Map<string, { files: Set<string>; folders: Map<string, string> }>>(new Map())

  const ask = useCallback((type: 'file' | 'folder', name: string): Promise<ConflictChoice> =>
    new Promise<ConflictChoice>(resolve => { resolverRef.current = resolve; setDialog({ type, name }) }), [])

  const onChoice = useCallback((c: ConflictChoice) => {
    setDialog(null); const r = resolverRef.current; resolverRef.current = null; r?.(c)
  }, [])

  const getListing = useCallback(async (folderId: string | null) => {
    const key = folderId ?? ''
    const hit = cacheRef.current.get(key)
    if (hit) return hit
    const { files, folders } = await list(folderId)
    const v = { files: new Set(files.map(f => f.name)), folders: new Map(folders.map(f => [f.name, f.id] as const)) }
    cacheRef.current.set(key, v)
    return v
  }, [list])

  // Upload one file into target, asking on name conflict.
  const uploadOne = useCallback(async (file: File, targetId: string | null) => {
    const l = await getListing(targetId)
    let overwrite = false
    if (l.files.has(file.name)) {
      const c = await ask('file', file.name)
      if (c === 'cancel') return
      overwrite = c === 'overwrite'
    }
    uploadFile(file, targetId, overwrite)
    l.files.add(file.name)
  }, [getListing, ask, uploadFile])

  // Resolve (or create) the target folder for an imported directory level, asking
  // on conflict. Returns the target folder id, or null to skip its subtree.
  const resolveFolder = useCallback(async (name: string, parentId: string | null): Promise<string | null> => {
    if (!canMkdir) return null
    const l = await getListing(parentId)
    if (l.folders.has(name)) {
      const c = await ask('folder', name)
      if (c === 'cancel') return null
      if (c === 'overwrite') return l.folders.get(name)!     // merge into existing
      const fresh = freeName(name, new Set(l.folders.keys()))  // keep both → rename
      const { id } = await createFolder(fresh, parentId)
      if (id) l.folders.set(fresh, id)
      return id
    }
    const { id } = await createFolder(name, parentId)
    if (id) l.folders.set(name, id)
    return id
  }, [canMkdir, getListing, ask, createFolder])

  // Recursively import a drag-dropped FileSystemEntry tree.
  const processEntry = useCallback(async (entry: FileSystemEntry, parentId: string | null): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
      await uploadOne(file, parentId)
    } else if (entry.isDirectory) {
      const targetId = await resolveFolder(entry.name, parentId)
      if (targetId === null) return
      const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
      for (const c of children) await processEntry(c, targetId)
    }
  }, [uploadOne, resolveFolder])

  // ── Public API ───────────────────────────────────────────────────────────────

  const importFiles = useCallback(async (files: File[], targetId: string | null) => {
    cacheRef.current.clear()
    for (const f of files) await uploadOne(f, targetId)
  }, [uploadOne])

  const importEntries = useCallback(async (entries: FileSystemEntry[], targetId: string | null) => {
    cacheRef.current.clear()
    for (const e of entries) await processEntry(e, targetId)
  }, [processEntry])

  // Folder import via <input webkitdirectory> (flat File[] + webkitRelativePath).
  const importWebkitFolder = useCallback(async (files: File[], targetId: string | null) => {
    cacheRef.current.clear()
    // path-without-filename → resolved folder id (null = skipped subtree)
    const resolved = new Map<string, string | null>([['', targetId]])
    for (const file of files) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      const parts = rel.split('/'); parts.pop()
      let parentId: string | null = targetId
      let acc = ''
      let skip = false
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part
        if (!resolved.has(acc)) resolved.set(acc, await resolveFolder(part, parentId))
        parentId = resolved.get(acc) ?? null
        if (parentId === null) { skip = true; break }
      }
      if (!skip) await uploadOne(file, parentId)
    }
  }, [resolveFolder, uploadOne])

  const conflictDialog: ReactNode = dialog
    ? <ConflictDialog type={dialog.type} name={dialog.name} onChoice={onChoice} />
    : null

  return { importFiles, importEntries, importWebkitFolder, conflictDialog }
}
