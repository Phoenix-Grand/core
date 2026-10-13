/**
 * The parts of `ReportsSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { FileText, Info } from "lucide-react"
import { Callout, EmptyState, Spinner } from "@ui"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { useAuthStore } from "../../core/store/authStore"
import { adminUrlWith } from "../adminAction"
import { panelsOf } from "../panels/catalog"
import { reportUrl, type PanelSource } from "../panels/report"
import type { PanelDef } from "../panels/types"
import type { AdminSectionProps } from "../sections/registry"
import { errorMessage, reportPrivilege, useInstanceName, usePanelReport } from "./api"
import ReportDocument from "./ReportDocument"

function OneReport({
  source, panelId, def, params, navigate,
}: {
  source:  PanelSource
  panelId: string
  def:     PanelDef
} & AdminSectionProps) {
  const { t } = useTranslation()
  const { can } = usePrivileges()
  const instanceName = useInstanceName()
  const user = useAuthStore(s => s.user)
  // The same key the query hook gates on. Checked here too, because a query
  // that is disabled resolves to nothing at all — and "nothing at all" on a
  // report page is a blank sheet, which reads as "there was nothing to report".
  const mayRead = can(reportPrivilege(source))

  // The window the address asks for. The server validates it against its own
  // closed list and refuses anything else, so a hand-edited value produces a
  // stated error rather than a silently different document.
  const periodId = params.get('period') || 'last_30_days'
  const { data, isLoading, isError, error } = usePanelReport(source, panelId, periodId)

  const onPeriod = useCallback(
    (id: string) => navigate(adminUrlWith('reports', params, { period: id })),
    [navigate, params],
  )

  if (!mayRead) {
    return (
      <EmptyState
        icon={<Info size={28} />}
        title={t('admin.rep_withheld_title')}
        description={t('admin.rep_withheld_body')}
      />
    )
  }
  if (isLoading) {
    return <div className="flex justify-center py-16"><Spinner /></div>
  }
  if (isError) {
    return (
      <Callout variant="danger">{errorMessage(error, t('admin.rep_load_failed'))}</Callout>
    )
  }
  if (!data) return null

  // The panel exists in the catalogue but this administrator may not read it at
  // instance scope. Said out loud: a blank report would read as "nothing
  // happened", which is the one thing it must never be mistaken for.
  if (data.withheld) {
    return (
      <EmptyState
        icon={<Info size={28} />}
        title={t('admin.rep_withheld_title')}
        description={t('admin.rep_withheld_body')}
      />
    )
  }
  if (!data.panel) {
    return (
      <EmptyState
        icon={<Info size={28} />}
        title={t('admin.rep_absent_title')}
        description={t('admin.rep_absent_body')}
      />
    )
  }

  return (
    <ReportDocument
      def={def}
      panel={data.panel}
      period={data.period}
      periods={data.periods}
      periodId={data.period.id}
      onPeriod={onPeriod}
      // The host name is a poor name for an instance and a much better one than
      // an empty line at the top of a printed page.
      instance={instanceName ?? window.location.host}
      author={user?.display_name || user?.username || user?.email || '—'}
    />
  )
}
export { OneReport }

function ReportIndex({ navigate }: Pick<AdminSectionProps, 'navigate'>) {
  const { t } = useTranslation()

  const groups: { source: PanelSource; titleKey: string }[] = [
    { source: 'dashboard', titleKey: 'admin.rep_index_dashboard' },
    { source: 'security',  titleKey: 'admin.rep_index_security' },
  ]

  return (
    <div>
      <h1 className="mb-2 text-text-primary" style={{ fontSize: 'var(--kb-text-page)' }}>
        {t('admin.nav_reports')}
      </h1>
      <p className="mb-4 max-w-3xl text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>
        {t('admin.rep_index_intro')}
      </p>

      {groups.map(group => (
        <section key={group.source} className="mb-6">
          <h2 className="mb-2 text-text-primary" style={{ fontSize: 'var(--kb-text-heading)' }}>
            {t(group.titleKey)}
          </h2>
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {panelsOf(group.source).map(def => {
              const href = reportUrl(group.source, def.id)
              return (
                <li key={def.id}>
                  {/* A real anchor: an operator opens a report in a new tab to
                      print it while keeping the console where it was. */}
                  <a
                    href={href}
                    onClick={e => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                      e.preventDefault()
                      navigate(href)
                    }}
                    className="flex h-full items-start gap-2 rounded-xl border border-border bg-surface-0
                               p-3 hover:bg-surface-1"
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2">
                      <def.Icon size={15} className="text-text-secondary" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
                        {t(def.titleKey)}
                      </span>
                      <span className="mt-0.5 block text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                        {t(def.aboutKey)}
                      </span>
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
        <FileText size={13} className="mr-1 inline align-[-2px]" aria-hidden />
        {t('admin.rep_index_note')}
      </p>
    </div>
  )
}
export { ReportIndex }
