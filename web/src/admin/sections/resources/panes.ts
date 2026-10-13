/**
 * The five screens of the section, and the query-string value each one carries.
 *
 * A module of its own so that a child screen can link to a sibling without
 * importing the parent that renders it — `OverviewTab` sends the operator to the
 * buildings list, and a cycle there would be a bundling accident waiting to
 * happen.
 */
export type ResourcePane = 'overview' | 'buildings' | 'resources' | 'features' | 'room-stats'

export const RESOURCE_PANES: ResourcePane[] =
  ['overview', 'buildings', 'resources', 'features', 'room-stats']

/** Reads the pane out of `/admin/resources?pane=…`, defaulting to the landing. */
export function paneFromParams(params: URLSearchParams): ResourcePane {
  const raw = params.get('pane')
  return RESOURCE_PANES.includes(raw as ResourcePane) ? (raw as ResourcePane) : 'overview'
}
