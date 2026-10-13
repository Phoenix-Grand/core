import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../core/api/client'
import { apiErrorDetail } from '../../../core/api/errorMessage'
import type {
  ActiveScope, ResolvedSetting, ResolvedSettingsResponse,
} from '../../settings/scopeTypes'

/**
 * The four verbs of a scoped setting, for one scope: read, write, revert, lock.
 *
 * Deliberately the *same* endpoints and the *same* query key as
 * `settings/SettingsGroupPanel`. Two consequences, both wanted:
 *
 *   • the payload this page needs is usually already in the cache, and a write
 *     here refreshes the generic settings page and vice versa — the two can
 *     never show contradictory values for the same key;
 *   • provenance, locking and reverting behave identically to every other
 *     settings screen, because they *are* the same calls. A bespoke write path
 *     would be the place where "revert" quietly turned into "store the
 *     inherited value", which is the one thing the model forbids.
 */
export function useDirectoryPolicy(scope: ActiveScope) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const scopeParams = { scope_type: scope.type, scope_id: scope.id ?? undefined }

  const query = useQuery({
    queryKey: ['admin-settings-resolved', scope.type, scope.id] as const,
    queryFn: () =>
      api
        .get<ResolvedSettingsResponse>('/admin/settings/resolved', { params: scopeParams })
        .then(r => r.data.settings),
  })

  const afterWrite = async () => {
    setError(null)
    await queryClient.invalidateQueries({ queryKey: ['admin-settings-resolved'] })
    await queryClient.invalidateQueries({ queryKey: ['setting-chain'] })
  }

  /* The server's sentence, not a generic one. A write refused because a unit
   * above holds a lock says which unit — replacing that with "échec de
   * l'enregistrement" would send the operator looking for a bug. */
  const reportError = (e: unknown) => {
    const detail = apiErrorDetail(e)
    setError(detail ?? t('admin.setting_write_failed'))
  }

  const write = useMutation({
    mutationFn: (p: { key: string; value: unknown }) =>
      api.put(`/admin/settings/scoped/${encodeURIComponent(p.key)}`, {
        scope_type: scope.type,
        scope_id:   scope.id,
        value:      p.value,
      }),
    onSuccess: afterWrite,
    onError:   reportError,
  })

  // A DELETE, never a write of the inherited value: removing the row is what
  // makes this scope follow its parent again, including the day the parent
  // changes (migration 000060).
  const revert = useMutation({
    mutationFn: (key: string) =>
      api.delete(`/admin/settings/scoped/${encodeURIComponent(key)}`, { params: scopeParams }),
    onSuccess: afterWrite,
    onError:   reportError,
  })

  const lock = useMutation({
    mutationFn: (p: { key: string; locked: boolean }) =>
      api.post(`/admin/settings/lock/${encodeURIComponent(p.key)}`, {
        scope_type: scope.type,
        scope_id:   scope.id,
        locked:     p.locked,
      }),
    onSuccess: afterWrite,
    onError:   reportError,
  })

  const byKey = new Map((query.data ?? []).map(s => [s.key, s]))

  return {
    /** `undefined` while loading, and for a key this instance has not declared. */
    setting: (key: string): ResolvedSetting | undefined => byKey.get(key),
    isLoading: query.isLoading,
    isError:   query.isError,
    refetch:   query.refetch,
    error,
    clearError: () => setError(null),
    write:  (key: string, value: unknown) => write.mutate({ key, value }),
    revert: (key: string) => revert.mutate(key),
    lock:   (key: string, locked: boolean) => lock.mutate({ key, locked }),
  }
}

export type DirectoryPolicy = ReturnType<typeof useDirectoryPolicy>
