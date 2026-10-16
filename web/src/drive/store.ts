import { create } from 'zustand'
import { filesApi, type SearchHit } from './api'
import { bumpAllImageCache } from '@kubuno/sdk'
export interface FilesSearchFilters {
  type: 'all' | 'folder' | 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'image' | 'video' | 'audio' | 'archive'
  owner: 'anyone' | 'me' | 'notme'
  containsWords: string
  itemName: string
  location: 'everywhere' | 'mydrive'
  inTrash: boolean
  isStarred: boolean
  modifiedDate: 'anytime' | 'today' | '7days' | '30days' | 'thisyear' | 'lastyear'
  sharedWith: string
}

const DEFAULT_FILTERS: FilesSearchFilters = {
  type: 'all',
  owner: 'anyone',
  containsWords: '',
  itemName: '',
  location: 'everywhere',
  inTrash: false,
  isStarred: false,
  modifiedDate: 'anytime',
  sharedWith: '',
}

export interface UploadEntry {
  id: string
  name: string
  progress: number
  status: 'uploading' | 'done' | 'error'
  error?: string
}

interface FilesState {
  // Recherche
  searchQuery: string
  searchFilters: FilesSearchFilters
  searchApplied: boolean
  setSearchQuery: (q: string) => void
  setSearchFilters: (partial: Partial<FilesSearchFilters>) => void
  applySearch: () => void
  clearSearch: () => void

  // Recherche d'images similaires (clic sur l'appareil photo de la barre de recherche)
  imageSearch: { name: string; loading: boolean; results: SearchHit[]; total: number } | null
  runImageSearch: (file: File) => Promise<void>
  clearImageSearch: () => void


  currentFolderId: string | null
  setCurrentFolderId: (id: string | null) => void

  newFolderOpen: boolean
  openNewFolder: () => void
  closeNewFolder: () => void

  importUrlOpen: boolean
  openImportUrl: () => void
  closeImportUrl: () => void

  remotesPanelOpen: boolean
  openRemotesPanel: () => void
  closeRemotesPanel: () => void

  // Direct callbacks registered by FilesApp - called synchronously within user gesture
  _fileInputClick:   (() => void) | null
  _folderInputClick: (() => void) | null
  registerFileInput:   (fn: () => void) => void
  registerFolderInput: (fn: () => void) => void
  triggerUpload:       () => void
  triggerFolderUpload: () => void

  // Legacy trigger numbers (used as fallback in FilesApp useEffect)
  uploadTrigger: number
  folderUploadTrigger: number

  refreshKey: number
  refresh: () => void

  uploads: UploadEntry[]
  addUpload: (entry: UploadEntry) => void
  updateUpload: (id: string, patch: Partial<UploadEntry>) => void
  clearDoneUploads: () => void

  // Presse-papier (couper/copier)
  clipboard: { action: 'cut' | 'copy'; type: 'file' | 'folder'; id: string; name: string } | null
  setClipboard: (item: FilesState['clipboard']) => void
  clearClipboard: () => void
}

export const useFilesStore = create<FilesState>((set, get) => ({
  searchQuery: '',
  searchFilters: { ...DEFAULT_FILTERS },
  searchApplied: false,
  setSearchQuery: q => set({ searchQuery: q, searchApplied: q.trim().length > 0, imageSearch: q.trim() ? null : get().imageSearch }),
  setSearchFilters: partial => set(s => ({ searchFilters: { ...s.searchFilters, ...partial } })),
  applySearch: () => set({ searchApplied: true }),
  clearSearch: () => set({ searchQuery: '', searchFilters: { ...DEFAULT_FILTERS }, searchApplied: false, imageSearch: null }),

  imageSearch: null,
  runImageSearch: async (file) => {
    set({ imageSearch: { name: file.name, loading: true, results: [], total: 0 }, searchQuery: '', searchApplied: false })
    try {
      const { results, total } = await filesApi.searchSimilar(file)
      set({ imageSearch: { name: file.name, loading: false, results, total } })
    } catch {
      set({ imageSearch: { name: file.name, loading: false, results: [], total: 0 } })
    }
  },
  clearImageSearch: () => set({ imageSearch: null }),

  currentFolderId: null,
  setCurrentFolderId: id => set({ currentFolderId: id }),

  newFolderOpen: false,
  openNewFolder: () => set({ newFolderOpen: true }),
  closeNewFolder: () => set({ newFolderOpen: false }),

  importUrlOpen: false,
  openImportUrl: () => set({ importUrlOpen: true }),
  closeImportUrl: () => set({ importUrlOpen: false }),

  remotesPanelOpen: false,
  openRemotesPanel: () => set({ remotesPanelOpen: true }),
  closeRemotesPanel: () => set({ remotesPanelOpen: false }),

  _fileInputClick:   null,
  _folderInputClick: null,
  registerFileInput:   fn => set({ _fileInputClick: fn }),
  registerFolderInput: fn => set({ _folderInputClick: fn }),

  // Call the registered callback synchronously (within user gesture context)
  triggerUpload: () => {
    const fn = get()._fileInputClick
    if (fn) fn()
    else set(s => ({ uploadTrigger: s.uploadTrigger + 1 }))
  },
  triggerFolderUpload: () => {
    const fn = get()._folderInputClick
    if (fn) fn()
    else set(s => ({ folderUploadTrigger: s.folderUploadTrigger + 1 }))
  },

  uploadTrigger: 0,
  folderUploadTrigger: 0,

  refreshKey: 0,
  // « Actualiser » : refetch des listes ET re-téléchargement des miniatures
  // (cache-bust global), pour refléter d'éventuelles vignettes régénérées côté serveur.
  refresh: () => { bumpAllImageCache(); set(s => ({ refreshKey: s.refreshKey + 1 })) },

  uploads: [],
  addUpload: entry => set(s => ({ uploads: [...s.uploads, entry] })),
  updateUpload: (id, patch) =>
    set(s => ({ uploads: s.uploads.map(u => u.id === id ? { ...u, ...patch } : u) })),
  clearDoneUploads: () =>
    set(s => ({ uploads: s.uploads.filter(u => u.status === 'uploading') })),

  clipboard: null,
  setClipboard: item => set({ clipboard: item }),
  clearClipboard: () => set({ clipboard: null }),
}))
