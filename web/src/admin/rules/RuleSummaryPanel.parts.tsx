/**
 * The parts of `RuleSummaryPanel.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { FlaskConical } from "lucide-react"
import { Callout } from "@ui"
import type { RuleSummaryPanel } from './RuleSummaryPanel'

export function Part1({ t }: { t: NonNullable<RuleSummaryPanel['tr']> }) {
  return (
    <Callout variant="info" icon={<FlaskConical size={16} />} title={t('admin.rl_sim_banner_title')}>
                  {t('admin.rl_sim_banner_body')}
                </Callout>
  )
}
