import { useQuery } from '@tanstack/react-query'
import { api } from '../../core/api/client'
import { PRIV } from '../../core/authz/types'
import { usePrivileges } from '../../core/authz/usePrivileges'

// Shape of GET /admin/stats - shared by the home landing and the dashboard.
export interface KV { key: string; count: number }
export interface Series { date: string; count: number }
export interface TopStorage { name: string; used: number; quota: number }
export interface Stats {
  users_total: number
  users_active: number
  storage_used: number
  storage_quota_total?: number
  modules_active: number
  sessions_active?: number
  users_online?: number
  sessions_24h?: number
  new_users_7d?: number
  new_users_30d?: number
  users_by_role?: KV[]
  sessions_by_device?: KV[]
  modules_by_status?: KV[]
  signups_daily?: Series[]
  logins_daily?: Series[]
  events_daily?: Series[]
  top_storage?: TopStorage[]
}

/**
 * Instance-wide statistics, polled every 30s (single shared query cache entry).
 *
 * Skipped entirely without `core.stats.read`: the landing page is open to any
 * administrator, including delegated ones who do not hold it, and firing the
 * request anyway would poll a 403 every 30 seconds.
 */
export function useAdminStats() {
  const { can } = usePrivileges()
  const allowed = can(PRIV.STATS_READ)
  return useQuery({
    queryKey: ['admin-stats'],
    queryFn: () => api.get<Stats>('/admin/stats').then((r) => r.data),
    enabled: allowed,
    refetchInterval: allowed ? 30_000 : false,
    retry: 2,
  })
}
