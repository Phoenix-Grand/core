/**
 * Cross-module labels API (`/api/v1/labels`): user-owned labels attachable to
 * elements of any module. A link stores a denormalized snapshot of the element
 * (title/href + full `KubunoDataEnvelope`), so browsing, filtering and search
 * work across modules without querying their backends.
 */
import { api } from './client'
import type { KubunoDataEnvelope } from '../registry/DataTransferRegistry'

export interface CoreLabel {
  id: string
  name: string
  color: string
  description: string | null
  /** Links counted under the caller's visibility: everyone's when `can_manage`, else their own. */
  link_count: number
  /** The caller created this label. */
  is_owner: boolean
  /** Full co-ownership: rename, recolor, re-share, delete - and see everyone's elements. */
  can_manage: boolean
  owner_id: string
  owner_name: string
  share_count: number
}

/** One recipient of a label: a named user OR a whole group. */
export interface LabelShare {
  id: string
  kind: 'user' | 'group'
  user_id: string | null
  group_id: string | null
  name: string
  can_manage: boolean
}

export interface LabelShareTargets {
  users: { id: string; name: string; avatar_url: string | null }[]
  groups: { id: string; name: string; member_count: number }[]
}

export interface LabelBrowseItem {
  module: string
  resource_type: string
  resource_id: string
  title: string | null
  href: string | null
  envelope: KubunoDataEnvelope | null
  label_ids: string[]
  /** Names of the OTHER members who labelled this element (managers only). */
  other_owners: string[]
}

export interface LabelLink {
  id: string
  label_id: string
  module: string
  resource_type: string
  resource_id: string
  title: string | null
  href: string | null
  envelope: KubunoDataEnvelope | null
  created_at: string
}

export const labelsApi = {
  list: () =>
    api.get<{ labels: CoreLabel[] }>('/labels').then(r => r.data.labels),

  create: (name: string, color?: string) =>
    api.post<{ label: CoreLabel }>('/labels', { name, color }).then(r => r.data.label),

  update: (id: string, patch: { name?: string; color?: string; description?: string }) =>
    api.patch<{ label: CoreLabel }>(`/labels/${id}`, patch).then(r => r.data.label),

  remove: (id: string) => api.delete(`/labels/${id}`),

  /** Label ids currently attached to one element. */
  forResource: (resourceType: string, resourceId: string) =>
    api.get<{ label_ids: string[] }>('/labels/resource', {
      params: { resource_type: resourceType, resource_id: resourceId },
    }).then(r => r.data.label_ids),

  /** Replaces the label set of one element (atomic picker save). */
  setForResource: (body: {
    module: string
    resource_type: string
    resource_id: string
    title?: string
    href?: string
    envelope?: KubunoDataEnvelope
    label_ids: string[]
  }) => api.put('/labels/resource', body),

  /** Cross-module browse: AND-filter on labels + text search + module filter. */
  browse: (opts: { labels?: string[]; q?: string; module?: string } = {}) =>
    api.get<{ items: LabelBrowseItem[] }>('/labels/browse', {
      params: {
        labels: opts.labels?.length ? opts.labels.join(',') : undefined,
        q: opts.q || undefined,
        module: opts.module || undefined,
      },
    }).then(r => r.data.items),

  links: (labelId: string) =>
    api.get<{ links: LabelLink[] }>(`/labels/${labelId}/links`).then(r => r.data.links),

  removeLink: (labelId: string, linkId: string) =>
    api.delete(`/labels/${labelId}/links/${linkId}`),

  /** Current audience of a label (managers only). */
  shares: (labelId: string) =>
    api.get<{ shares: LabelShare[] }>(`/labels/${labelId}/shares`).then(r => r.data.shares),

  /** Replaces the whole audience in one call (managers only). */
  setShares: (labelId: string, shares: { user_id?: string; group_id?: string; can_manage: boolean }[]) =>
    api.put(`/labels/${labelId}/shares`, { shares }),

  /** Users and groups the share picker can offer. */
  shareTargets: (q?: string) =>
    api.get<LabelShareTargets>('/labels/share-targets', { params: { q: q || undefined } })
      .then(r => r.data),
}
