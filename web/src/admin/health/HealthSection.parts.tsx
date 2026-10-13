/**
 * The parts of `HealthSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { BellOff, MoreVertical, RefreshCw, Undo2 } from "lucide-react"
import { Accordion, Button, MenuDropdown, useMenuDropdown, useToast, type MenuItem } from "@ui"
import { formatWhen } from "../sections/format"
import { checkActionLabel, checkTitle, checkValue, checkWhy, severityLabel, skinOf, statusLabel } from "./labels"
import { useMuteCheck, useRefreshHealthChecks } from "./useHealthChecks"
import { actionHref, isFailing, type HealthCheck } from "./types"
import type { HealthSection } from './HealthSection'

function CheckRow({ check, canManage }: { check: HealthCheck; canManage: boolean }) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const menu = useMenuDropdown()
  const refresh = useRefreshHealthChecks()
  const mute = useMuteCheck()
  const skin = skinOf(check)

  const failing = isFailing(check.status)
  const muted = check.status === 'ignored'

  const setMuted = (next: boolean) => {
    mute.mutate(
      { id: check.id, muted: next },
      {
        onSuccess: () => toast.success(
          next ? t('admin.hc_toast_ignored') : t('admin.hc_toast_restored'),
        ),
        onError: () => toast.error(t('admin.hc_toast_failed')),
      },
    )
  }

  const items: MenuItem[] = [
    {
      type: 'action',
      label: t('admin.hc_menu_recheck'),
      icon: <RefreshCw size={15} />,
      onClick: () => refresh.mutate(undefined, {
        onError: () => toast.error(t('admin.hc_toast_failed')),
      }),
    },
    ...(canManage && check.ignorable
      ? [{
          type: 'action' as const,
          label: muted ? t('admin.hc_menu_restore') : t('admin.hc_menu_ignore'),
          icon: muted ? <Undo2 size={15} /> : <BellOff size={15} />,
          onClick: () => setMuted(!muted),
        }]
      : []),
  ]

  return (
    <li className="border-t border-border px-4 py-3 first:border-t-0">
      {/* Mobile stacks: pill + title, then value, then the action. From `sm`
          the action moves opposite the text. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${skin.dot}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-text-primary">{checkTitle(t, check)}</span>
                <span
                  className={`rounded-full px-1.5 py-0.5 ${skin.chip}`}
                  style={{ fontSize: 'var(--kb-text-micro)' }}
                >
                  {failing ? severityLabel(t, check.severity) : statusLabel(t, check.status)}
                </span>
              </div>
              <p className="mt-0.5 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {checkValue(t, check, i18n.language)}
              </p>
              <p
                className="mt-1 max-w-prose leading-relaxed text-text-tertiary"
                style={{ fontSize: 'var(--kb-text-meta)' }}
              >
                {checkWhy(t, check)}
              </p>
              {muted && check.muted && (
                <p className="mt-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                  {t('admin.hc_muted_by', {
                    who: check.muted.by_label ?? t('admin.hc_muted_unknown'),
                    when: formatWhen(check.muted.at, i18n.language),
                  })}
                </p>
              )}
              {check.doc_href && (
                <a
                  href={check.doc_href}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block rounded-sm text-primary underline-offset-2 hover:underline
                             focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  style={{ fontSize: 'var(--kb-text-meta)' }}
                >
                  {t('admin.hc_doc')}
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 self-start ps-4 sm:ps-0">
          {check.action && failing && (
            <Link to={actionHref(check.action)}>
              <Button variant="secondary" size="sm">{checkActionLabel(t, check)}</Button>
            </Link>
          )}
          <button
            type="button"
            aria-label={t('admin.hc_menu_label')}
            onClick={menu.open}
            className="rounded-md p-1.5 text-text-secondary transition-colors
                       hover:bg-surface-2 hover:text-text-primary
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <MoreVertical size={16} />
          </button>
          {menu.pos && <MenuDropdown items={items} pos={menu.pos} onClose={menu.close} minWidth={200} />}
        </div>
      </div>
    </li>
  )
}
export { CheckRow }

export function Part1({ items, open, defaultOpen, setOpen }: { items: NonNullable<HealthSection['items']>; open: HealthSection['open']; defaultOpen: NonNullable<HealthSection['defaultOpen']>; setOpen: NonNullable<HealthSection['setOpen']> }) {
  return (
    <Accordion
            items={items}
            open={open ?? defaultOpen}
            onOpenChange={setOpen}
          />
  )
}
