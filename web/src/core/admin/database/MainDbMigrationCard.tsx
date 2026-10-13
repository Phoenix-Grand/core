/**
 * Code-behind of `MainDbMigrationCard.kbcontrol` (converted from `MainDbMigrationCard.tsx` by @kubuno/views-migrate).
 */
import { bind, type ValueChangedEventArgs } from '@kubuno/views'
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Database } from "lucide-react"
import { OutlinedField, useToast } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { api } from "../../api/client"
import { apiErrorMessage } from "../../api/errorMessage"
import { useConfirm } from "../../hooks/useConfirm"
import { usePrivileges } from "../../authz/usePrivileges"

import { ViewBase } from './MainDbMigrationCard.kbcontrol'
import * as __parts from './MainDbMigrationCard.parts'

const PRIMARY = 'var(--color-primary)'

type Engine = 'postgres' | 'mysql' | 'sqlite'

const ENGINES: Engine[] = ['postgres', 'mysql', 'sqlite']

const DEFAULT_PORT: Record<Engine, string> = { postgres: '5432', mysql: '3306', sqlite: '' }

interface Cur {
  engine: string
  host: string
  port: number | null
  user: string
  database: string
  path: string
  has_password: boolean
}

interface Job {
  status: string
  target_engine: string
  tables_total: number
  total_rows: number
  error: string
}

export class MainDbMigrationCard extends ViewBase {
  @bind accessor engine: Engine = 'postgres'
  @bind accessor host = ''
  @bind accessor port = ''
  @bind accessor user = ''
  @bind accessor password = ''
  @bind accessor database = ''
  @bind accessor path = ''
  @bind accessor error: string | null = null
  @bind accessor job: Job | null = null
  tr!: MainDbMigrationCardStores['t']
  isSuperuser!: boolean
  toast!: MainDbMigrationCardStores['toast']
  confirm!: MainDbMigrationCardStores['confirm']
  confirmState!: MainDbMigrationCardStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  seeded!: MainDbMigrationCardStores['seeded']
  data!: MainDbMigrationCardStores['data']
  migrate!: MainDbMigrationCardHooks['migrate']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { isSuperuser } = usePrivileges()
    const toast = useToast()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const seeded = useRef(false)
    const { data } = useQuery<{ current?: Cur | null }>({
      queryKey: ['admin', 'database', 'schema-prefix'],
      queryFn: () => api.get('/admin/database/schema-prefix').then(r => r.data),
      enabled: isSuperuser,
    })
    return { t, isSuperuser, toast, confirm, confirmState, handleConfirm, handleCancel, seeded, data }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const toast = this.toast
    const seeded = this.seeded
    const data = this.data
    useEffect(() => {
      const c = data?.current
      if (!c || seeded.current) return
      seeded.current = true
      if (ENGINES.includes(c.engine as Engine)) this.engine = c.engine as Engine
      if (c.host) this.host = c.host
      if (c.port != null) this.port = String(c.port)
      if (c.user) this.user = c.user
      if (c.database) this.database = c.database
      if (c.path) this.path = c.path
    }, [data])
    const migrate = useMutation({
      mutationFn: () => api.post<{ job: Job }>('/admin/database/migrate', this.body()).then(r => r.data),
      onSuccess: (data) => { this.error = null; this.job = data.job; toast.success(t('admin.dbmig_done')) },
      onError: (e: unknown) => { this.job = null; this.error = apiErrorMessage(e, t('admin.dbmig_failed')) },
    })
    this.publish({ migrate })
    return { migrate }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, isSuperuser: s.isSuperuser, toast: s.toast, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, seeded: s.seeded, data: s.data })
    const h = this.useHooks()
    this.publish({ migrate: h.migrate })
  }

  get cur(): Cur | null | undefined {
    return this.memo('cur', [this.data, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return this.data?.current
    })
  }

  get show_case_1() {
    return !!(!this.isSuperuser)
  }

  get show_main() {
    return !(!this.isSuperuser)
  }

  get p_text() {
    if (!(!(!this.isSuperuser))) return undefined as never
    return this.cur
              ? this.tr('admin.db_current_state', {
                  engine: this.tr(`admin.mdb_engine_${this.cur.engine}`, this.cur.engine),
                  target: this.cur.engine === 'sqlite'
                    ? (this.cur.path || '/var/lib/kubuno/db')
                    : [this.cur.port ? `${this.cur.host}:${this.cur.port}` : this.cur.host, this.cur.database].filter(Boolean).join('/'),
                })
              : this.tr('admin.db_current_unknown')
  }

  get knownConnectionsQueryKey() {
    if (!(!(!this.isSuperuser))) return undefined as never
    return ['core']
  }

  get knownConnectionsHeading() {
    if (!(!(!this.isSuperuser))) return undefined as never
    return this.tr('admin.dbconn_title')
  }

  /** The rows of the Repeater over `ENGINES`. */
  get rows_engines() {
    return this.memo('rows_engines', [this.isSuperuser, this.engine, this.tr], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return ENGINES.map((e) => {
      return { e, selected_value: ((!(!this.isSuperuser))) ? (this.engine === e) : undefined, text: ((!(!this.isSuperuser))) ? (this.tr(`admin.mdb_engine_${e}`)) : undefined, key: e }
    })
    })
  }

  get show_engine_sqlite() {
    if (!(!(!this.isSuperuser))) return undefined as never
    return this.engine !== 'sqlite'
  }

  /** `<OutlinedField>`, rendered by a ReactHost. */
  get OutlinedField() {
    if (!(!(!this.isSuperuser)) || !(this.engine !== 'sqlite')) return undefined as never
    return OutlinedField
  }

  get outlined_field_props() {
    return this.memo('outlined_field_props', [this.tr, this.host, this.memo, this.isSuperuser, this.engine], () => {
      if (!(!(!this.isSuperuser)) || !(this.engine !== 'sqlite')) return undefined as never
      return ({ label: this.tr('admin.mdb_host'), value: this.host, onChange: this.memo("setHost:bound", [], () => this.setHost.bind(this)), icon: <Database size={20} strokeWidth={1.8} />, primaryColor: PRIMARY })
    })
  }

  get outlined_field_props2() {
    return this.memo('outlined_field_props2', [this.tr, this.port, this.memo, this.engine, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser)) || !(this.engine !== 'sqlite')) return undefined as never
      return ({ label: this.tr('admin.mdb_port'), value: this.port, onChange: this.memo("setPort:bound", [], () => this.setPort.bind(this)), placeholder: DEFAULT_PORT[this.engine], inputMode: "numeric", primaryColor: PRIMARY })
    })
  }

  get outlined_field_props3() {
    return this.memo('outlined_field_props3', [this.tr, this.database, this.memo, this.isSuperuser, this.engine], () => {
      if (!(!(!this.isSuperuser)) || !(this.engine !== 'sqlite')) return undefined as never
      return ({ label: this.tr('admin.mdb_database'), value: this.database, onChange: this.memo("setDatabase:bound", [], () => this.setDatabase.bind(this)), primaryColor: PRIMARY })
    })
  }

  get outlined_field_props4() {
    return this.memo('outlined_field_props4', [this.tr, this.user, this.memo, this.isSuperuser, this.engine], () => {
      if (!(!(!this.isSuperuser)) || !(this.engine !== 'sqlite')) return undefined as never
      return ({ label: this.tr('admin.mdb_user'), value: this.user, onChange: this.memo("setUser:bound", [], () => this.setUser.bind(this)), primaryColor: PRIMARY })
    })
  }

  get outlined_field_props5() {
    return this.memo('outlined_field_props5', [this.tr, this.password, this.memo, this.isSuperuser, this.engine], () => {
      if (!(!(!this.isSuperuser)) || !(this.engine !== 'sqlite')) return undefined as never
      return ({ label: this.tr('admin.mdb_password'), value: this.password, onChange: this.memo("setPassword:bound", [], () => this.setPassword.bind(this)), type: "password", autoComplete: "off", primaryColor: PRIMARY })
    })
  }

  get show_engine_sqlite2() {
    if (!(!(!this.isSuperuser))) return undefined as never
    return this.engine === 'sqlite'
  }

  /** `<OutlinedField>`, rendered by a ReactHost. */
  get OutlinedField2() {
    if (!(!(!this.isSuperuser)) || !(this.engine === 'sqlite')) return undefined as never
    return OutlinedField
  }

  get outlined_field_props6() {
    return this.memo('outlined_field_props6', [this.tr, this.path, this.memo, this.isSuperuser, this.engine], () => {
      if (!(!(!this.isSuperuser)) || !(this.engine === 'sqlite')) return undefined as never
      return ({ label: this.tr('admin.mdb_sqlite_path'), value: this.path, onChange: this.memo("setPath:bound", [], () => this.setPath.bind(this)), placeholder: "/var/lib/kubuno/db", primaryColor: PRIMARY })
    })
  }

  get show_error() {
    if (!(!(!this.isSuperuser))) return undefined as never
    return !!(this.error)
  }

  get show_job_job_status() {
    if (!(!(!this.isSuperuser))) return undefined as never
    return !!(this.job && this.job.status === 'succeeded')
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.job, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser)) || !(this.job && this.job.status === 'succeeded')) return undefined as never
      return ({ t: this.tr, job: this.job })
    })
  }

  /** A part of the screen still written in React (<Callout> with element children). */
  get Part1() {
    if (!(!(!this.isSuperuser)) || !(this.job && this.job.status === 'succeeded')) return undefined as never
    return __parts.Part1
  }

  get show_job_job_status2() {
    if (!(!(!this.isSuperuser))) return undefined as never
    return !!(this.job && this.job.status === 'failed')
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.job, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser)) || !(this.job && this.job.status === 'failed')) return undefined as never
      return ({ t: this.tr, job: this.job })
    })
  }

  /** A part of the screen still written in React (<Callout> icon: a value the property converts (null-when-false)). */
  get Part2() {
    if (!(!(!this.isSuperuser)) || !(this.job && this.job.status === 'failed')) return undefined as never
    return __parts.Part2
  }

  get enabled_unless_migrate_is_pending() {
    if (!(!(!this.isSuperuser))) return undefined as never
    return !(this.migrate.isPending)
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(!this.isSuperuser)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  body() {
    return ({
    engine: this.engine,
    host: this.host.trim(),
    port: this.port.trim() ? Number(this.port.trim()) : null,
    user: this.user.trim(),
    password: this.password,
    database: this.database.trim(),
    path: this.path.trim() || null,
  })
  }

  async onMigrate() {
    if (!(!(!this.isSuperuser))) return undefined as never
    const ok = await this.confirm({
      title: this.tr('admin.dbmig_confirm_title'),
      message: this.tr('admin.dbmig_confirm_body', { engine: this.engine }),
      confirmLabel: this.tr('admin.dbmig_confirm_ok'),
      variant: 'danger',
    })
    if (ok) this.migrate.mutate()
  }

  radio_button_checked_changed(_sender: unknown, args: ValueChangedEventArgs) {
    const { e } = args.row as RowOf_rows_engines
    if (!(!(!this.isSuperuser))) return undefined as never
 this.engine = e; this.error = null }

  /** `setHost` of the TSX: a value, or an update of the previous one. */
  setHost(value: MainDbMigrationCard['host'] | ((prev: MainDbMigrationCard['host']) => MainDbMigrationCard['host'])) {
    this.host = typeof value === 'function' ? (value as (prev: MainDbMigrationCard['host']) => MainDbMigrationCard['host'])(this.host) : value
  }

  /** `setPort` of the TSX: a value, or an update of the previous one. */
  setPort(value: MainDbMigrationCard['port'] | ((prev: MainDbMigrationCard['port']) => MainDbMigrationCard['port'])) {
    this.port = typeof value === 'function' ? (value as (prev: MainDbMigrationCard['port']) => MainDbMigrationCard['port'])(this.port) : value
  }

  /** `setDatabase` of the TSX: a value, or an update of the previous one. */
  setDatabase(value: MainDbMigrationCard['database'] | ((prev: MainDbMigrationCard['database']) => MainDbMigrationCard['database'])) {
    this.database = typeof value === 'function' ? (value as (prev: MainDbMigrationCard['database']) => MainDbMigrationCard['database'])(this.database) : value
  }

  /** `setUser` of the TSX: a value, or an update of the previous one. */
  setUser(value: MainDbMigrationCard['user'] | ((prev: MainDbMigrationCard['user']) => MainDbMigrationCard['user'])) {
    this.user = typeof value === 'function' ? (value as (prev: MainDbMigrationCard['user']) => MainDbMigrationCard['user'])(this.user) : value
  }

  /** `setPassword` of the TSX: a value, or an update of the previous one. */
  setPassword(value: MainDbMigrationCard['password'] | ((prev: MainDbMigrationCard['password']) => MainDbMigrationCard['password'])) {
    this.password = typeof value === 'function' ? (value as (prev: MainDbMigrationCard['password']) => MainDbMigrationCard['password'])(this.password) : value
  }

  /** `setPath` of the TSX: a value, or an update of the previous one. */
  setPath(value: MainDbMigrationCard['path'] | ((prev: MainDbMigrationCard['path']) => MainDbMigrationCard['path'])) {
    this.path = typeof value === 'function' ? (value as (prev: MainDbMigrationCard['path']) => MainDbMigrationCard['path'])(this.path) : value
  }

}

type RowOf_rows_engines = MainDbMigrationCard['rows_engines'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type MainDbMigrationCardStores = ReturnType<MainDbMigrationCard['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type MainDbMigrationCardHooks = ReturnType<MainDbMigrationCard['useHooks']>

export default MainDbMigrationCard.component()
