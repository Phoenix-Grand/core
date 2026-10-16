/**
 * Wire types of the device and session inventory.
 *
 * This module lives outside `admin/` on purpose: the personal screen
 * (Settings ▸ Devices and sessions) and the administration screen render the
 * SAME shapes from the SAME server queries. A user must be able to see exactly
 * what an operator sees of their own machines, and the cheapest way to keep that
 * promise is to leave them no separate type to drift into.
 */

/**
 * A signal that can be unknown - and whose unknown value must never be read as
 * a negative, nor collapse into a positive.
 *
 * The server sends a WORD, never a nullable boolean, precisely so that a
 * `?? false` in this codebase cannot turn "we never asked" into "not
 * encrypted". Use {@link isSatisfied} to ask the positive question.
 */
export type Tri = 'unknown' | 'yes' | 'no'

/** The only way to ask "is it on?". Answers `false` for `unknown`. */
export const isSatisfied = (tri: Tri): boolean => tri === 'yes'

export type Approval = 'pending' | 'approved' | 'blocked'
export type SignalLevel = 'observed' | 'declared' | 'attested'
export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'tv' | 'bot' | 'api' | 'unknown'

export interface Device {
  id:      string
  user_id: string
  /** Denormalised account label; present on the administration list. */
  user_label:       string | null
  /** `key` (opaque cookie / native device key) or `fingerprint` (derived). */
  correlation_kind: 'key' | 'fingerprint'
  label:            string | null
  device_type:      DeviceType
  client_kind:      string | null
  platform:         string | null
  platform_version: string | null
  browser:          string | null
  browser_version:  string | null
  signal_level:     SignalLevel
  /** Declared by the device, never verified. Tri-state. */
  disk_encrypted:   Tri
  /** Declared by the device, never verified. Tri-state. */
  screen_lock:      Tri
  declared_platform:    string | null
  declared_version:     string | null
  declared_app_version: string | null
  declared_at:      string | null
  first_seen_at:    string
  last_seen_at:     string
  last_ip:          string | null
  last_country:     string | null
  approval:         Approval
  approval_by:      string | null
  approval_label:   string | null
  approval_at:      string | null
  approval_reason:  string | null
  active_sessions:  number
}

export interface DeviceEvent {
  id:          number
  occurred_at: string
  kind:
    | 'first_seen' | 'session_opened' | 'declared' | 'approved' | 'blocked'
    | 'unblocked' | 'signed_out' | 'renamed' | 'disowned'
  ip_address:  string | null
  country:     string | null
  actor_id:    string | null
  actor_label: string | null
  detail:      string | null
}

export interface DeviceSession {
  id:            string
  user_id:       string
  user_label:    string | null
  device_id:     string | null
  device_label:  string | null
  device_name:   string | null
  device_type:   string | null
  client_type:   string | null
  ip_address:    string | null
  country:       string | null
  /** `password` | `password_totp` | `backup_code` | `sso` | `unknown` | null. */
  auth_strength: string | null
  user_agent:    string | null
  created_at:    string
  last_used_at:  string
  expires_at:    string
}

export interface DeviceListResponse {
  devices: Device[]
  total:   number
  /** False when no offline country database is configured - the console then
   *  explains the empty column instead of leaving the reader to guess. */
  country_db_available: boolean
}

export interface DeviceDetailResponse {
  device:   Device
  sessions: DeviceSession[]
  events:   DeviceEvent[]
}

export interface MyDevicesResponse {
  devices:  Device[]
  sessions: DeviceSession[]
  /** The device the browser is holding right now, when it can be identified. */
  current_device_id: string | null
  declared_signals_enabled: boolean
  country_db_available:     boolean
}

export interface DeviceFacets {
  platforms:    string[]
  countries:    string[]
  device_types: string[]
}

export interface DeviceFilters {
  q:            string
  device_type:  string
  platform:     string
  approval:     string
  country:      string
  signal_level: string
  seen_days:    string
}

export const EMPTY_DEVICE_FILTERS: DeviceFilters = {
  q: '', device_type: '', platform: '', approval: '', country: '', signal_level: '', seen_days: '',
}

export interface SessionFilters {
  q:           string
  client_type: string
  country:     string
  without_2fa: string
}

export const EMPTY_SESSION_FILTERS: SessionFilters = {
  q: '', client_type: '', country: '', without_2fa: '',
}

/** Drops empty values so the query string stays readable and cacheable. */
export function toParams(filters: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(filters)) {
    if (value) out[key] = value
  }
  return out
}
