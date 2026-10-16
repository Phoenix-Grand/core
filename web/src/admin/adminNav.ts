import {
  BarChart3, Building2, Cloud, Contact, CreditCard, Home, LayoutDashboard, LayoutGrid,
  MonitorSmartphone, Puzzle, Server, Shield, Workflow, type LucideIcon,
} from 'lucide-react'
import { PRIV, type CanFn } from '../core/authz/types'

// ── Admin navigation tree ────────────────────────────────────────────────────
// Collapsible sections up to 3 levels deep. A node WITH children is an
// expand-only group (not navigable - clicking toggles it). A leaf routes to
// /admin/<id>. `soon` leaves render a placeholder. `secondary` top-level
// sections are hidden behind "Show more". Existing tab ids are preserved so old
// links keep working.
//
// This module is the single declarative source of truth for the admin menu:
// adding an entry here is what makes a section reachable (see AdminPage.tsx for
// the full "add a section" checklist).
//
// ── Why the sections are in THIS order ───────────────────────────────────────
// It follows the console this product's administration is modelled on, because
// operators arrive already knowing that order: who the people are (annuaire),
// what they connect from (appareils), what they use (applications), what
// protects it (sécurité), what it produced (rapports), what the instance itself
// is (instance), and what runs by itself (automatisation). Capacity and the
// machinery underneath sit last, behind the fold, because they are consulted
// once a quarter - and a menu whose fifteen branches are all on screen at once
// is a wall, not a menu.

/**
 * How a section spells its address, beyond its own id.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The console addresses a place by path: `/admin/users/<id>/security`, but also
 * `/admin/resources/buildings`. The second segment is a RECORD in the first and
 * a PANE in the second, and nothing in the strings themselves says which. The
 * tempting shortcut - "it looks like a UUID, so it is a record" - is a guess
 * about the shape of an identifier, and it holds exactly until the first
 * identifier that is not a UUID (a country code, a module id, a slug), then
 * misreads an address an operator pasted, silently.
 *
 * So each section DECLARES its shape, here, next to the leaf that defines it,
 * and both the URL builder and the URL reader (`adminRoute.ts`) obey the same
 * declaration. Without it the two would eventually parse the same address by
 * two different approximations.
 *
 * ── Rules a declaration must respect ─────────────────────────────────────────
 *
 *  • `panes` is a CLOSED list of stable, untranslated ids (`security`,
 *    `buildings`) - never localised labels: an address may not change shape
 *    with the interface language.
 *  • A record id must never collide with one of the section's pane ids, or
 *    `/admin/<section>/<that-id>` would read as the pane.
 *  • A section that declares nothing keeps its parameters in the query string.
 *    That is a graceful degradation, never a misreading - which is why adding a
 *    pane and forgetting to list it here costs a prettier URL, not correctness.
 */
export interface AdminUrlShape {
  /**
   * Query parameter naming the ONE record the section opens - it becomes the
   * segment right after the section id. A section whose parameters are all
   * filters (`q`, `status`…) declares none.
   */
  entity?: string
  /**
   * The `pane` values this section addresses, in the path: last segment, after
   * the record when there is one (`/admin/users/<id>/security`), directly after
   * the section when its panes stand alone (`/admin/resources/buildings`).
   */
  panes?:  readonly string[]
  /**
   * The panes of THIS section are not knowable at build time - they belong to
   * the record, and the record is discovered at runtime.
   *
   * One section needs this: the installed modules. Each module splits its
   * administration into pages it declares itself (`[[setting_groups]]` in its
   * manifest), so the core cannot list them here without naming modules - the
   * one thing it never does.
   *
   * Why accepting an unlisted pane is SAFE here, and only here: the flag is
   * legal solely on a section that also declares `entity`, and it is honoured
   * ONLY in third position, `/admin/<section>/<record>/<pane>`. At that depth
   * there is nothing left to disambiguate - the record has already claimed the
   * second segment, and a third segment can be nothing but one of its panes.
   * The ambiguity this whole file exists to prevent ("is this segment a record
   * or a pane?") simply cannot arise. The second segment keeps being read
   * exactly as before: the record, never a pane.
   *
   * What is still declared, and what is not: the SHAPE stays declared here (a
   * record, then its panes); only the VOCABULARY of the panes is deferred to
   * the record. The section is therefore responsible for what an unknown pane
   * means - `ModuleAdminPage` falls back to the module's first group rather
   * than painting an empty page for a bookmark that outlived a group.
   */
  dynamicPanes?: boolean
}

export interface AdminNavItem {
  id:         string
  labelKey:   string
  Icon?:      LucideIcon   // top-level items only
  badge?:     string       // small chip, e.g. "BETA"
  soon?:      boolean      // renders the "coming soon" placeholder
  secondary?: boolean      // top-level: behind "Show more"
  children?:  AdminNavItem[]
  /**
   * Privilege required to *see* this leaf - the read-level key of whatever the
   * section calls. A leaf without one is visible to any administrator (the
   * landing page). Groups carry none: a group is visible exactly when at least
   * one of its children is.
   */
  priv?:      string
  /**
   * Everything this section puts in the path after its own id. Leaves that
   * address nothing but themselves declare nothing (see `AdminUrlShape`).
   */
  url?:       AdminUrlShape
}

export const ADMIN_NAV: AdminNavItem[] = [
  { id: 'home',      labelKey: 'admin.nav_home',      Icon: Home },
  { id: 'dashboard', labelKey: 'admin.tab_dashboard', Icon: LayoutDashboard, priv: PRIV.STATS_READ },
  { id: 'directory', labelKey: 'admin.nav_directory', Icon: Contact, children: [
    // The account sheet and its three panes (`sections/user-detail`).
    { id: 'users',              labelKey: 'admin.tab_users',                                        priv: PRIV.USERS_READ,
      url: { entity: 'user', panes: ['profile', 'security', 'activity'] } },
    { id: 'groups',             labelKey: 'admin.tab_groups',                                       priv: PRIV.GROUPS_READ },
    { id: 'audiences',          labelKey: 'admin.nav_audiences',                                    priv: 'core.audiences.read',
      url: { entity: 'audience' } },
    { id: 'org-units',          labelKey: 'admin.nav_org_units',                                    priv: PRIV.ORG_UNITS_READ },
    // Buildings, bookable resources and the equipment attached to them. Under
    // Directory rather than under a module: it describes the organisation, like
    // accounts and units do, and several modules read it while none owns it.
    // The key is a literal rather than a `PRIV.*` entry so that this file - a
    // declarative list - keeps its single import; the constant lives with the
    // section that enforces it (`sections/resources/privileges.ts`).
    // Four screens, no record of its own: the pane IS the second segment
    // (`/admin/resources/buildings`). Kept in step with `ResourcePane`.
    { id: 'resources',          labelKey: 'admin.nav_resources',                                    priv: 'core.resources.read',
      url: { panes: ['overview', 'buildings', 'resources', 'features'] } },
    // The page is made ENTIRELY of scoped settings, so reading it needs
    // `settings.read` - not `users.read`, which would have offered the entry to
    // a delegated account the settings route then answers 403 to.
    { id: 'directory-settings', labelKey: 'admin.nav_directory_settings',                           priv: PRIV.SETTINGS_READ },
  ] },
  { id: 'devices', labelKey: 'admin.nav_devices', Icon: MonitorSmartphone, children: [
    // `device` is the record; `user` is a filter here ("the sessions of that
    // account"), so it stays in the query string.
    { id: 'device-sessions', labelKey: 'admin.nav_sessions',  priv: PRIV.SESSIONS_READ,
      url: { entity: 'device' } },
    // Where the live sessions come from - addresses and countries. Gated on
    // the session key, not the settings one: it is a session listing.
    { id: 'networks',        labelKey: 'admin.nav_networks',  priv: PRIV.SESSIONS_READ },
  ] },
  { id: 'apps', labelKey: 'admin.nav_apps', Icon: LayoutGrid, children: [
    // The one section whose children are DISCOVERED, not declared: every
    // installed module is a row under it, and clicking one opens that module's
    // administration page. They cannot be listed here - the core learns which
    // modules exist from the instance, never from a hard-coded name - so the
    // menu tree is grafted at render time (`AdminNavTree`) while this file keeps
    // declaring the only thing that is fixed: the SHAPE of the address.
    //
    // A module id is `drive` or `speech-to-text`, never a UUID; the declaration
    // is precisely what lets `/admin/modules/speech-to-text` be read as "the
    // modules section, one module open" without guessing from the segment.
    //
    // `dynamicPanes`: a module that splits its panel into pages declares them in
    // its own manifest, so the pane vocabulary belongs to the record, not here
    // (`/admin/modules/mail/authentication`). Safe because the pane can only be
    // the THIRD segment - see `AdminUrlShape.dynamicPanes`.
    { id: 'modules',         labelKey: 'admin.nav_installed_modules',                priv: PRIV.MODULES_READ,
      url: { entity: 'module', dynamicPanes: true } },
    { id: 'marketplace',     labelKey: 'admin.nav_marketplace',                      priv: PRIV.MARKETPLACE_MANAGE,
      url: { entity: 'related' } },
  ] },
  // Capabilities the core itself provides, as opposed to the modules it hosts.
  // Voice search lives here rather than under Applications because it is a CORE
  // feature: the `stt` process is `internal` infrastructure (a Vosk engine with
  // no frontend of its own), never a module a user installs or removes. Naming
  // the entry after the feature - not after the `speech-to-text` module id -
  // is what keeps this file free of any module's name, the rule the modules
  // submenu is built to honour.
  { id: 'core-features', labelKey: 'admin.nav_core_features', Icon: Puzzle, children: [
    { id: 'voice-search',  labelKey: 'admin.nav_voice_search',                    priv: PRIV.MODULES_MANAGE },
  ] },
  { id: 'security', labelKey: 'admin.nav_security', Icon: Shield, children: [
    // Promoted out of Security ▸ Security centre (depth 3) to a direct child.
    // A page that says the instance has no backups and still carries its seeded
    // password is not something an operator finds by exploring a submenu.
    // No `priv`: the report narrows itself server-side to what the caller may
    // read, so every administrator sees their own perimeter rather than a 403.
    { id: 'security-health', labelKey: 'admin.nav_security_health' },
    // Next to the health report on purpose: one says what is wrong with the
    // instance, the other is the queue of what somebody still has to do about
    // it. Splitting them across two branches is how an operator reads one and
    // never finds the other.
    { id: 'alerts', labelKey: 'admin.nav_alerts', priv: PRIV.ALERTS_READ, url: { entity: 'alert' } },
    { id: 'sso',         labelKey: 'admin.nav_auth_sso',                   priv: PRIV.AUTH_PROVIDERS_READ },
    // Its own leaf rather than a block folded into SSO: an operator connecting a
    // corporate directory is doing a different job (a service account, a search
    // filter, an import) from one declaring an OpenID provider, and the page is
    // large enough that sharing one would bury both.
    { id: 'ldap',        labelKey: 'admin.nav_ldap',                       priv: PRIV.AUTH_PROVIDERS_READ },
    // How long a session lives, and what it takes to prove yourself again. Its
    // own page rather than a group folded into a broader one: "how long before
    // people are signed out" is a question operators arrive with.
    { id: 'session-policy', labelKey: 'admin.nav_session_policy',          priv: PRIV.SETTINGS_READ },
    // Programmatic access - what a credential that is not a browser may do.
    // Gated on the settings key, not the audit one: the page edits policy.
    { id: 'access-data', labelKey: 'admin.nav_access_data',                priv: PRIV.SETTINGS_READ },
    // Rate limits and flood protection: what keeps the instance answering.
    { id: 'service-protection', labelKey: 'admin.nav_service_protection',  priv: PRIV.SETTINGS_READ },
    // The overview, above the reports it summarises. Every panel it draws is a
    // count over what the core itself records - the audit trail, the alert
    // queue, the rule log, the device inventory - and each one links back to the
    // report that owns those records. Gated on the audit key, which is the one
    // an operator trusted with "read what happened here" already holds.
    { id: 'security-center', labelKey: 'admin.nav_security_center', children: [
      { id: 'security-dashboard', labelKey: 'admin.nav_security_dashboard', priv: PRIV.AUDIT_READ },
    ] },
  ] },
  { id: 'reporting', labelKey: 'admin.nav_reporting', Icon: BarChart3, children: [
    // The printable documents behind the dashboard panels - one panel, one
    // window, every figure, in a form that can be handed to somebody or filed.
    // Its record is the PANEL (`/admin/reports/storage`); the window and the
    // dashboard the id came from identify no place and stay in the query
    // string. No `priv`: a report narrows itself to what its own endpoint
    // serves the caller - every panel is gated at instance scope there - so an
    // administrator who may read one report and not another sees the catalogue
    // and is told, per document, which ones are withheld.
    { id: 'reports',   labelKey: 'admin.nav_reports',   url: { entity: 'panel' } },
    { id: 'event-log', labelKey: 'admin.nav_event_log', priv: PRIV.AUDIT_READ },
    { id: 'audit',     labelKey: 'admin.nav_audit',     priv: PRIV.AUDIT_READ },
  ] },
  // What this instance IS. Named after the thing being administered rather than
  // after a subscription: the reference this console imitates calls it
  // "Account" because it means *your account with the vendor*, and a
  // self-hosted product has no vendor and no account - it has an instance.
  //
  // The section id stays `account` so that every link minted while it carried
  // that name still resolves; only the label and the icon are what people read.
  { id: 'account', labelKey: 'admin.nav_instance', Icon: Building2, children: [
    { id: 'settings',       labelKey: 'admin.nav_instance_profile',              priv: PRIV.SETTINGS_READ },
    // Right under the identity, because it answers the same question those
    // fields do - where this organisation lives. The language and the time zone
    // are on the page above; the days off are too big a referential to be a
    // field, so they are the leaf next to it. The key is a literal so that this
    // declarative list keeps its single import.
    // Two landing panes, plus one territory's calendar as a record. A calendar
    // id may therefore never be `calendars` or `units`.
    { id: 'holidays',       labelKey: 'admin.nav_holidays',                      priv: 'core.holidays.read',
      url: { entity: 'calendar', panes: ['calendars', 'units'] } },
    { id: 'apparence',      labelKey: 'admin.nav_customization',                 priv: PRIV.THEMES_READ },
    // Ce que l'instance affirme s'appeler, et la preuve DNS qui le rend
    // opposable. Clé littérale, comme les autres sections qui portent leur
    // propre paire de privilèges (cf. `sections/domains/privileges.ts`).
    { id: 'domains',        labelKey: 'admin.nav_domains',                       priv: 'core.domains.read',
      url: { entity: 'domain' } },
    { id: 'admin-roles',    labelKey: 'admin.nav_admin_roles',                   priv: PRIV.ROLES_READ,
      url: { entity: 'role' } },
    // Importer les données d'un autre fournisseur. Clé littérale, comme les
    // sections voisines qui portent leur propre paire de privilèges
    // (cf. `sections/data-migration/privileges.ts`). Adresse une campagne, dont
    // la fiche porte le suivi compte par compte.
    { id: 'data-migration', labelKey: 'admin.nav_data_migration',               priv: 'core.data_migration.read',
      url: { entity: 'campaign' } },
    // Faire SORTIR les données - le miroir de la migration juste au-dessus.
    // Clé littérale, comme les autres sections qui portent leur propre paire de
    // privilèges (cf. `sections/data-export/privileges.ts`) : `core.audit.read`
    // ne convient pas, la page nomme chaque compte couvert par une archive et
    // remet l'archive elle-même. Un enregistrement (l'export ouvert) et aucun
    // volet : `/admin/data-export/<id>`.
    { id: 'data-export',    labelKey: 'admin.nav_data_export',    priv: 'core.data_export.read',
      url: { entity: 'export' } },
  ] },
  // The rule engine. `rules` keeps its original id so links minted while the
  // section was a placeholder still resolve; the run log is its own place
  // because "what did the engine actually do" is a question an operator arrives
  // with, not one they reach through the inventory.
  { id: 'automation', labelKey: 'admin.nav_automation', Icon: Workflow, children: [
    // The rule editor's panes - kept in step with `Pane` in `rules/RuleEditor`.
    { id: 'rules',     labelKey: 'admin.nav_rules',     priv: PRIV.RULES_READ,
      url: { entity: 'rule', panes: ['basics', 'conditions', 'actions', 'scope', 'mode', 'impact', 'history'] } },
    { id: 'rules-log', labelKey: 'admin.nav_rules_log', priv: PRIV.RULES_READ,
      url: { entity: 'rule' } },
    // Data protection. Next to the rules rather than under Security: a
    // detector does nothing on its own - it is the vocabulary a rule is written
    // in, and somebody tuning a threshold is somebody editing a rule.
    { id: 'detectors', labelKey: 'admin.nav_detectors', priv: PRIV.RULES_READ,
      url: { entity: 'detector' } },
  ] },
  // Filed under Facturation because that is where an operator looks for it, and
  // deliberately NOT a billing page: the software is AGPL-3.0-or-later and is
  // not sold - no seat, no plan, no licence to enforce. What the page shows is
  // the licence itself, which installation this is, and whether a support
  // contract exists (see `sections/subscription/SubscriptionSection.tsx`).
  { id: 'billing', labelKey: 'admin.nav_billing', Icon: CreditCard, secondary: true, children: [
    { id: 'subscription', labelKey: 'admin.nav_subscription', priv: PRIV.SETTINGS_READ },
  ] },
  // Capacity. Its own key rather than `settings.manage`: reading how full the
  // instance is, and which accounts fill it, is what a delegated operator needs;
  // changing a quota or the default policy is still gated on the account and
  // settings keys, inside the page.
  { id: 'storage', labelKey: 'admin.nav_storage', Icon: Cloud,    secondary: true, priv: PRIV.STORAGE_READ },
  // What runs the instance rather than what it serves. One leaf today - the
  // background worker - and the natural home of the operational policies this
  // product still owes its operators (a scheduled backup, first of all).
  { id: 'system', labelKey: 'admin.nav_system', Icon: Server, secondary: true, children: [
    { id: 'background-jobs', labelKey: 'admin.nav_background_jobs', priv: PRIV.SETTINGS_READ },
    // The core's own database: schema prefix and engine switch. Superadmin-gated
    // in the panels and the endpoints; SETTINGS_READ keeps the leaf discoverable.
    { id: 'database',        labelKey: 'admin.nav_database',        priv: PRIV.SETTINGS_READ },
    // HTTP/HTTPS termination: how the instance is reached at all. Infrastructure,
    // like the job runner and the mail relay it sits beside.
    { id: 'network',         labelKey: 'admin.nav_network',         priv: PRIV.SETTINGS_READ },
    // The outgoing mail relay: a pipe the instance sends through, not a trait of
    // who it is. Next to the job runner, which is the other thing that has to be
    // working for a message to leave at all.
    { id: 'email',           labelKey: 'admin.nav_email',           priv: PRIV.MAIL_READ },
  ] },
]

// Flat index: id → { item, ancestor ids, top-level section id }. Built once.
export interface NavMeta { item: AdminNavItem; ancestors: string[]; topId: string }
export const NAV_INDEX = new Map<string, NavMeta>()
;(function indexNav(items: AdminNavItem[], ancestors: string[], topId: string | null) {
  for (const it of items) {
    const top = topId ?? it.id
    NAV_INDEX.set(it.id, { item: it, ancestors, topId: top })
    if (it.children) indexNav(it.children, [...ancestors, it.id], top)
  }
})(ADMIN_NAV, [], null)

/** First navigable descendant of a group (groups themselves are not routable). */
export const firstLeafOf = (item: AdminNavItem): string =>
  (item.children?.length ? firstLeafOf(item.children[0]) : item.id)

/** Same, addressed by id (unknown ids are returned unchanged). */
export const firstLeafId = (id: string): string => {
  const item = NAV_INDEX.get(id)?.item
  return item ? firstLeafOf(item) : id
}

/**
 * Prunes the tree down to what `can` allows.
 *
 * A leaf survives when its `priv` is held (or it declares none); a group
 * survives only when at least one descendant did - an empty group is a heading
 * pointing at nothing. Returns fresh nodes, so `firstLeafOf` on a filtered group
 * lands on a leaf the caller may actually open.
 */
export function filterNav(items: AdminNavItem[], can: CanFn): AdminNavItem[] {
  const out: AdminNavItem[] = []
  for (const item of items) {
    if (item.children?.length) {
      const children = filterNav(item.children, can)
      if (children.length > 0) out.push({ ...item, children })
    } else if (!item.priv || can(item.priv)) {
      out.push(item)
    }
  }
  return out
}

/**
 * May the caller open this tab? Unknown ids are refused - resolving a tab that
 * is not in the tree would bypass the filter entirely.
 */
export function canSeeTab(id: string, can: CanFn): boolean {
  const item = NAV_INDEX.get(id)?.item
  if (!item) return false
  if (item.children?.length) return filterNav([item], can).length > 0
  return !item.priv || can(item.priv)
}

/** Full menu path (breadcrumb) to a nav id: ancestor labels + the item's own label. */
export function navPathLabels(t: (k: string) => string, id: string): string[] {
  const meta = NAV_INDEX.get(id)
  if (!meta) return []
  return [...meta.ancestors.map(a => t(NAV_INDEX.get(a)!.item.labelKey)), t(meta.item.labelKey)]
}
