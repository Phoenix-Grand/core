import type { ComboboxOption } from '@ui'
import { LANGUAGES } from '../../core/i18n'

/**
 * ── The cartography of instance settings ─────────────────────────────────────
 *
 * One declarative table says, for every key of `core.settings`, WHICH admin page
 * owns it and WHICH titled group it sits in. Routing, page composition, heading
 * order and the search deep link all derive from this file, so a key can never
 * be listed in two places or claimed by none.
 *
 * ── The principle ────────────────────────────────────────────────────────────
 *
 * A setting lives on the page that shows its CONSEQUENCES, not on a page named
 * after its technical namespace. The retention of the audit log belongs above
 * the audit log; the detector scan budget belongs with the detectors; the alert
 * thresholds belong in the alert centre. An operator who is looking at the thing
 * is the operator who wants to tune it - and one who has just changed a
 * threshold can see, on the same screen, what it did.
 *
 * The instance profile keeps only what identifies the instance. Everything that
 * was piled onto it because it had nowhere else to go now has somewhere else.
 *
 * ── Three invariants ─────────────────────────────────────────────────────────
 *
 * NOTHING IS EVER LOST. A key claimed by no page falls back to the instance
 * profile, grouped by its declared category (`FALLBACK_TAB`). A module that
 * declares a setting tomorrow, or a core key added without touching this file,
 * shows up there rather than disappearing from the console.
 *
 * NOTHING IS EVER SHOWN TWICE. `DEDICATED_EDITOR` lists the keys that already
 * have a purpose-built control somewhere (the theme gallery, the login-animation
 * tuner, the "set as default" action of the module list). They are routed to
 * that page - so the search still lands in the right place - but never painted
 * as a raw control: a JSON blob in a text field is not an editor.
 *
 * ONE GROUP, ONE SENTENCE. Every group carries an i18n title AND a description
 * of what it governs. A settings page that only repeats the label of each
 * control tells the operator nothing they did not already know.
 */

/** i18n suffix of a setting key: `security.jwt_access_ttl_s` → `security_jwt_access_ttl_s`. */
export const flatKey = (key: string): string => key.replace(/\./g, '_')

export interface SettingGroup {
  /** i18n: `admin.sgrp_<id>` (title) and `admin.sgrp_<id>_desc` (what it governs). */
  id:   string
  /** Keys, in paint order. A key absent from the instance is simply skipped. */
  keys: string[]
}

export interface SettingsPageSpec {
  /** Nav leaf id (a tab of ADMIN_NAV) this block is painted on. */
  tab:    string
  groups: SettingGroup[]
}

/** Where an unclaimed key is painted - the page of last resort. */
export const FALLBACK_TAB = 'settings'

export const SETTINGS_PAGES: SettingsPageSpec[] = [
  // ── Instance ▸ Identity ───────────────────────────────────────────────────
  // What identifies the instance, and nothing else. This is the page the whole
  // reorganisation emptied.
  {
    tab: 'settings',
    groups: [
      // Language and time zone sit here rather than under "Customization":
      // they are not a matter of taste, they are what the instance IS - the
      // language it greets a stranger in and the clock it dates its messages by.
      { id: 'identity', keys: [
        'instance.name',
        'instance.description',
        'instance.locale',
        'instance.timezone',
      ] },
    ],
  },

  // ── Instance ▸ Customization ──────────────────────────────────────────────
  // Next to the theme gallery and the login-animation tuner, which own the two
  // keys this block deliberately does not paint.
  {
    tab: 'apparence',
    groups: [
      { id: 'brand',       keys: ['instance.logo_url', 'instance.color_primary'] },
      { id: 'theme_trust', keys: ['appearance.trusted_themes'] },
    ],
  },

  // ── Security ▸ Authentication & SSO ───────────────────────────────────────
  // Under the identity-provider list: how an account comes into existence and
  // what it must prove to sign in.
  {
    tab: 'sso',
    groups: [
      { id: 'signup',        keys: ['auth.registration_open', 'auth.email_verification'] },
      { id: 'builtin_oauth', keys: ['auth.oauth_google_enabled', 'auth.oauth_github_enabled'] },
      { id: 'two_factor',    keys: [
        'security.admin_2fa_required',
        'security.admin_2fa_grace_days',
        'security.backup_codes_low_threshold',
      ] },
      // What a local password must satisfy, and how long it stays valid
      // (migration 000115). Here rather than on a page of its own because it is
      // the second half of the same question the two blocks above ask - what an
      // account must present to sign in - and because every key is scoped, so
      // the scope bar of this page already governs it.
      { id: 'password_policy', keys: [
        'security.password_min_length',
        'security.password_strong',
        'security.password_reuse_allowed',
        'security.password_history_depth',
        'security.password_expiry_days',
        'security.password_enforce_at_login',
      ] },
      // Whether somebody who has forgotten their password can get themselves
      // back in, or must go through a person. One key, its own group: it is not
      // a detail of the policy above, it is the escape hatch from it.
      { id: 'account_recovery', keys: ['auth.self_service_recovery'] },
      // Brute-force gate: a CAPTCHA after N failures on an account. Its own
      // group - it is not a password rule, it is what stands between a guesser
      // and the password field.
      { id: 'login_captcha', keys: [
        'security.login_captcha_after_failures',
        'security.captcha_type',
        'security.captcha_length',
        'security.captcha_distortion',
        'security.captcha_noise',
        'security.captcha_slider_tolerance',
        'security.captcha_math_max',
      ] },
    ],
  },

  // ── Security ▸ Directory (LDAP / Active Directory) ────────────────────────
  // Under the list of directories: the master switch and the provisioning
  // default are the two decisions that apply to ALL of them, and they belong
  // where an operator can see which directories they affect.
  {
    tab: 'ldap',
    groups: [
      { id: 'directory_policy', keys: [
        'auth.directory_login_enabled',
        'auth.directory_provision_on_login',
      ] },
    ],
  },

  // ── Instance ▸ Domains ────────────────────────────────────────────────────
  // The one policy the registry governs, under the registry: a switch that says
  // "only a verified domain may register" is unreadable without the list of
  // which domains those are.
  {
    tab: 'domains',
    groups: [
      { id: 'domains', keys: ['auth.registration_domains_only'] },
    ],
  },

  // ── Instance ▸ Public holidays ────────────────────────────────────────────
  // Under the referential rather than in a settings page of their own: "which
  // territory applies to whom" is the question somebody arrives with right after
  // seeing the list of territories, and `intl.holiday_calendars` is scoped, so
  // the scope bar belongs on the page that shows what it governs.
  //
  // The leaf sits next to Identity, where the language and the time zone live:
  // the three answer the same question - where this organisation is - and the
  // time zone is what the holidays fall back on when nobody said.
  {
    tab: 'holidays',
    groups: [
      { id: 'holidays', keys: ['intl.holiday_calendars', 'intl.holidays_enabled'] },
    ],
  },

  // ── Security ▸ Sessions and re-authentication ─────────────────────────────
  // Its own page rather than a group buried in a broader one: "how long does a
  // session last" is a question operators arrive with, not one they explore for.
  {
    tab: 'session-policy',
    groups: [
      { id: 'session_life', keys: [
        'security.jwt_access_ttl_s',
        'security.jwt_refresh_ttl_d',
        'security.max_sessions',
        'security.session_idle_timeout_min',
      ] },
      { id: 'reauth', keys: ['security.reauth_grace_s', 'security.reauth_token_ttl_s'] },
    ],
  },

  // ── Security ▸ Access and data ────────────────────────────────────────────
  // Programmatic access: what a credential that is not a browser may do.
  {
    tab: 'access-data',
    groups: [
      { id: 'api_tokens', keys: [
        'auth.api_token_allowed_roles',
        'security.api_token_max_ttl_days',
        'security.api_token_legacy_grace_days',
      ] },
      { id: 'mcp', keys: ['mcp.enabled'] },
    ],
  },

  // ── Security ▸ Service protection ─────────────────────────────────────────
  {
    tab: 'service-protection',
    groups: [
      { id: 'ddos', keys: [
        'security.ddos_enabled',
        'security.ddos_rate_per_min',
        'security.ddos_max_concurrent',
      ] },
      { id: 'user_rate', keys: ['security.rate_user_per_min'] },
    ],
  },

  // ── System ▸ Network (HTTP / HTTPS) ───────────────────────────────────────
  // The certificate itself is not a setting; the dedicated NetworkPanel owns it
  // and renders these groups beneath it.
  {
    tab: 'network',
    groups: [
      { id: 'http_https', keys: [
        'network.https_enabled',
        'network.https_port',
        'network.tls_min_version',
        'network.cert_mode',
      ] },
      { id: 'acme', keys: [
        'network.acme_directory_url',
        'network.acme_email',
        'network.acme_domains',
        'network.acme_tos_agreed',
      ] },
      { id: 'http_redirect', keys: [
        'network.http_redirect_to_https',
        'network.http_redirect_port',
      ] },
      { id: 'hsts', keys: [
        'network.hsts_enabled',
        'network.hsts_max_age_days',
        'network.hsts_include_subdomains',
        'network.hsts_preload',
      ] },
    ],
  },

  // ── Security ▸ Alert centre ───────────────────────────────────────────────
  // Under the queue itself: a threshold is only readable next to what it fired.
  {
    tab: 'alerts',
    groups: [
      { id: 'alerts_engine',     keys: ['alerts.enabled', 'alerts.scan_interval_s'] },
      { id: 'alerts_thresholds', keys: [
        'alerts.login_burst_threshold',
        'alerts.login_burst_window_min',
        'alerts.disk_warn_percent',
        'alerts.disk_critical_percent',
      ] },
      { id: 'alerts_retention',  keys: ['alerts.retention_days'] },
    ],
  },

  // ── Automation ▸ Rules / Run log / Detectors ──────────────────────────────
  {
    tab: 'rules',
    groups: [
      { id: 'rules_engine', keys: ['rules.enabled', 'rules.max_depth'] },
      { id: 'rules_limits', keys: [
        'rules.max_condition_depth',
        'rules.max_condition_leaves',
        'rules.backtest_max_events',
      ] },
    ],
  },
  {
    tab: 'rules-log',
    groups: [
      { id: 'rules_retention', keys: ['rules.execution_retention_days'] },
    ],
  },
  {
    tab: 'detectors',
    groups: [
      { id: 'gate',        keys: ['rules.gate.enabled', 'rules.gate.fail_mode', 'rules.gate.timeout_ms'] },
      { id: 'scan_budget', keys: [
        'rules.detectors.max_parts',
        'rules.detectors.max_part_bytes',
        'rules.detectors.max_scan_ms',
      ] },
    ],
  },

  // ── Devices ▸ Active sessions / Networks ──────────────────────────────────
  {
    tab: 'device-sessions',
    groups: [
      { id: 'device_policy', keys: ['devices.block_denies_refresh', 'devices.declared_signals_enabled'] },
    ],
  },
  {
    tab: 'networks',
    groups: [
      { id: 'geo', keys: ['devices.country_db_path'] },
    ],
  },

  // ── Reporting ▸ Audit ─────────────────────────────────────────────────────
  {
    tab: 'audit',
    groups: [
      { id: 'audit_retention', keys: ['security.audit_retention_days'] },
      // The dashboard's attendance counters are the most personal thing the
      // console keeps - who used which application, by day. Their window is
      // settable HERE, beside the other journal retentions, rather than on the
      // dashboard: an operator shortening what is kept about people should meet
      // every such decision on one screen.
      { id: 'usage_retention', keys: ['usage.retention_days'] },
    ],
  },

  // ── System ▸ Background tasks ─────────────────────────────────────────────
  // The backup policy sits FIRST, under the panel that shows what it produced:
  // an operator who has just read "last backup: 6 days ago" is the one who wants
  // to change the frequency, and the two must be on the same screen for that
  // sentence to mean anything.
  {
    tab: 'background-jobs',
    groups: [
      { id: 'backup_policy',    keys: ['backup.enabled', 'backup.frequency', 'backup.hour_utc'] },
      { id: 'backup_storage',   keys: ['backup.destination', 'backup.retention_count'] },
      { id: 'jobs_runtime',  keys: ['jobs.concurrency', 'jobs.poll_interval_s'] },
      { id: 'jobs_recovery', keys: ['jobs.job_timeout_s', 'jobs.stalled_after_s'] },
    ],
  },
  // Export de données. Les quatre groupes suivent l'ordre dans lequel un
  // opérateur se pose les questions : qui a le droit de déclencher, combien de
  // temps l'archive est retenue puis conservée, où et comment elle est écrite,
  // et enfin ce que chacun peut faire de SES propres données. Les prérequis
  // viennent en PREMIER délibérément - ce sont eux qui décident si le bouton
  // existe, et les enterrer sous un chemin de fichier ferait d'un contrôle de
  // sécurité une option d'apparence.
  //
  // Le libre-service vient en DERNIER et forme son propre groupe : c'est le seul
  // réglage de cette page qui se règle par unité organisationnelle (déclaré
  // `overridable`), et le mélanger aux six autres - tous d'instance - laisserait
  // croire que la portée s'applique à eux aussi.
  {
    tab: 'data-export',
    groups: [
      { id: 'export_prereq',    keys: ['data_export.require_2fa', 'data_export.min_admin_age_days'] },
      { id: 'export_window',    keys: ['data_export.hold_hours', 'data_export.retention_days'] },
      { id: 'export_archive',   keys: ['data_export.destination', 'data_export.max_file_mb',
                                       'data_export.module_timeout_s'] },
      { id: 'export_self',      keys: ['data_export.self_service', 'data_export.self_hold_hours',
                                       'data_export.self_max_downloads'] },
    ],
  },
]

/**
 * Keys a purpose-built control already owns.
 *
 * They are routed (the search must land on the page that edits them) but never
 * rendered as a generic control: `appearance.login_animation` is a tuning object
 * whose editor is a live preview, and painting it as a JSON text field - which
 * is what the old single page did - is an invitation to corrupt it.
 */
export const DEDICATED_EDITOR: Record<string, string> = {
  // Which authentication methods a scope accepts is a LIST, and the generic
  // control would paint it as a JSON text field - an invitation to lock the
  // instance out by typo. `AuthMethodsPanel` owns it: three switches, a
  // confirmation that states the cost before the click, and the console recovery
  // path printed next to the switch that can close the door.
  'auth.methods':               'sso',
  'auth.local_admin_fallback':  'sso',
  'appearance.theme':           'apparence',
  'appearance.login_animation': 'apparence',
  // The directory page owns these eleven: it groups them into the three
  // questions they answer (is there a directory, what does it disclose, what may
  // a person change about themselves), and states next to each field that the
  // switch decides who may FILL it, never who may see it. Unclaimed, they landed
  // in the "uncategorised" list, where that distinction is invisible and a
  // personal-data switch reads like any other boolean.
  'directory.enabled':                     'directory-settings',
  'directory.share_email':                 'directory-settings',
  'directory.audience':                    'directory-settings',
  'directory.profile_edit_name':           'directory-settings',
  'directory.profile_edit_photo':          'directory-settings',
  'directory.profile_edit_name_pronunciation': 'directory-settings',
  'directory.profile_edit_pronouns':       'directory-settings',
  'directory.profile_edit_work_location':  'directory-settings',
  'directory.profile_edit_introduction':   'directory-settings',
  'directory.profile_edit_gender':         'directory-settings',
  'directory.profile_edit_birthday':       'directory-settings',
  // "Set as default" lives on the module list, next to the modules it names.
  'navigation.default_module':  'modules',
  // The storage page owns the capacity policy: its quota card already carries
  // the per-unit chain, the revert and the lock, in bytes an operator can read.
  'storage.default_quota_bytes': 'storage',
  'alerts.quota_percent':        'storage',
  // A declaration, not a preference: it is written by the "I have tested a
  // restore" button, which records WHO said so. A date field would let anyone
  // back-date the one value whose entire worth is that somebody vouched for it -
  // and the server refuses the write anyway.
  'backup.last_restore_test_at': 'background-jobs',
}

/**
 * Settings whose change has a consequence worth stating BEFORE it is made.
 * Rendered as an inline caution inside the card, above the control - a warning
 * that only appears after the click has already happened is an apology.
 * i18n: `admin.setwarn_<flatKey>`.
 */
export const CAUTION_KEYS = new Set([
  // Switching the schedule off is silent until the day somebody needs a file.
  'backup.enabled',
  // The hold is the whole defence against an export triggered from a stolen
  // administrator session: the archive exists but cannot be fetched, while
  // every other administrator has already been alerted. Setting it to zero
  // removes that window entirely, and does so silently.
  'data_export.hold_hours',
  // Same class of change, one step removed: without a second factor, an export
  // of every account is one password away.
  'data_export.require_2fa',
  'auth.registration_open',
  // Turning it off signs nobody out, but the next sign-in of every account the
  // directory governs fails. Worth saying before the click, not after.
  'auth.directory_login_enabled',
  'security.admin_2fa_required',
  // Existing accounts count their password's age from their creation date, so
  // switching expiry on renews the oldest passwords of the instance at once -
  // which is what it is for, and exactly the sort of thing to say beforehand.
  'security.password_expiry_days',
  'security.ddos_enabled',
  'mcp.enabled',
  'rules.gate.fail_mode',
])

/**
 * Descriptions the database never carried. `core.settings.description` is NULL
 * for the oldest keys - exactly the ones the reorganisation promotes onto small,
 * curated pages - and a page that shows "Nom de l'instance" over an empty field
 * has explained nothing. Supplied here so they are translated like any other
 * string; the database value still wins when it exists.
 * i18n: `admin.setdesc_<flatKey>`.
 */
export const I18N_DESCRIPTIONS = new Set([
  'instance.name',
  'instance.description',
  'instance.locale',
  'instance.timezone',
  'instance.logo_url',
  'instance.color_primary',
  'auth.registration_open',
  'auth.email_verification',
  'auth.oauth_google_enabled',
  'auth.oauth_github_enabled',
  'security.jwt_access_ttl_s',
  'security.jwt_refresh_ttl_d',
  'security.max_sessions',
])

/**
 * Closed value sets. `Dropdown` is not used anywhere here on purpose: it does
 * not follow the dark theme. `Combobox` does, and it filters - which the IANA
 * timezone list of the calendar module makes mandatory rather than pleasant.
 */
export const ENUM_OPTIONS: Record<string, ComboboxOption[]> = {
  'security.captcha_type': [
    { value: 'text',   label: 'admin.opt_captcha_text' },
    { value: 'slider', label: 'admin.opt_captcha_slider' },
    { value: 'math',   label: 'admin.opt_captcha_math' },
  ],
  'backup.frequency': [
    { value: 'daily',  label: 'admin.opt_backup_daily' },
    { value: 'weekly', label: 'admin.opt_backup_weekly' },
  ],
  /* Built from the language picker's own list rather than retyped: the two must
     name the same thirteen locales, and a hand-written copy is a list that goes
     stale the day a fourteenth is added. Autonyms, so a reader recognises their
     language whatever the console is currently displaying - which is precisely
     the situation an operator fixing a wrong instance language is in. */
  'instance.locale': LANGUAGES.map(l => ({ value: l.code, label: `${l.flag}  ${l.label}` })),
  'rules.gate.fail_mode': [
    { value: 'open',   label: 'admin.opt_fail_open' },
    { value: 'closed', label: 'admin.opt_fail_closed' },
  ],
  'calendar.week_starts_on': [
    { value: 'monday',   label: 'admin.opt_monday' },
    { value: 'sunday',   label: 'admin.opt_sunday' },
    { value: 'saturday', label: 'admin.opt_saturday' },
  ],
  'calendar.time_format': [
    { value: '24h', label: 'admin.opt_time_24h' },
    { value: '12h', label: 'admin.opt_time_12h' },
  ],
  'notes.default_editor': [
    { value: 'wysiwyg',  label: 'admin.opt_wysiwyg' },
    { value: 'markdown', label: 'admin.opt_markdown' },
  ],
  'office.default_format': [
    { value: 'docx', label: 'admin.opt_format_docx' },
    { value: 'odt',  label: 'admin.opt_format_odt' },
  ],
  'office.default_margins': [
    { value: 'normal', label: 'admin.opt_margin_normal' },
    { value: 'narrow', label: 'admin.opt_margin_narrow' },
    { value: 'wide',   label: 'admin.opt_margin_wide' },
  ],
  'network.tls_min_version': [
    { value: '1.2', label: 'admin.opt_tls_12' },
    { value: '1.3', label: 'admin.opt_tls_13' },
  ],
  'network.cert_mode': [
    { value: 'manual', label: 'admin.opt_certmode_manual' },
    { value: 'acme',   label: 'admin.opt_certmode_acme' },
  ],
}

/**
 * A key shown only while another ENUM setting in the same block holds one of the
 * listed values.
 *
 * The generic `depends_on` gates a field on a BOOLEAN of the same module, which
 * cannot express "show this only for one branch of a type selector". The CAPTCHA
 * group is exactly that shape: `security.captcha_type` picks distorted text, a
 * slider puzzle or a small sum, and each branch has its own tuning knobs that
 * mean nothing under the other two. Without this the six branch-specific fields
 * all showed at once, so an operator setting up the slider was reading three
 * fields about character distortion that would never apply.
 *
 * Keyed by the controlled setting; the value names the controller and the set of
 * its values that reveal the field. A controller absent from this instance
 * hides nothing (fail open - better a field too many than a field the operator
 * can never reach).
 */
export const VISIBLE_WHEN: Record<string, { key: string; in: string[] }> = {
  'security.captcha_length':           { key: 'security.captcha_type', in: ['text'] },
  'security.captcha_distortion':       { key: 'security.captcha_type', in: ['text'] },
  'security.captcha_noise':            { key: 'security.captcha_type', in: ['text'] },
  'security.captcha_slider_tolerance': { key: 'security.captcha_type', in: ['slider'] },
  'security.captcha_math_max':         { key: 'security.captcha_type', in: ['math'] },
}

/**
 * Keys rendered as a filtered list of IANA zones rather than a free-text field.
 *
 * `instance.timezone` and `calendar.default_timezone` are two different
 * decisions and neither replaces the other: the first says how the SERVER dates
 * what it writes to a human (the timestamp on outgoing mail), the second says
 * which grid a calendar draws. They are deliberately left independent.
 */
export const TIMEZONE_KEYS = new Set(['instance.timezone', 'calendar.default_timezone'])

// ── Derived indexes (built once) ─────────────────────────────────────────────

const PAGE_BY_TAB = new Map(SETTINGS_PAGES.map(p => [p.tab, p]))

/** key → owning tab, for every key any page claims. */
const TAB_BY_KEY = new Map<string, string>()
for (const page of SETTINGS_PAGES) {
  for (const group of page.groups) {
    for (const key of group.keys) TAB_BY_KEY.set(key, page.tab)
  }
}
for (const [key, tab] of Object.entries(DEDICATED_EDITOR)) TAB_BY_KEY.set(key, tab)

/** The page spec for a tab, or undefined when the tab carries no settings block. */
export const specForTab = (tab: string): SettingsPageSpec | undefined => PAGE_BY_TAB.get(tab)

/**
 * Which page shows this key - the answer the admin search needs to deep-link a
 * setting. Unclaimed keys resolve to the fallback page, where they really are.
 */
export const tabForSetting = (key: string): string => TAB_BY_KEY.get(key) ?? FALLBACK_TAB

/** Is this key claimed by some page (or owned by a dedicated editor)? */
export const isClaimed = (key: string): boolean => TAB_BY_KEY.has(key)
