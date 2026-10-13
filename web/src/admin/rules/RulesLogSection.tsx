import type { AdminSectionProps } from "../sections/registry"
import ExecutionsPanel from "./ExecutionsPanel"

/** The run log as its own place, so it is findable rather than buried. */
export function RulesLogSection({ params }: AdminSectionProps) {
  return <ExecutionsPanel ruleId={params.get('rule')} />
}
