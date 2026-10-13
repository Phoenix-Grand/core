/**
 * The parts of `HomeSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { BarChart3, Building2, Contact, HardDrive, LayoutGrid, Plus, Shield, Users, type LucideIcon } from "lucide-react"
import { fmtBytes } from "../DashboardCharts"
import { adminUrl } from "../adminAction"
import type { HomeSection } from './HomeSection'

function HomeCard({ children }: { children: ReactNode }) {
  return <div className="bg-[#F0F4F9] rounded-xl border border-border p-5">{children}</div>
}
export { HomeCard }

function CardHeader({ Icon, title, manageTab }: { Icon: LucideIcon; title: string; manageTab?: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between mb-3 gap-2">
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon size={20} className="text-text-secondary shrink-0" />
        <h3 className="text-base font-medium text-text-primary truncate">{title}</h3>
      </div>
      {manageTab && (
        <Link to={adminUrl({ tab: manageTab })} className="text-sm text-primary hover:underline shrink-0">
          {t('admin.card_manage')}
        </Link>
      )}
    </div>
  )
}
export { CardHeader }

function CardLink({ to, icon, children }: { to: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <Link to={to} className="flex items-center gap-2 text-sm text-primary hover:underline py-1.5">
      {icon}{children}
    </Link>
  )
}
export { CardLink }

export function Part1({ t, hasStats, num, stats, sees }: { t: NonNullable<HomeSection['tr']>; hasStats: NonNullable<HomeSection['hasStats']>; num: HomeSection['num']; stats: HomeSection['stats']; sees: HomeSection['sees'] }) {
  return (
    <HomeCard>
                <CardHeader Icon={Users} title={t('admin.tab_users')} manageTab="users" />
                {hasStats && (
                  <div className="mb-3">
                    <p className="text-sm text-text-tertiary">{t('admin.home_users_active')}</p>
                    <p className="text-3xl font-semibold text-text-primary leading-tight">{num(stats?.users_active)}</p>
                  </div>
                )}
                <div className="border-t border-border pt-1">
                  <CardLink to={adminUrl({ tab: 'users' })}  icon={<Plus size={15} />}>{t('admin.home_add_user')}</CardLink>
                  <CardLink to={adminUrl({ tab: 'users' })}  icon={<Users size={15} />}>{t('admin.home_manage_users')}</CardLink>
                  {sees('groups') && (
                    <CardLink to={adminUrl({ tab: 'groups' })} icon={<Contact size={15} />}>{t('admin.home_view_groups')}</CardLink>
                  )}
                </div>
              </HomeCard>
  )
}

export function Part2({ t, hasStats, num, stats, sees }: { t: NonNullable<HomeSection['tr']>; hasStats: NonNullable<HomeSection['hasStats']>; num: HomeSection['num']; stats: HomeSection['stats']; sees: HomeSection['sees'] }) {
  return (
    <HomeCard>
                <CardHeader Icon={LayoutGrid} title={t('admin.nav_apps')} manageTab="modules" />
                {hasStats && (
                  <div className="mb-3">
                    <p className="text-3xl font-semibold text-text-primary leading-tight">{num(stats?.modules_active)}</p>
                    <p className="text-sm text-text-tertiary">{t('admin.home_apps_active')}</p>
                  </div>
                )}
                <div className="border-t border-border pt-1">
                  <CardLink to={adminUrl({ tab: 'modules' })}>{t('admin.nav_installed_modules')}</CardLink>
                  {sees('marketplace') && <CardLink to={adminUrl({ tab: 'marketplace' })}>{t('admin.nav_marketplace')}</CardLink>}
                </div>
              </HomeCard>
  )
}

export function Part3({ t, storageUsed, storageQuota, storagePct }: { t: NonNullable<HomeSection['tr']>; storageUsed: NonNullable<HomeSection['storageUsed']>; storageQuota: NonNullable<HomeSection['storageQuota']>; storagePct: NonNullable<HomeSection['storagePct']> }) {
  return (
    <HomeCard>
                <CardHeader Icon={HardDrive} title={t('admin.nav_storage')} />
                <p className="text-sm text-text-secondary mb-2">{fmtBytes(storageUsed)} / {fmtBytes(storageQuota)}</p>
                <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${storagePct}%`, background: storagePct >= 90 ? '#d93025' : '#1a73e8' }} />
                </div>
                <p className="text-sm text-text-tertiary mt-2">{t('admin.home_storage_pct', { pct: Math.round(storagePct) })}</p>
              </HomeCard>
  )
}

export function Part4({ t }: { t: NonNullable<HomeSection['tr']> }) {
  return (
    <HomeCard>
                <CardHeader Icon={Shield} title={t('admin.nav_security')} manageTab="sso" />
                <p className="text-sm text-text-secondary mb-2">{t('admin.home_security_desc')}</p>
                <div className="border-t border-border pt-1">
                  <CardLink to={adminUrl({ tab: 'sso' })}>{t('admin.nav_auth_sso')}</CardLink>
                </div>
              </HomeCard>
  )
}

export function Part5({ t }: { t: NonNullable<HomeSection['tr']> }) {
  return (
    <HomeCard>
                <CardHeader Icon={Users} title={t('admin.tab_groups')} manageTab="groups" />
                <p className="text-sm text-text-secondary">{t('admin.home_groups_desc')}</p>
              </HomeCard>
  )
}

export function Part6({ t }: { t: NonNullable<HomeSection['tr']> }) {
  return (
    <HomeCard>
                <CardHeader Icon={Building2} title={t('admin.home_account_title')} manageTab="settings" />
                <p className="text-sm text-text-secondary">{t('admin.home_account_desc')}</p>
              </HomeCard>
  )
}

export function Part7({ t }: { t: NonNullable<HomeSection['tr']> }) {
  return (
    <HomeCard>
                <CardHeader Icon={BarChart3} title={t('admin.nav_reporting')} manageTab="event-log" />
                <p className="text-sm text-text-secondary">{t('admin.home_reports_desc')}</p>
              </HomeCard>
  )
}
