export interface User {
  id: string
  email: string
  username: string
  display_name: string | null
  avatar_url: string | null
  role: 'user' | 'admin' | 'guest'
  quota_bytes: number
  used_bytes: number
  is_active: boolean
  email_verified: boolean
  oauth_provider: string | null
  org_unit_id: string | null
  preferences: Record<string, unknown>
  created_at: string
  updated_at: string
  last_login_at: string | null
  totp_enabled: boolean
  /** The account still carries the password it was seeded with: a change is forced. */
  must_change_password?: boolean
  /**
   * When the current local password was chosen (migration `000115`). A date and
   * nothing more - it says *when*, never anything about the password. `null` on
   * an account that holds no local password at all.
   *
   * It is what makes the expiry policy legible on an account sheet: without it,
   * "passwords expire after 90 days" is a rule nobody can check against a
   * particular person.
   */
  password_changed_at?: string | null

  /**
   * Profile fields of migration `000114`. All six are real columns, all six are
   * nullable, and none is ever required of anybody.
   *
   * `gender` and `birthday` are personal data: they travel on `GET /api/v1/me`
   * (oneself) and on the administration sheet, and on nothing else. The
   * directory search and every people picker answer name, username and photo -
   * so a component must never expect to find them on a user object obtained
   * from `/users/search` or `/users/lookup`.
   */
  first_name?: string | null
  last_name?: string | null
  name_pronunciation?: string | null
  pronouns?: string | null
  work_location?: string | null
  introduction?: string | null
  gender?: string | null
  /** `YYYY-MM-DD`, or null. */
  birthday?: string | null
}

export interface OrgUnit {
  id: string
  name: string
  parent_id: string | null
  description: string | null
}

export interface Session {
  id: string
  user_id: string
  device_name: string | null
  device_type: string | null
  ip_address: string | null
  user_agent: string | null
  expires_at: string
  created_at: string
  last_used_at: string
}

export interface ActiveModule {
  module_id: string
  base_url: string
  sidebar_items: SidebarItem[]
  /** URL du bundle UI à charger à l'exécution (null si le module n'a pas d'UI). */
  frontend_entry?: string | null
  registered_at: string
  last_heartbeat: string
}

export interface SidebarItem {
  id: string
  label: string
  icon: string
  path: string
  position: number
  badge?: number
  section?: 'main' | 'secondary'
  protected_folder?: string
}

export interface ApiToken {
  id: string
  user_id: string
  name: string
  /** Privilege keys the bearer may exercise. Empty only for a legacy token. */
  scopes: string[]
  /** Issued before scopes existed: runs on a grace window, no admin writes. */
  is_legacy: boolean
  /** End of that grace window. Computed server-side from the current setting. */
  legacy_grace_until: string | null
  expires_at: string | null
  created_at: string
  last_used_at: string | null
}

/** One scope the current account may put on a token (`GET /me/api-tokens/scopes`). */
export interface TokenScope {
  key: string
  namespace: string
  /** Functional group the selector arranges the tree by. */
  domain: string
  verb: string
  label: string
  description: string | null
  /** Picking this one makes an expiry date mandatory. */
  requires_expiry: boolean
}

export interface AppError {
  message: string
  code: string
}

export interface UserGroup {
  id: string
  name: string
  description: string | null
  permissions: string[]
  is_default: boolean
  /** Les réunions des membres ne rendent jamais leur salle automatiquement. */
  release_exempt: boolean
  is_system?: boolean
  member_count?: number
  created_at: string
  updated_at: string
}

export interface PublicConfig {
  'instance.name'?: string
  'instance.description'?: string
  'instance.logo_url'?: string | null
  'instance.color_primary'?: string
  'auth.registration_open'?: boolean
  'auth.oauth_google_enabled'?: boolean
  'auth.oauth_github_enabled'?: boolean
  'auth.api_token_allowed_roles'?: string[]
}
