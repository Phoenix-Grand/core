/**
 * The parts of `GettingStartedCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { Button, ProgressBar } from "@ui"
import { checkActionLabel, checkTitle, checkValue, checkWhy, skinOf } from "./labels"
import { actionHref, type HealthCheck } from "./types"
import { adminUrl } from "../adminAction"
import type { GettingStartedCard } from './GettingStartedCard'

function TaskRow({ check }: { check: HealthCheck }) {
  const { t, i18n } = useTranslation()
  const [showWhy, setShowWhy] = useState(false)
  const skin = skinOf(check)

  return (
    <li className="border-t border-border py-3 first:border-t-0 first:pt-0">
      {/* Mobile puts the action under the text; from `sm` it sits opposite. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${skin.dot}`} aria-hidden />
            <div className="min-w-0">
              <p className="text-text-primary">{checkTitle(t, check)}</p>
              <p className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {checkValue(t, check, i18n.language)}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-expanded={showWhy}
            onClick={() => setShowWhy(v => !v)}
            className="ml-4 mt-1 rounded-sm text-primary underline-offset-2 hover:underline
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            style={{ fontSize: 'var(--kb-text-meta)' }}
          >
            {t('admin.hc_why')}
          </button>
          {showWhy && (
            <p
              className="ml-4 mt-1 max-w-prose leading-relaxed text-text-secondary"
              style={{ fontSize: 'var(--kb-text-meta)' }}
            >
              {checkWhy(t, check)}
            </p>
          )}
        </div>

        {check.action && (
          <Link to={actionHref(check.action)} className="shrink-0 self-start">
            {/* `secondary`, never bold: the card is a to-do list, and four
                primary buttons in a column would each claim to be the one. */}
            <Button variant="secondary" size="sm">{checkActionLabel(t, check)}</Button>
          </Link>
        )}
      </div>
    </li>
  )
}
export { TaskRow }

export function Part1({ t, tasks }: { t: NonNullable<GettingStartedCard['tr']>; tasks: NonNullable<GettingStartedCard['tasks']> }) {
  return (
    <Link
              to={adminUrl({ tab: 'security-health' })}
              className="inline-flex items-center gap-1.5 rounded-sm text-primary underline-offset-2
                         hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              style={{ fontSize: 'var(--kb-text-body)' }}
            >
              {t('admin.hc_see_all', { n: tasks.length })}
              <ArrowRight size={14} aria-hidden />
            </Link>
  )
}

export function Part2({ settled, scoreable, t }: { settled: NonNullable<GettingStartedCard['settled']>; scoreable: NonNullable<GettingStartedCard['scoreable']>; t: NonNullable<GettingStartedCard['tr']> }) {
  return (
    <ProgressBar
            className="mb-3"
            value={settled}
            max={Math.max(scoreable, 1)}
            variant="primary"
            showValue
            label={t('admin.hc_progress')}
            formatValue={() => t('admin.hc_progress_value', { done: settled, total: scoreable })}
          />
  )
}
