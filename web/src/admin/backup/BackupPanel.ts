/**
 * Code-behind of `BackupPanel.kbview` (converted from `BackupPanel.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs } from '@kubuno/views'
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useToast } from "@ui"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { useAdminAction } from "../adminAction"
import { errorMessage, useBackup, useRunBackup } from "./api"

import { ViewBase } from './BackupPanel.kbview'
import * as __parts from './BackupPanel.parts'

export class BackupPanel extends ViewBase {
  tr!: BackupPanelStores['t']
  toast!: BackupPanelStores['toast']
  can!: BackupPanelStores['can']
  data!: BackupPanelStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: BackupPanelStores['refetch']
  run!: BackupPanelStores['run']
  anchor!: BackupPanelStores['anchor']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const toast = useToast()
    const { can } = usePrivileges()
    const { data, isLoading, isError, refetch } = useBackup()
    const run = useRunBackup()
    const anchor = useRef<HTMLDivElement>(null)
    useAdminAction('configure-backup', () => {
      anchor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    const wasRunning = useRef(false)
    useEffect(() => {
      if (!data) return
      if (wasRunning.current && !data.running) {
        if (data.stats.last_status === 'failed') {
          toast.error(t('admin.bk_run_done_failed'))
        } else {
          toast.success(t('admin.bk_run_done_ok'))
        }
      }
      wasRunning.current = data.running
    }, [data, toast, t])
    return { t, toast, can, data, isLoading, isError, refetch, run, anchor, wasRunning }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    useAdminAction('run-backup', () => { if (this.canManage) this.trigger() })
    return {  }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, toast: s.toast, can: s.can, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch, run: s.run, anchor: s.anchor })
    this.useHooks()
  }

  get canRead(): boolean {
    return this.can(PRIV.BACKUP_READ)
  }

  get canManage(): boolean {
    return this.can(PRIV.BACKUP_MANAGE)
  }

  get show_case_1() {
    return !!(!this.canRead)
  }

  get show_case_2() {
    return !(!this.canRead) && !!(this.isLoading)
  }

  get show_case_3() {
    return !(!this.canRead) && !(this.isLoading) && !!(this.isError || !this.data)
  }

  get show_main() {
    return !(!this.canRead) && !(this.isLoading) && !(this.isError || !this.data)
  }

  get part1_props() {
    return this.memo('part1_props', [this.anchor, this.tr, this.canManage, this.run, this.data, this.memo, this.toast, this.isLoading, this.canRead, this.isError], () => {
      if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ anchor: this.anchor, t: this.tr, canManage: this.canManage, run: this.run, data: this.data, trigger: this.memo("trigger:bound", [], () => this.trigger.bind(this)), isLoading: this.isLoading })
    })
  }

  /** A part of the screen still written in React (<div ref>: attribute(s) without a .kbview property). */
  get Part1() {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.Part1
  }

  trigger() {
    this.run.mutate(undefined, {
      onSuccess: () => this.toast.success(this.tr('admin.bk_run_queued')),
      onError:   e => this.toast.error(errorMessage(e, this.tr('admin.bk_run_failed'))),
    })
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(this.isError || !this.data)) return undefined as never
    void this.refetch()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type BackupPanelStores = ReturnType<BackupPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type BackupPanelHooks = ReturnType<BackupPanel['useHooks']>

export default BackupPanel.component()
