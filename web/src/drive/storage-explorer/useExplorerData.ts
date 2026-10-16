/**
 * Data of the current directory, read through the `StorageSource`: root
 * resolution, listing, acceptance filtering (mime types / FileTypeRegistry) and
 * the id → kind map used by the selection and drag code.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileTypeRegistry } from '@kubuno/sdk'
import type { StorageSource } from '../storageSource'

export function useExplorerData({ src, caps, currentFolderId, acceptedMimeTypes, fileTypeModuleId }: {
  src: StorageSource
  caps: StorageSource['capabilities']
  currentFolderId: string | null
  acceptedMimeTypes?: string[]
  fileTypeModuleId?: string
}) {
  const { data: root, isLoading: rootLoading } = useQuery({
    queryKey: ['explorer', src.key, '#root'],
    queryFn: () => src.resolveRoot(),
    staleTime: 30_000,
  })
  const effectiveFolderId = currentFolderId ?? root?.id ?? null
  const rootResolved = root !== undefined && root !== null

  // Stable per-folder key. The virtual root has no id (effectiveFolderId is
  // null there) → « root » so the top level is remembered like any folder.
  const dirKey = `${src.key}:${effectiveFolderId ?? 'root'}`

  const { data, isLoading: listLoading, error: listError } = useQuery({
    queryKey: ['explorer', src.key, effectiveFolderId],
    queryFn: () => src.list(effectiveFolderId),
    enabled: rootResolved,
    staleTime: 0,
    refetchInterval: caps.thumbnails === 'url' ? 3_000 : false,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
  })

  // A failed listing used to be swallowed: `data` stayed undefined, so the view
  // fell through to "empty folder" and an unreachable remote was indistinguish-
  // able from one that holds nothing. Surface it instead, carrying the server's
  // code so the caller can act on it (e.g. MOUNT_CONFIG_UNREADABLE).
  const error = useMemo(() => {
    if (!listError) return null
    // The API client's interceptor already flattens every non-401 failure to a
    // bare `{ code, message }` (core/api/client.ts) - reading `response.data`
    // here yields undefined and silently loses the code. The Axios shape is kept
    // as a fallback for any caller that bypasses that interceptor.
    const e = listError as {
      code?: string; message?: string
      response?: { data?: { error?: string; message?: string } }
    }
    return {
      code:    e.code ?? e.response?.data?.error ?? 'UNKNOWN',
      message: e.message ?? e.response?.data?.message ?? '',
    }
  }, [listError])
  const isLoading = rootLoading || listLoading
  const folders = data?.folders ?? []
  const rawFiles = data?.files ?? []

  const files = useMemo(() => {
    if (fileTypeModuleId && FileTypeRegistry.get(fileTypeModuleId)) {
      return rawFiles.filter(FileTypeRegistry.matcher(fileTypeModuleId))
    }
    if (!acceptedMimeTypes || acceptedMimeTypes.length === 0) return rawFiles
    return rawFiles.filter(f => acceptedMimeTypes.some(m => f.mime_type === m || f.mime_type.startsWith(m)))
  }, [rawFiles, acceptedMimeTypes, fileTypeModuleId])

  const itemTypeMap = useMemo(() => {
    const map = new Map<string, 'file' | 'folder'>()
    folders.forEach(f => map.set(f.id, 'folder'))
    files.forEach(f => map.set(f.id, 'file'))
    return map
  }, [folders, files])

  return { rootLoading, rootResolved, effectiveFolderId, dirKey, isLoading, error, folders, files, itemTypeMap }
}
