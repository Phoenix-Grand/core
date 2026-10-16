import { create } from 'zustand'
import type { FileItem } from './api'

/** Référence vers un emplacement distant (montage) - pour écrire hors du drive local. */
export interface RemoteRef {
  mountId: string
  path:    string  // dossier distant (sans le nom de fichier)
}

export interface FolderSelection {
  id:   string | null  // null = racine
  name: string
  remote?: RemoteRef
}

// Options passées à openFile()
export interface OpenDialogOptions {
  title?:            string
  acceptExtensions?: string[]   // ex: ['ttf', 'otf', 'woff', 'woff2']
  acceptMimes?:      string[]   // ex: ['font/*', 'image/*']
  multiple?:         boolean    // réservé pour l'avenir
}

// Options passées au sélecteur de dossier
export interface FolderPickerOptions {
  title?: string
}

// Options passées à saveFile()
export interface SaveDialogOptions {
  title?:            string
  defaultName?:      string
  defaultFolderId?:  string | null  // dossier de départ dans le browser
}

export interface SaveDialogResult {
  folderId: string | null
  name:     string
}

interface FilesDialogState {
  // OpenDialog
  openOpts:    OpenDialogOptions | null
  openResolve: ((file: FileItem | null) => void) | null

  // FolderPicker
  folderPickerOpts:    FolderPickerOptions | null
  folderPickerResolve: ((folder: FolderSelection | null) => void) | null

  // SaveDialog
  saveOpts:    SaveDialogOptions | null
  saveResolve: ((result: SaveDialogResult | null) => void) | null

  // API publique - appelée par les modules consommateurs
  openFile:       (opts?: OpenDialogOptions)    => Promise<FileItem | null>
  pickFolder:     (opts?: FolderPickerOptions)  => Promise<FolderSelection | null>
  saveFile:       (opts?: SaveDialogOptions)    => Promise<SaveDialogResult | null>

  // API interne - appelée par les dialogs uniquement
  _resolveOpen:         (file: FileItem | null) => void
  _resolveFolderPicker: (folder: FolderSelection | null) => void
  _resolveSave:         (result: SaveDialogResult | null) => void
}

export const useFilesDialogStore = create<FilesDialogState>((set, get) => ({
  openOpts:            null,
  openResolve:         null,
  folderPickerOpts:    null,
  folderPickerResolve: null,
  saveOpts:            null,
  saveResolve:         null,

  openFile: (opts = {}) =>
    new Promise(resolve => set({ openOpts: opts, openResolve: resolve })),

  pickFolder: (opts = {}) =>
    new Promise(resolve => set({ folderPickerOpts: opts, folderPickerResolve: resolve })),

  saveFile: (opts = {}) =>
    new Promise(resolve => set({ saveOpts: opts, saveResolve: resolve })),

  _resolveOpen: (file) => {
    const resolve = get().openResolve
    set({ openOpts: null, openResolve: null })
    resolve?.(file)
  },

  _resolveFolderPicker: (folder) => {
    const resolve = get().folderPickerResolve
    set({ folderPickerOpts: null, folderPickerResolve: null })
    resolve?.(folder)
  },

  _resolveSave: (result) => {
    const resolve = get().saveResolve
    set({ saveOpts: null, saveResolve: null })
    resolve?.(result)
  },
}))

// ── Helpers exportés pour les consommateurs ───────────────────────────────────

export function fileMatchesOptions(name: string, mimeType: string, opts: OpenDialogOptions): boolean {
  if (!opts.acceptExtensions?.length && !opts.acceptMimes?.length) return true
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (opts.acceptExtensions?.includes(ext)) return true
  if (opts.acceptMimes?.some(m => {
    if (m.endsWith('/*')) return mimeType.startsWith(m.slice(0, -2))
    return mimeType === m
  })) return true
  return false
}
