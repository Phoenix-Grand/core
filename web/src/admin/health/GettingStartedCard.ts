/**
 * Code-behind of `GettingStartedCard.kbcontrol` (converted from `GettingStartedCard.tsx` by @kubuno/views-migrate).
 */
import { type MouseEventArgs } from '@kubuno/views'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from "react-i18next"
import { openTasks, useHealthChecks } from "./useHealthChecks"
import { type HealthCheck } from "./types"
import { adminUrl } from "../adminAction"

import { ViewBase } from './GettingStartedCard.kbcontrol'
import * as __parts from './GettingStartedCard.parts'

const MAX_TASKS = 4

export class GettingStartedCard extends ViewBase {
  tr!: GettingStartedCardStores['t']
  data!: GettingStartedCardStores['data']
  isLoading!: boolean
  isError!: boolean
  navigate!: ReturnType<typeof useNavigate>

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { data, isLoading, isError } = useHealthChecks()
    return { t, data, isLoading, isError }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, data: s.data, isLoading: s.isLoading, isError: s.isError })
    this.navigate = useNavigate()
  }

  get tasks(): HealthCheck[] {
    return this.memo('tasks', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading || this.isError || !this.data))) return undefined as never
      return openTasks(this.data.checks)
    })
  }

  get settled(): number {
    if (!(!(this.isLoading || this.isError || !this.data))) return undefined as never
    return this.data.counts.ok
  }

  get scoreable(): number {
    if (!(!(this.isLoading || this.isError || !this.data))) return undefined as never
    return this.data.counts.ok + this.data.counts.todo + this.data.counts.blocked
  }

  get shown(): HealthCheck[] {
    return this.memo('shown', [this.tasks, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading || this.isError || !this.data)) || !(!(this.tasks.length === 0))) return undefined as never
      return this.tasks.slice(0, MAX_TASKS)
    })
  }

  get show_case_1() {
    return !!(this.isLoading || this.isError || !this.data)
  }

  get show_case_2() {
    return !(this.isLoading || this.isError || !this.data) && !!(this.tasks.length === 0)
  }

  get href() {
    if (!(!(this.isLoading || this.isError || !this.data)) || !(this.tasks.length === 0)) return undefined as never
    return adminUrl({ tab: 'security-health' })
  }

  get show_main() {
    return !(this.isLoading || this.isError || !this.data) && !(this.tasks.length === 0)
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.tasks, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading || this.isError || !this.data)) || !(!(this.tasks.length === 0))) return undefined as never
      return ({ t: this.tr, tasks: this.tasks })
    })
  }

  /** A part of the screen still written in React (<Link style>). */
  get Part1() {
    if (!(!(this.isLoading || this.isError || !this.data)) || !(!(this.tasks.length === 0))) return undefined as never
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.settled, this.scoreable, this.tr, this.isLoading, this.isError, this.data, this.tasks], () => {
      if (!(!(this.isLoading || this.isError || !this.data)) || !(!(this.tasks.length === 0))) return undefined as never
      return ({ settled: this.settled, scoreable: this.scoreable, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<ProgressBar> formatValue: no .kbview property). */
  get Part2() {
    if (!(!(this.isLoading || this.isError || !this.data)) || !(!(this.tasks.length === 0))) return undefined as never
    return __parts.Part2
  }

  /** `<TaskRow>`, rendered by a ReactHost. */
  get TaskRow() {
    if (!(!(this.isLoading || this.isError || !this.data)) || !(!(this.tasks.length === 0))) return undefined as never
    return __parts.TaskRow
  }

  /** The rows of the Repeater over `shown`. */
  get rows_shown() {
    return this.memo('rows_shown', [this.shown, this.isLoading, this.isError, this.data, this.tasks], () => {
      if (!(!(this.isLoading || this.isError || !this.data)) || !(!(this.tasks.length === 0))) return undefined as never
      return this.shown.map((c) => {
      return { c, task_row_props: ((!(this.isLoading || this.isError || !this.data)) && (!(this.tasks.length === 0))) ? ({ check: c }) : undefined, key: c.id }
    })
    })
  }

  link_label_click(_sender: unknown, _args: MouseEventArgs) {
    this.navigate(adminUrl({ tab: 'security-health' }))
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type GettingStartedCardStores = ReturnType<GettingStartedCard['useStores']>

export default GettingStartedCard.component()
