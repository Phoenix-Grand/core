import type { ComponentType } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Tabs } from '@ui'
import { adminUrlWith } from '../adminAction'
import UsersSection from './UsersSection'
import GroupsPanel from '../views/GroupsPanel'
import OrgUnitsPanel from '../views/OrgUnitsPanel'
import ModulesPanel from '../views/ModulesPanel'
import ModuleAdminPage from '../views/ModuleAdminPage'
import MarketplacePanel from '../views/MarketplacePanel'
import OAuthProvidersPanel from '../pages/OAuthProvidersPanel'
import LdapSection from '../ldap/LdapSection'
import AuthMethodsPanel from '../pages/AuthMethodsPanel'
import AdminRolesPanel from '../views/AdminRolesPanel'
import SettingsGroupPanel from '../settings/views/SettingsGroupPanel'
import SettingsMovedNotice from '../settings/pages/SettingsMovedNotice'
import MailSettingsPanel from '../views/MailSettingsPanel'
import NetworkPanel from '../views/NetworkPanel'
import ThemesPanel from '../views/ThemesPanel'
import LoginAnimationPanel from '../views/LoginAnimationPanel'
import SpeechToTextPanel from '../views/SpeechToTextPanel'
import AuditSection from './AuditSection'
import EventLogSection from './EventLogSection'
import HomeSection from './HomeSection'
import DashboardSection from './DashboardSection'
import HealthSection from '../health/HealthSection'
import AlertsSection from '../alerts/AlertsSection'
import DevicesSection from '../devices/DevicesSection'
import NetworksSection from '../devices/NetworksSection'
import RulesSection from '../rules/RulesSection'
import DetectorsSection from '../detectors/DetectorsSection'
import SecurityDashboardSection from '../security/SecurityDashboardSection'
import ReportsSection from '../reports/ReportsSection'
import StorageSection from '../storage/StorageSection'
import BackupPanel from '../backup/BackupPanel'
import DatabasePanel from '../database/DatabasePanel'
import AudiencesSection from './audiences/AudiencesSection'
import ResourcesSection from './resources/ResourcesSection'
import DirectorySettingsSection from './directory-settings/DirectorySettingsSection'
import HolidaysSection from './holidays/HolidaysSection'
import DomainsSection from './domains/DomainsSection'
import DataMigrationSection from './data-migration/DataMigrationSection'
import DataExportSection from './data-export/DataExportSection'
import SubscriptionSection from './subscription/SubscriptionSection'
import { adminUrl } from '../adminAction'
import { RulesLogSection } from '../rules/RulesLogSection'

/**
 * Everything a section may need from the router. Sections that need neither may
 * simply declare no props (a zero-arg component is a valid section component).
 */
export interface AdminSectionProps {
  /**
   * What the address says, as parameters: the query string, PLUS the record and
   * the pane the path carries, republished under the names they had when they
   * were parameters. `/admin/marketplace/drive` reads as `related=drive`,
   * `/admin/users/<id>/security` as `user=<id>&pane=security` — so a section
   * keeps asking `params.get('user')` and never learns where its id is spelt
   * (see `adminRoute.ts`).
   */
  params:   URLSearchParams
  navigate: NavigateFunction
}

export interface AdminSection {
  Component: ComponentType<AdminSectionProps>
  /**
   * The section paints its own page header (landing title, breadcrumb…), so
   * AdminPage must NOT prepend the generic `<h1>` of the nav label.
   */
  ownHeader?: boolean
}

/**
 * A subsystem's page and that subsystem's settings, as two tabs.
 *
 * The settings of a subsystem belong WITH the surface that shows what they do —
 * an alert threshold with the alert queue, a retention with the log it prunes.
 * They used to be stacked below the content, which left a narrow settings block
 * marooned under a full-width table; now the two share a tab bar, each taking
 * the whole width, and the "Réglages" tab flows its categories into columns.
 * The composition stays here so no section has to know it ends in a settings
 * tab, and `settingsMap.ts` remains the only place that says which keys those
 * are.
 *
 * `isDetail` is what suppresses the tabs entirely: when one record's sheet has
 * taken over the page, the subsystem's knobs are not what the operator came for
 * and a tab bar over a record sheet would read as belonging to the record. The
 * active tab rides in `?view=settings` — an undeclared parameter the router
 * keeps in the query string, so a refresh or a shared link lands on the same
 * tab without any address-shape change.
 */
/** One tab of a subsystem page: its stable id (rides in `?view=`), its label,
 *  and what it renders. */
interface TabbedPanel {
  id:           string
  labelKey:     string
  labelDefault: string
  Panel:        ComponentType<AdminSectionProps>
}

function TabbedSubsystem({
  tab, panels, isDetail, params, navigate,
}: {
  tab:       string
  panels:    TabbedPanel[]
  isDetail?: (params: URLSearchParams) => boolean
} & AdminSectionProps) {
  const { t } = useTranslation()
  // A record sheet is a place of its own — no tabs. The first panel is the one
  // that owns records (for `withSettings`, the section itself).
  if (isDetail?.(params)) {
    const First = panels[0].Panel
    return <First params={params} navigate={navigate} />
  }

  const ids     = panels.map(p => p.id)
  const asked   = params.get('view') ?? ''
  const current = ids.includes(asked) ? asked : ids[0]
  const Active  = (panels.find(p => p.id === current) ?? panels[0]).Panel
  const tabs    = panels.map(p => ({ id: p.id, label: t(p.labelKey, { defaultValue: p.labelDefault }) }))

  return (
    <div className="flex min-w-0 flex-col">
      <Tabs
        tabs={tabs}
        value={current}
        // The first tab is the default, so it drops the parameter — a clean URL
        // for the page as it opens.
        onChange={id => navigate(adminUrlWith(tab, params, { view: id === ids[0] ? null : id }))}
        className="mb-6"
        t={t}
      />
      <Active params={params} navigate={navigate} />
    </div>
  )
}

/** The "Réglages" tab: this subsystem's scoped settings, full width. */
const settingsPanel = (tab: string): TabbedPanel => ({
  id: 'settings', labelKey: 'admin.subtab_settings', labelDefault: 'Réglages',
  Panel: () => <SettingsGroupPanel tab={tab} layout="tab" />,
})

/**
 * A subsystem page as tabs. `content` are the content tabs in order; the
 * settings tab is appended when the subsystem has scoped keys. The active tab
 * rides in `?view=<id>` — an undeclared parameter the router keeps in the query
 * string, so a refresh or a shared link lands on the same tab with no
 * address-shape change. `isDetail` suppresses the whole tab bar: over a record
 * sheet it would read as belonging to the record.
 */
function tabbed(
  tab:     string,
  content: TabbedPanel[],
  opts?:   { isDetail?: (params: URLSearchParams) => boolean; settings?: boolean },
): ComponentType<AdminSectionProps> {
  const panels = opts?.settings ? [...content, settingsPanel(tab)] : content
  return function TabbedSection(props: AdminSectionProps) {
    return <TabbedSubsystem tab={tab} panels={panels} isDetail={opts?.isDetail} {...props} />
  }
}

/**
 * The common case: a subsystem whose page is one surface (an inventory, a queue)
 * plus its settings. Two tabs — the surface, then "Réglages".
 *
 * The settings of a subsystem belong WITH the surface that shows what they do,
 * and used to be stacked below it — a narrow block marooned under a full-width
 * table. Now they share a tab bar, each taking the whole width, and the settings
 * tab flows its categories into columns. `settingsMap.ts` stays the only place
 * that says which keys those are.
 */
function withSettings(
  Section:  ComponentType<AdminSectionProps>,
  tab:      string,
  isDetail?: (params: URLSearchParams) => boolean,
): ComponentType<AdminSectionProps> {
  return tabbed(
    tab,
    [{ id: 'overview', labelKey: 'admin.subtab_overview', labelDefault: 'Vue d’ensemble', Panel: Section }],
    { isDetail, settings: true },
  )
}

/**
 * Tab id (a navigable leaf of ADMIN_NAV) → section rendered in the module area.
 * A leaf without an entry here falls back to the "coming soon" placeholder when
 * it is flagged `soon: true` in adminNav.ts.
 */
export const ADMIN_SECTIONS: Record<string, AdminSection> = {
  'home':          { Component: HomeSection, ownHeader: true },
  'dashboard':     { Component: DashboardSection },
  // Renders the list or one account's sheet, each with its own header.
  'users':         { Component: UsersSection, ownHeader: true },
  'groups':        { Component: GroupsPanel },
  'org-units':     { Component: OrgUnitsPanel },
  // Four screens behind tabs, and its own title above them.
  'audiences':     { Component: AudiencesSection, ownHeader: true },
  'resources':     { Component: ResourcesSection, ownHeader: true },
  // The referential, then the two keys that decide who sees which territory.
  // The settings block sits under the LANDING only: inside one country, an
  // instance-wide scope bar would read as governing that country.
  'holidays':      { Component: withSettings(HolidaysSection, 'holidays', p => !!p.get('calendar')), ownHeader: true },
  // La liste, ou la fiche d'un domaine — chacune avec son propre en-tête. Le
  // réglage d'inscription vit sous la LISTE : à l'intérieur d'un domaine, il
  // se lirait comme s'appliquant à celui-là seul.
  'domains':       { Component: withSettings(DomainsSection, 'domains', p => !!p.get('domain')), ownHeader: true },
  // La liste des campagnes, ou la fiche de l'une d'elles — chacune avec son
  // propre en-tête. Pas de `withSettings` : la section ne possède aucun réglage
  // d'instance, tout ce qu'elle configure appartient à une campagne.
  'data-migration': { Component: DataMigrationSection, ownHeader: true },
  // Le miroir : faire sortir les données. `withSettings`, parce que la
  // section possède bien des réglages d'instance (le délai de sécurité, la
  // rétention, les prérequis) — et `isDetail` sur l'export ouvert, pour que la
  // liste des comptes couverts ne se lise pas sous une barre d'onglets qui
  // parle de la page entière.
  'data-export':   { Component: withSettings(DataExportSection, 'data-export', p => !!p.get('export')) },
  // Paints its own title, its framing callout and its scope bar — and is made
  // entirely of scoped settings, so no `withSettings` wrapper: the page would
  // otherwise end with a second scope bar governing the same keys.
  'directory-settings': { Component: DirectorySettingsSection, ownHeader: true },
  // The inventory, or one module's administration page. Which one is decided by
  // the address — `/admin/modules` vs `/admin/modules/<id>` — and both paint
  // their own title, so `ownHeader`.
  'modules':       { Component: (props) => (
    props.params.get('module') ? <ModuleAdminPage {...props} /> : <ModulesPanel {...props} />
  ), ownHeader: true },
  'marketplace':   { Component: ({ params, navigate }) => (
    <MarketplacePanel onBack={() => navigate(adminUrl({ tab: 'modules' }))} related={params.get('related')} />
  ) },
  // Identity providers, then the sign-in policy they compete with.
  // Which methods this scope accepts comes FIRST: an operator arriving to
  // "configure SSO" has to see what the instance actually permits before they
  // declare a provider that nobody is allowed to use.
  'sso':           { Component: withSettings(
    () => <><AuthMethodsPanel /><div className="mt-6"><OAuthProvidersPanel /></div></>, 'sso') },
  // The directories, then the instance-wide switches that govern them.
  'ldap':          { Component: withSettings(LdapSection, 'ldap') },
  'security-health': { Component: HealthSection },
  // The overview: a grid of panels, a period selector beside the title and a
  // customisation mode — so it paints its own header rather than inheriting the
  // generic one, which would leave the selector orphaned below the title.
  'security-dashboard': { Component: SecurityDashboardSection, ownHeader: true },
  // Renders the queue or one alert's sheet, each with its own header; the
  // thresholds sit under the queue, not under one alert.
  'alerts':        { Component: withSettings(AlertsSection, 'alerts', p => !!p.get('alert')), ownHeader: true },
  // Renders its own breadcrumb header.
  'admin-roles':   { Component: AdminRolesPanel, ownHeader: true },
  // What identifies the instance — plus anything no page has claimed yet.
  'settings':      { Component: () => <><SettingsMovedNotice /><SettingsGroupPanel tab="settings" /></> },
  // Pages made ENTIRELY of settings: the block is the page, so no embedded
  // heading and the scope bar keeps its sticky position at the top.
  'session-policy':     { Component: () => <SettingsGroupPanel tab="session-policy" /> },
  'access-data':        { Component: () => <SettingsGroupPanel tab="access-data" /> },
  'service-protection': { Component: () => <SettingsGroupPanel tab="service-protection" /> },
  // The backup policy, its run history and the manual trigger — then the knobs
  // that govern them (and the job runner), as the "Réglages" tab.
  'background-jobs':    { Component: withSettings(() => <BackupPanel />, 'background-jobs') },
  // The core's own database: change the schema prefix at run time, or switch the
  // whole instance to another engine (superadmin only). Guarded server-side.
  'database':           { Component: () => <DatabasePanel /> },
  // Three tabs: the theme gallery, the login-page animation (a live editor that
  // deserves its own room), and the scoped settings.
  'apparence':     { Component: tabbed('apparence', [
    { id: 'themes', labelKey: 'admin.subtab_themes', labelDefault: 'Thèmes', Panel: () => <ThemesPanel /> },
    { id: 'login',  labelKey: 'admin.subtab_login',  labelDefault: 'Animation de connexion',
      Panel: () => <LoginAnimationPanel /> },
  ], { settings: true }) },
  'email':         { Component: MailSettingsPanel },
  // HTTP/HTTPS termination: certificate + live status + the `network.*` toggles.
  'network':       { Component: NetworkPanel, ownHeader: true },
  // Voice search — a core capability, not a module. See `adminNav` core-features.
  'voice-search':   { Component: SpeechToTextPanel },
  // Renders the inventory or one device's sheet, each with its own header.
  'device-sessions': { Component: withSettings(DevicesSection, 'device-sessions', p => !!p.get('device')), ownHeader: true },
  'networks':        { Component: withSettings(NetworksSection, 'networks'), ownHeader: true },
  'audit':         { Component: withSettings(AuditSection, 'audit') },
  'event-log':     { Component: EventLogSection },
  // The catalogue of printable reports, or one report. A report paints its own
  // document head — the instance, the subject, the window, the timestamp — and a
  // generic `<h1>` above it would be a second, contextless title on the sheet.
  'reports':       { Component: ReportsSection, ownHeader: true },
  // Renders the inventory, the editor or one rule's sheet — each with its own
  // header — and the run log as a sibling place.
  'rules':         { Component: withSettings(RulesSection, 'rules', p => !!p.get('rule') || p.get('new') === '1'), ownHeader: true },
  'rules-log':     { Component: withSettings(RulesLogSection, 'rules-log'), ownHeader: true },
  // Renders the catalogue or one detector's editor, each with its own header.
  'detectors':     { Component: withSettings(DetectorsSection, 'detectors', p => !!p.get('detector')), ownHeader: true },
  // Capacity: the page paints its own title and intro.
  'storage':       { Component: StorageSection, ownHeader: true },
  // The licence the software is held under, what this installation IS, and the
  // support contract — if any. Paints its own title and framing callout, hence
  // `ownHeader`. Deliberately NOT wrapped in `withSettings`: the page governs
  // no setting, and a "Réglages" tab would suggest there is a knob here.
  'subscription':  { Component: SubscriptionSection, ownHeader: true },
}
