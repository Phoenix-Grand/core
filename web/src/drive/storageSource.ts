/**
 * `StorageSource` - abstraction d'un backend de stockage pour l'explorateur de
 * fichiers générique (`StorageExplorer`). UNE seule zone d'exploration (barre de
 * sélection, tri/type/affichage, dossiers/fichiers, menu contextuel) est partagée
 * par TOUS les types de stockage ; chaque source déclare ses **capacités** et la
 * personnalisation se fait en masquant les fonctions non supportées.
 *
 * Le rendu manipule les types existants `Folder`/`FileItem`. Le modèle local est
 * basé sur des UUID (`id`) ; le modèle distant est basé sur des chemins → on adapte
 * `RemoteEntry → Folder/FileItem` avec `id = chemin`. Seules les **opérations**
 * diffèrent : elles passent par `source.*` (où `id` vaut le chemin en distant).
 */
import { filesApi, systemApi, SYSTEM_ROOT_ID, type Folder, type FileItem, type RemoteEntry } from './api'
import { getFileIcon } from './filesShared'
import { downloadSignedUrl } from '@kubuno/sdk'

// ── Capacités ────────────────────────────────────────────────────────────────

export interface StorageCapabilities {
  upload:     boolean
  mkdir:      boolean
  rename:     boolean
  move:       boolean   // glisser-déposer + couper/coller
  copy:       boolean
  trash:      boolean   // corbeille (sinon suppression définitive)
  delete:     boolean
  star:       boolean
  share:      boolean
  getLink:    boolean
  versions:   boolean
  color:      boolean   // couleur de dossier
  compress:   boolean
  decompress: boolean
  info:       boolean
  search:     boolean
  openWith:   boolean   // éditeurs FileTypeRegistry / ouverture native
  /** Modales riches (NewFolder/Rename/Move/Share/Info/Versions) pour le local ;
   *  flux par `prompt()`/glisser pour le distant. */
  richModals: boolean
  thumbnails: 'url' | 'blob' | 'none'
}

const ALL: StorageCapabilities = {
  upload: true, mkdir: true, rename: true, move: true, copy: true, trash: true,
  delete: true, star: true, share: true, getLink: true, versions: true, color: true,
  compress: true, decompress: true, info: true, search: true, openWith: true,
  richModals: true, thumbnails: 'url',
}

export type EntryKind = 'file' | 'folder'
export interface ItemRef { id: string; type: EntryKind; name: string }

export interface ThumbSpec {
  kind: 'url' | 'blob' | 'none'
  url?: string
  load?: () => Promise<Blob | null>
}

export interface StorageSource {
  /** Namespace de cache React-Query (ex. 'local', `remote:${mountId}`). */
  key:          string
  capabilities: StorageCapabilities
  /** Racine de navigation : `{ id, name }` (id null = racine utilisateur locale). */
  resolveRoot(): Promise<{ id: string | null; name: string } | null>
  /** Liste un dossier (par id local, ou par chemin distant). */
  list(parentId: string | null): Promise<{ folders: Folder[]; files: FileItem[] }>
  /** Ancêtres d'un dossier (du plus haut au dossier lui-même ; [] à la racine).
   *  Sert à reconstruire le fil d'Ariane lors d'une navigation pilotée par l'URL. */
  resolveAncestors(id: string | null): Promise<Array<{ id: string; name: string }>>

  createFolder(name: string, parentId: string | null): Promise<void>
  rename(item: ItemRef, newName: string): Promise<void>
  move(item: ItemRef, targetParentId: string | null): Promise<void>
  copy(item: ItemRef, targetParentId: string | null): Promise<void>
  trash(items: ItemRef[]): Promise<void>
  remove(items: ItemRef[]): Promise<void>   // suppression définitive
  uploadFile(file: File, parentId: string | null, onProgress?: (pct: number) => void, overwrite?: boolean): Promise<{ id: string } | null>

  /** The folder's OWN record (the listing only returns its children). Absent on
   *  sources that cannot fetch one - the trail then falls back to id + name. */
  statFolder?(id: string): Promise<Folder | null>

  star?(item: ItemRef): Promise<void>
  setFolderColor?(id: string, color: string | null): Promise<void>

  /** Déclenche le téléchargement navigateur de l'élément. */
  download(item: ItemRef): void | Promise<void>
  /** Spécifie comment afficher la miniature d'un fichier. */
  thumbnail(file: FileItem): ThumbSpec
  /** Spécifie comment récupérer le CONTENU complet d'un fichier (visionneuses). */
  content(file: FileItem): ThumbSpec
  /** Matérialise un fichier dans le stockage LOCAL (pour « ouvrir avec » un
   *  éditeur qui n'accepte qu'un fichier local). Renvoie le FileItem local. */
  materialize?(file: FileItem): Promise<FileItem | null>
  /** Lit le contenu brut d'un fichier (pour les transferts inter-sources). */
  readBlob(ref: { id: string; name: string }): Promise<Blob>
}

// ── Transfert générique entre deux sources (copie/déplacement, récursif) ─────────

/** Copie/déplace un élément d'une source vers une autre (local↔distant, distant↔
 *  distant, …). Récursif pour les dossiers. Utilisé par la vue double-volet. */
export async function transferItem(
  from: StorageSource, to: StorageSource,
  item: ItemRef, toParentId: string | null, mode: 'copy' | 'move',
): Promise<void> {
  if (item.type === 'file') {
    const blob = await from.readBlob(item)
    const f = new File([blob], item.name, { type: blob.type || 'application/octet-stream' })
    await to.uploadFile(f, toParentId)
  } else {
    await to.createFolder(item.name, toParentId)
    const { folders } = await to.list(toParentId)
    const created = folders.find(x => x.name === item.name)
    if (!created) throw new Error(`Remote mkdir failed: ${item.name}`)
    const { folders: subDirs, files: subFiles } = await from.list(item.id)
    for (const sf of subFiles) await transferItem(from, to, { id: sf.id, type: 'file', name: sf.name }, created.id, 'copy')
    for (const sd of subDirs)  await transferItem(from, to, { id: sd.id, type: 'folder', name: sd.name }, created.id, 'copy')
  }
  if (mode === 'move') {
    if (from.capabilities.trash) await from.trash([item])
    else                        await from.remove([item])
  }
}

// ── Source LOCALE (stockage interne, capacités complètes) ────────────────────

export interface LocalSourceOpts {
  /** Préfixe de dossier racine (ex. "Office/Documents") pour les modules. */
  rootPrefix?: string
  /** Libellé racine (Mon Drive par défaut). */
  rootName?:   string
}

/** Marche vers le dossier racine d'un préfixe "A/B/C" (réutilisé par les modules). */
export async function resolveRootFolder(pathPrefix: string): Promise<Folder | null> {
  const segments = pathPrefix.trim().split('/').filter(Boolean)
  if (segments.length === 0) return null
  let parentId: string | null = null
  let folder: Folder | null = null
  for (const segment of segments) {
    const { folders } = await filesApi.listFolders(parentId)
    const match = folders.find(f => f.name === segment)
    if (!match) return null
    folder = match
    parentId = match.id
  }
  return folder
}

export function localSource(opts: LocalSourceOpts = {}): StorageSource {
  const rootName = opts.rootName ?? "My Drive"
  return {
    key: opts.rootPrefix ? `local:${opts.rootPrefix}` : 'local',
    capabilities: { ...ALL },
    async resolveRoot() {
      if (opts.rootPrefix) {
        const f = await resolveRootFolder(opts.rootPrefix)
        return f ? { id: f.id, name: f.name } : null
      }
      return { id: null, name: rootName }
    },
    async list(parentId) {
      // Fetch a generous page so client-side windowing has the whole directory to
      // reveal progressively (the backend caps at 1000). Larger directories would
      // need real server-side pagination.
      const [{ folders }, { files }] = await Promise.all([
        filesApi.listFolders(parentId),
        filesApi.listFiles(parentId, undefined, undefined, undefined, undefined, { limit: 1000 }),
      ])
      return { folders, files }
    },
    async statFolder(id) {
      const { folder } = await filesApi.getFolder(id)
      return folder
    },
    async resolveAncestors(id) {
      if (!id) return []
      const { folder, ancestors } = await filesApi.getFolder(id)
      return [...ancestors.map(a => ({ id: a.id, name: a.name })), { id: folder.id, name: folder.name }]
    },
    async createFolder(name, parentId) { await filesApi.createFolder(name, parentId) },
    async rename(item, newName) {
      if (item.type === 'file') await filesApi.renameFile(item.id, newName)
      else                      await filesApi.renameFolder(item.id, newName)
    },
    async move(item, target) {
      if (item.type === 'file') await filesApi.moveFile(item.id, target)
      else                      await filesApi.moveFolder(item.id, target)
    },
    async copy(item, target) {
      if (item.type === 'file') await filesApi.copyFile(item.id, target)
    },
    async trash(items) {
      await Promise.all(items.map(i => i.type === 'file' ? filesApi.trashFile(i.id) : filesApi.trashFolder(i.id)))
    },
    async remove(items) {
      await Promise.all(items.map(i => i.type === 'file' ? filesApi.deleteFile(i.id) : filesApi.deleteFolder(i.id)))
    },
    async uploadFile(file, parentId, onProgress, overwrite) {
      const r = await filesApi.uploadFile(file, parentId, onProgress, overwrite)
      return r?.file?.id ? { id: r.file.id } : null
    },
    async star(item) {
      if (item.type === 'file') await filesApi.starFile(item.id)
      else                      await filesApi.starFolder(item.id)
    },
    async setFolderColor(id, color) { await filesApi.setFolderColor(id, color) },
    download(item) {
      // A navigation cannot send the Authorization header: one-time signed ticket.
      if (item.type === 'file') downloadSignedUrl(filesApi.downloadUrl(item.id)).catch(console.error)
      else filesApi.compressDownload([], [item.id], item.name + '.zip')
    },
    thumbnail(file) {
      return file.has_thumbnail
        ? { kind: 'url', url: filesApi.thumbnailUrl(file.id) }
        : { kind: 'none' }
    },
    content(file) { return { kind: 'url', url: filesApi.downloadUrl(file.id) } },
    readBlob(ref) { return filesApi.downloadBlob(ref.id) },
  }
}

// ── Source DISTANTE (montage externe, capacités réduites) ────────────────────

const REMOTE_CAPS: StorageCapabilities = {
  upload: true, mkdir: true, rename: true, move: true, copy: true, trash: false,
  delete: true, star: false, share: false, getLink: false, versions: false,
  color: false, compress: false, decompress: false, info: false, search: false,
  openWith: false, richModals: false, thumbnails: 'blob',
}

const IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico']
const extOf = (n: string) => n.split('.').pop()?.toLowerCase() ?? ''

/** Devine un type MIME minimal depuis l'extension (pour icônes / filtres). */
function guessMime(name: string): string {
  const e = extOf(name)
  if (IMG.includes(e)) return `image/${e === 'svg' ? 'svg+xml' : e}`
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(e)) return `video/${e}`
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(e)) return `audio/${e}`
  if (e === 'pdf') return 'application/pdf'
  if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz'].includes(e)) return `application/${e}`
  if (['txt', 'md', 'csv', 'log'].includes(e)) return 'text/plain'
  return 'application/octet-stream'
}

const NOW = '1970-01-01T00:00:00Z'

function entryToFolder(e: RemoteEntry): Folder {
  return {
    id: e.path, name: e.name, parent_id: null, path: e.path,
    is_starred: false, is_protected: false, is_trashed: false, trashed_at: null,
    versioning_enabled: false, color: null, icon: null, owner_id: '',
    created_at: NOW, updated_at: NOW,
  }
}
function entryToFile(e: RemoteEntry): FileItem {
  return {
    id: e.path, name: e.name, folder_id: null, size_bytes: e.size_bytes ?? 0,
    mime_type: guessMime(e.name), is_starred: false, is_trashed: false,
    has_thumbnail: IMG.includes(extOf(e.name)), versioning_enabled: false,
    metadata: {}, owner_id: '', created_at: NOW, updated_at: NOW,
  }
}

const parentOf = (p: string) => p.split('/').slice(0, -1).join('/')
const baseOf   = (p: string) => p.split('/').slice(-1)[0]
const joinPath = (dir: string | null, name: string) => (dir ? `${dir.replace(/\/+$/, '')}/${name}` : name)

export function remoteSource(mountId: string, mountName: string): StorageSource {
  return {
    key: `remote:${mountId}`,
    capabilities: { ...REMOTE_CAPS },
    async resolveRoot() { return { id: '', name: mountName } },
    async list(parentId) {
      const entries = await filesApi.browseRemote(mountId, parentId ?? '')
      return {
        folders: entries.filter(e => e.is_dir).map(entryToFolder),
        files:   entries.filter(e => !e.is_dir).map(entryToFile),
      }
    },
    async resolveAncestors(id) {
      if (!id) return []
      return id.split('/').filter(Boolean).map((seg, i, arr) => ({ id: arr.slice(0, i + 1).join('/'), name: seg }))
    },
    async createFolder(name, parentId) {
      await filesApi.createRemoteDir(mountId, joinPath(parentId, name))
    },
    async rename(item, newName) {
      await filesApi.renameRemoteEntry(mountId, item.id, joinPath(parentOf(item.id), newName))
    },
    async move(item, target) {
      // Déplacement = rename vers un autre dossier (le backend distant le gère).
      await filesApi.renameRemoteEntry(mountId, item.id, joinPath(target ?? '', baseOf(item.id)))
    },
    async copy(item, target) {
      if (item.type !== 'file') return
      const blob = await filesApi.fetchRemoteFileBlob(mountId, item.id)
      await filesApi.uploadRemoteFile(mountId, joinPath(target ?? '', baseOf(item.id)), blob)
    },
    async trash(items) { await this.remove(items) },
    async remove(items) {
      await Promise.all(items.map(i => filesApi.deleteRemoteEntry(mountId, i.id)))
    },
    async uploadFile(file, parentId) {
      await filesApi.uploadRemoteFile(mountId, joinPath(parentId, file.name), file)
      return { id: joinPath(parentId, file.name) }
    },
    download(item) {
      if (item.type === 'file') void filesApi.downloadRemoteFile(mountId, item.id, item.name)
    },
    thumbnail(file) {
      return IMG.includes(extOf(file.name))
        ? { kind: 'blob', load: () => filesApi.fetchRemoteFileBlob(mountId, file.id) }
        : { kind: 'none' }
    },
    content(file) { return { kind: 'blob', load: () => filesApi.fetchRemoteFileBlob(mountId, file.id) } },
    readBlob(ref) { return filesApi.fetchRemoteFileBlob(mountId, ref.id) },
    async materialize(file) {
      const blob = await filesApi.fetchRemoteFileBlob(mountId, file.id)
      const f = new File([blob], file.name, { type: blob.type || file.mime_type || 'application/octet-stream' })
      const r = await filesApi.uploadFile(f, null)
      return r?.file ?? null
    },
  }
}

/** Icône par défaut d'un fichier (réexport pratique pour les sources). */
export { getFileIcon }

// ── Source SYSTÈME (répertoire partagé, géré par les admins) ────────────────────
// Lecture pour tous ; écriture (create/upload/delete) réservée aux admins côté
// backend. Capacités réduites (pas de corbeille/étoile/partage/renommage/déplacement).
const SYSTEM_CAPS: StorageCapabilities = {
  upload: true, mkdir: true, rename: false, move: false, copy: false, trash: false,
  delete: true, star: false, share: false, getLink: false, versions: false,
  color: false, compress: false, decompress: false, info: false, search: false,
  openWith: false, richModals: true, thumbnails: 'none',
}
export function systemSource(): StorageSource {
  return {
    key: 'system',
    capabilities: { ...SYSTEM_CAPS },
    async resolveRoot() { return { id: SYSTEM_ROOT_ID, name: 'System' } },
    async list(parentId) {
      const pid = parentId ?? SYSTEM_ROOT_ID
      const [{ folders }, { files }] = await Promise.all([systemApi.listFolders(pid), systemApi.listFiles(pid)])
      return { folders, files }
    },
    async resolveAncestors(id) {
      if (!id || id === SYSTEM_ROOT_ID) return [{ id: SYSTEM_ROOT_ID, name: 'System' }]
      const { folder, ancestors } = await systemApi.getFolder(id)
      return [...ancestors.map(a => ({ id: a.id, name: a.name })), { id: folder.id, name: folder.name }]
    },
    async createFolder(name, parentId) { await systemApi.createFolder(name, parentId ?? SYSTEM_ROOT_ID) },
    async rename() { /* non supporté */ },
    async move() { /* non supporté */ },
    async copy() { /* non supporté */ },
    async trash(items) { await Promise.all(items.map(i => i.type === 'file' ? systemApi.deleteFile(i.id) : systemApi.deleteFolder(i.id))) },
    async remove(items) { await Promise.all(items.map(i => i.type === 'file' ? systemApi.deleteFile(i.id) : systemApi.deleteFolder(i.id))) },
    async uploadFile(file, parentId, onProgress, overwrite) {
      const r = await systemApi.uploadFile(file, parentId ?? SYSTEM_ROOT_ID, onProgress, overwrite)
      return r?.file?.id ? { id: r.file.id } : null
    },
    download(item) { if (item.type === 'file') downloadSignedUrl(systemApi.downloadUrl(item.id)).catch(console.error) },
    thumbnail() { return { kind: 'none' } },
    content(file) { return { kind: 'url', url: systemApi.downloadUrl(file.id) } },
    readBlob(ref) { return systemApi.downloadBlob(ref.id) },
  }
}
