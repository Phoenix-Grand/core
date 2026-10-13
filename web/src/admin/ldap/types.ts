/**
 * Wire shapes of `/admin/ldap/*`.
 *
 * `has_bind_password` rather than the password: the API never returns it, so
 * there is nothing to prefill and the form's password field starts empty on
 * every load. Sending it back is what would leak it.
 */

export interface LdapDirectory {
  id:                 string
  slug:               string
  display_name:       string
  enabled:            boolean

  host:               string
  port:               number
  security:           'none' | 'starttls' | 'ldaps'
  verify_certificate: boolean
  ca_certificate:     string
  connect_timeout_s:  number

  bind_dn:            string
  has_bind_password:  boolean

  base_dn:            string
  user_filter:        string
  user_scope:         'base' | 'onelevel' | 'subtree'

  attr_username:      string
  attr_email:         string
  attr_display_name:  string
  attr_unique_id:     string
  attr_member_of:     string

  sync_groups:        boolean
  group_base_dn:      string
  group_filter:       string
  attr_group_name:    string
  attr_group_member:  string

  sync_enabled:       boolean
  sync_interval_min:  number
  on_missing:         'disable' | 'ignore'
  allow_signup:       boolean

  last_sync_at:       string | null
  last_sync_status:   'ok' | 'partial' | 'failed' | null
  last_sync_detail:   string | null

  default_org_unit_id: string | null

  position:           number
  usable:             boolean
  governed_accounts:  number
}

export interface SampleMapping {
  username:      string | null
  email:         string | null
  display_name:  string | null
  has_unique_id: boolean
  groups:        number
}

export interface ConnectionProbe {
  ok:              boolean
  message:         string
  detail?:         string | null
  hint?:           string | null
  host:            string
  port:            number
  security:        string
  unverified_tls:  boolean
  entries:         number | null
  sample_dn:       string | null
  sample_mapping:  SampleMapping | null
  elapsed_ms:      number
}

export interface AuthProbe {
  ok:              boolean
  message:         string
  detail?:         string | null
  hint?:           string | null
  login:           string
  dn:              string | null
  sample_mapping:  SampleMapping | null
  would_provision: string | null
  elapsed_ms:      number
}

export interface SyncReport {
  directory:           string
  users_seen:          number
  users_created:       number
  users_linked:        number
  users_matched:       number
  users_skipped:       number
  groups_seen:         number
  groups_created:      number
  memberships_added:   number
  memberships_removed: number
  disabled:            number
  disable_refused:     string | null
  warnings:            string[]
  status:              'ok' | 'partial' | 'failed'
  elapsed_ms:          number
}

/** The form. `bind_password` is write-only and starts empty on every load. */
export interface DirectoryForm {
  slug:               string
  display_name:       string
  enabled:            boolean
  host:               string
  port:               string
  security:           string
  verify_certificate: boolean
  ca_certificate:     string
  connect_timeout_s:  string
  bind_dn:            string
  bind_password:      string
  base_dn:            string
  user_filter:        string
  user_scope:         string
  attr_username:      string
  attr_email:         string
  attr_display_name:  string
  attr_unique_id:     string
  attr_member_of:     string
  sync_groups:        boolean
  group_base_dn:      string
  group_filter:       string
  attr_group_name:    string
  attr_group_member:  string
  sync_enabled:       boolean
  sync_interval_min:  string
  on_missing:         string
  allow_signup:       boolean
  default_org_unit_id: string | null
}

/**
 * The two attribute presets, mirroring `directory::model::AttributeMap`.
 *
 * They differ on every line that matters, which is exactly why a preset is
 * worth having: an operator pointing Kubuno at Active Directory with the
 * standard names gets a connection that works and a search that finds nobody.
 */
export const PRESETS: Record<'standard' | 'ad', Partial<DirectoryForm>> = {
  standard: {
    port:              '389',
    security:          'starttls',
    user_filter:       '(&(objectClass=inetOrgPerson)(uid={login}))',
    attr_username:     'uid',
    attr_email:        'mail',
    attr_display_name: 'cn',
    attr_unique_id:    'entryUUID',
    attr_member_of:    '',
    group_filter:      '(objectClass=groupOfNames)',
    attr_group_name:   'cn',
    attr_group_member: 'member',
  },
  ad: {
    port:              '389',
    security:          'starttls',
    // The trailing clause excludes disabled accounts: `userAccountControl`
    // bit 2 is ACCOUNTDISABLE, and the OID is Active Directory's bitwise-AND
    // matching rule. Without it, an import happily re-creates everybody the
    // organisation deactivated.
    user_filter:
      '(&(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(sAMAccountName={login}))',
    attr_username:     'sAMAccountName',
    attr_email:        'mail',
    attr_display_name: 'displayName',
    attr_unique_id:    'objectGUID',
    attr_member_of:    'memberOf',
    group_filter:      '(objectClass=group)',
    attr_group_name:   'cn',
    attr_group_member: 'member',
  },
}

export const emptyForm = (): DirectoryForm => ({
  slug:               '',
  display_name:       '',
  enabled:            true,
  host:               '',
  port:               '389',
  security:           'starttls',
  verify_certificate: true,
  ca_certificate:     '',
  connect_timeout_s:  '10',
  bind_dn:            '',
  bind_password:      '',
  base_dn:            '',
  user_filter:        '(&(objectClass=inetOrgPerson)(uid={login}))',
  user_scope:         'subtree',
  attr_username:      'uid',
  attr_email:         'mail',
  attr_display_name:  'cn',
  attr_unique_id:     'entryUUID',
  attr_member_of:     '',
  sync_groups:        false,
  group_base_dn:      '',
  group_filter:       '(objectClass=groupOfNames)',
  attr_group_name:    'cn',
  attr_group_member:  'member',
  sync_enabled:       false,
  sync_interval_min:  '60',
  on_missing:         'disable',
  allow_signup:       true,
  default_org_unit_id: null,
})

export const toForm = (d: LdapDirectory): DirectoryForm => ({
  slug:               d.slug,
  display_name:       d.display_name,
  enabled:            d.enabled,
  host:               d.host,
  port:               String(d.port),
  security:           d.security,
  verify_certificate: d.verify_certificate,
  ca_certificate:     d.ca_certificate,
  connect_timeout_s:  String(d.connect_timeout_s),
  bind_dn:            d.bind_dn,
  bind_password:      '',
  base_dn:            d.base_dn,
  user_filter:        d.user_filter,
  user_scope:         d.user_scope,
  attr_username:      d.attr_username,
  attr_email:         d.attr_email,
  attr_display_name:  d.attr_display_name,
  attr_unique_id:     d.attr_unique_id,
  attr_member_of:     d.attr_member_of,
  sync_groups:        d.sync_groups,
  group_base_dn:      d.group_base_dn,
  group_filter:       d.group_filter,
  attr_group_name:    d.attr_group_name,
  attr_group_member:  d.attr_group_member,
  sync_enabled:       d.sync_enabled,
  sync_interval_min:  String(d.sync_interval_min),
  on_missing:         d.on_missing,
  allow_signup:       d.allow_signup,
  default_org_unit_id: d.default_org_unit_id,
})

/** Ports that go with each transport mode, applied when switching mode while
 *  the current port is still the default of the previous one. */
export const DEFAULT_PORT: Record<string, string> = { none: '389', starttls: '389', ldaps: '636' }
export const IS_DEFAULT_PORT = (port: string) => port === '389' || port === '636'
