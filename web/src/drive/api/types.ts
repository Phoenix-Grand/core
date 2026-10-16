// Shared data shapes of the drive API (files, folders, shares, versions,
// activity, remote mounts…). Kept in one place so every domain slice and every
// consumer of `@kubuno/drive` sees the exact same types.

export interface FolderAncestor {
  id:   string
  name: string
}

export interface Folder {
  id: string
  name: string
  parent_id: string | null
  path: string
  is_starred: boolean
  is_protected: boolean
  is_trashed: boolean
  trashed_at: string | null
  versioning_enabled: boolean
  color: string | null
  icon: string | null
  owner_id: string
  created_at: string
  updated_at: string
}

export interface FileItem {
  id: string
  name: string
  folder_id: string | null
  size_bytes: number
  mime_type: string
  is_starred: boolean
  /**
   * Undeletable file (platform fonts shipped with the module, and anything an
   * IPC caller protected). Optional: alternative sources (remotes, WebDAV)
   * fabricate items without it.
   */
  is_protected?: boolean
  is_trashed: boolean
  has_thumbnail: boolean
  versioning_enabled: boolean
  metadata: Record<string, unknown>
  owner_id: string
  created_at: string
  updated_at: string
  /**
   * Revisions kept for this file, EXCLUDING the current content, and what they
   * weigh. Only the listing and the file detail compute them - every other
   * endpoint leaves them out, hence optional. They are quota-billed, which is
   * why the explorer surfaces them (cf. `storage-explorer/VersionBadge`).
   */
  version_count?: number
  version_bytes?: number
}

/** Search result: a file enriched with a snippet and a relevance score. */
export interface SearchHit extends FileItem {
  snippet:     string | null
  score:       number
  match_kind:  'text' | 'name' | 'semantic'
  folder_path: string | null
}

export interface FileVersion {
  id: string
  file_id: string
  owner_id: string
  version_number: number
  storage_path: string
  size_bytes: number
  content_hash: string | null
  comment: string | null
  created_at: string
}

export interface Share {
  id: string
  owner_id: string
  file_id: string | null
  folder_id: string | null
  token: string | null
  recipient_id: string | null
  can_download: boolean
  can_upload: boolean
  can_delete: boolean
  expires_at: string | null
  download_count: number
  max_downloads: number | null
  created_at: string
  updated_at: string
  revoked_at: string | null
}

export interface CreateShareOptions {
  file_id?: string
  folder_id?: string
  recipient_id?: string
  can_download?: boolean
  can_upload?: boolean
  can_delete?: boolean
  expires_at?: string | null
  max_downloads?: number | null
}

export interface Recipient {
  id:           string
  display_name: string | null
  email:        string
  avatar_url:   string | null
}

export interface FolderSize {
  id:         string
  name:       string
  path:       string
  total_size: number
  file_count: number
}

export interface ActivityEntry {
  id:           number
  user_id:      string
  user_display: string
  action:       string
  details:      Record<string, unknown>
  created_at:   string
}

/** Activity row of the account-wide feed: the entry plus the item it concerns. */
export interface ActivityFeedEntry extends ActivityEntry {
  file_id:   string | null
  folder_id: string | null
  item_name: string | null
  mime_type: string | null
}

export interface OwnerInfo {
  id:           string
  display_name: string | null
  email:        string
  avatar_url:   string | null
}

export interface AccessEntry {
  share_id:     string
  recipient_id: string
  display_name: string | null
  email:        string
  avatar_url:   string | null
  can_download: boolean
  can_upload:   boolean
  can_delete:   boolean
  expires_at:   string | null
  created_at:   string
}

export interface InfoExtra {
  owner:  OwnerInfo | null
  access: AccessEntry[]
}

export interface RemoteConnection {
  id:                  string
  name:                string
  provider:            string
  mount_name:          string
  status:              'connected' | 'disconnected' | 'error' | 'syncing'
  last_connected_at:   string | null
  last_error:          string | null
  remote_quota_bytes:  number | null
  remote_used_bytes:   number | null
  created_at:          string
}

export interface CreateRemoteDto {
  name:     string
  provider: string
  config:   Record<string, unknown>
}

/** A live entry (folder or file) listed inside a remote mount. */
export interface RemoteEntry {
  name:       string
  path:       string
  is_dir:     boolean
  size_bytes: number
}

export interface TestRemoteResult {
  ok:     boolean
  error?: string
  quota?: { total_bytes: number | null; used_bytes: number | null; free_bytes: number | null }
}

export interface ArchiveEntry {
  name:             string
  path:             string
  is_dir:           boolean
  size:             number
  compressed_size:  number
}
