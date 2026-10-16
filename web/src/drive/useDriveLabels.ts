/**
 * Cross-module labels attached to drive files and folders, for the explorer's
 * pastilles. ONE pair of calls covers the whole listing (the labels, then their
 * drive assignments) and is cached by react-query - never one request per row.
 *
 * Only the local drive source carries labels: remote mounts and module mounts
 * have no `drive.file`/`drive.folder` resource identity, hence the `enabled`
 * gate at the call site.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { labelsApi, type CoreLabel } from '../core/api/labels'

/** Labels carried by one entry, newest-first; empty (stable ref) when none. */
export type LabelsOf = (kind: 'file' | 'folder', id: string) => CoreLabel[]

const NONE: CoreLabel[] = []

export function useDriveLabels(enabled: boolean): LabelsOf {
  const { data } = useQuery({
    queryKey: ['drive-labels'],
    queryFn: async () => {
      const [labels, items] = await Promise.all([
        labelsApi.list(),
        labelsApi.browse({ module: 'drive' }),
      ])
      const byId = new Map(labels.map(l => [l.id, l]))
      const map = new Map<string, CoreLabel[]>()
      for (const it of items) {
        const own = it.label_ids
          .map(id => byId.get(id))
          .filter((l): l is CoreLabel => !!l)
        if (own.length) map.set(`${it.resource_type}:${it.resource_id}`, own)
      }
      return map
    },
    enabled,
    staleTime: 30_000,
  })

  return useMemo<LabelsOf>(
    () => (kind, id) => data?.get(`drive.${kind}:${id}`) ?? NONE,
    [data],
  )
}
