/**
 * Code-behind of `ModuleDatabaseCard.kbcontrol` (converted from `ModuleDatabaseCard.tsx` by @kubuno/views-migrate).
 */
import { bind, type ValueChangedEventArgs, type MouseEventArgs } from '@kubuno/views'
import { Fragment } from 'react'
import { useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Database, Check } from "lucide-react"
import { Button, Callout, OutlinedField, useToast } from "@ui"
import { api } from "../../core/api/client"
import { usePrivileges } from "../../core/authz/usePrivileges"
import KnownConnectionsCard from "../database/KnownConnectionsCard"

import { ViewBase } from './ModuleDatabaseCard.kbcontrol'
import * as __parts from './ModuleDatabaseCard.parts.tsx'

const PRIMARY = 'var(--color-primary)'

type EngineName = 'postgres' | 'mysql' | 'sqlite'

interface OverrideView {
  engine: EngineName
  host: string
  port: number | null
  user: string
  has_password: boolean
  database: string
  path: string
  schema_prefix: string | null
  enabled: boolean
}

interface MainView {
  engine: string
  host: string
  port: number | null
  user: string
  database: string
  path: string
  has_password: boolean
}

interface DbConfigResponse {
  module_id: string
  inherited_engine: string
  engines: EngineName[]
  override: OverrideView | null
  main: MainView | null
}

interface DbTest {
  ok: boolean
  error?: string
  server_version?: string
  database_missing: boolean
  can_create_database: boolean
  already_initialised: boolean
}

type Mode = 'inherit' | EngineName

const DEFAULT_PORT: Record<EngineName, string> = {
  postgres: '5432',
  mysql: '3306',
  sqlite: '',
}

function engineLabel(t: (k: string) => string, e: EngineName): string {
  return t(`admin.mdb_engine_${e}`)
}

export type ModuleDatabaseCardProps = { moduleId: string }

export class ModuleDatabaseCard extends ViewBase {
  @bind accessor mode: Mode = 'inherit'
  @bind accessor host = ''
  @bind accessor port = ''
  @bind accessor user = ''
  @bind accessor password = ''
  @bind accessor passwordTouched = false
  @bind accessor database = ''
  @bind accessor path = ''
  @bind accessor prefix = ''
  @bind accessor test: DbTest | null = null
  @bind accessor migrateResult: { ok: boolean; text: string } | null = null
  tr!: ModuleDatabaseCardStores['t']
  isSuperuser!: boolean
  toast!: ModuleDatabaseCardStores['toast']
  qc!: ModuleDatabaseCardStores['qc']
  cfg!: ModuleDatabaseCardHooks['cfg']
  testMut!: ModuleDatabaseCardHooks['testMut']
  saveMut!: ModuleDatabaseCardHooks['saveMut']
  migrateMut!: ModuleDatabaseCardHooks['migrateMut']
  revertMut!: ModuleDatabaseCardHooks['revertMut']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { isSuperuser } = usePrivileges()
    const toast = useToast()
    const qc = useQueryClient()
    return { t, isSuperuser, toast, qc }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const isSuperuser = this.isSuperuser
    const toast = this.toast
    const qc = this.qc
    const cfg = useQuery({
      queryKey: ['module-database', this.props.moduleId],
      queryFn: () => api.get<DbConfigResponse>(`/admin/modules/${this.props.moduleId}/database`).then(r => r.data),
      enabled: isSuperuser,
      staleTime: 30_000,
    })
    this.publish({ cfg })
    const ov = this.ov
    useEffect(() => {
      if (!cfg.data) return
      if (ov && ov.enabled) {
        this.mode = ov.engine
        this.host = ov.host
        this.port = ov.port != null ? String(ov.port) : ''
        this.user = ov.user
        this.database = ov.database
        this.path = ov.path
        this.prefix = ov.schema_prefix ?? ''
      } else {
        this.mode = 'inherit'
      }
      this.password = ''
      this.passwordTouched = false
      this.test = null
    }, [cfg.data])
    const engine = this.engine
    const body = useMemo(() => {
      if (!engine) return null
      const b: Record<string, unknown> = {
        engine,
        host: this.host.trim(),
        port: this.port.trim() ? Number(this.port.trim()) : null,
        user: this.user.trim(),
        database: this.database.trim(),
        path: this.path.trim(),
        schema_prefix: this.prefix.trim() || null,
        enabled: true,
      }
      // Only send a password when the operator typed one; otherwise the stored one
      // is kept server-side.
      if (this.passwordTouched) b.password = this.password
      return b
    }, [engine, this.host, this.port, this.user, this.database, this.path, this.prefix, this.password, this.passwordTouched])
    const testMut = useMutation({
      mutationFn: () => api.post<DbTest>(`/admin/modules/${this.props.moduleId}/database/test`, body).then(r => r.data),
      onSuccess: (data) => this.test = data,
      onError: () => toast.error(t('admin.mdb_test_failed')),
    })
    this.publish({ testMut })
    const saveMut = useMutation({
      mutationFn: () => api.put(`/admin/modules/${this.props.moduleId}/database`, body).then(r => r.data),
      onSuccess: () => {
        toast.success(t('admin.mdb_saved'))
        void qc.invalidateQueries({ queryKey: ['module-database', this.props.moduleId] })
      },
      onError: (e: unknown) => {
        const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
        toast.error(msg || t('admin.mdb_save_failed'))
      },
    })
    this.publish({ saveMut })
    const migrateMut = useMutation({
      mutationFn: () => api.post<{ job: { status: string; tables_total: number; total_rows: number; error: string } }>(
        `/admin/modules/${this.props.moduleId}/database/migrate`, body).then(r => r.data),
      onSuccess: (data) => {
        const j = data.job
        this.migrateResult = j.status === 'succeeded'
          ? { ok: true, text: t('admin.mdb_copy_ok', { tables: j.tables_total, rows: j.total_rows }) }
          : { ok: false, text: j.error || t('admin.mdb_copy_failed') }
        void qc.invalidateQueries({ queryKey: ['module-database', this.props.moduleId] })
      },
      onError: (e: unknown) => {
        const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
        this.migrateResult = { ok: false, text: msg || t('admin.mdb_copy_failed') }
      },
    })
    this.publish({ migrateMut })
    const revertMut = useMutation({
      mutationFn: () => api.delete(`/admin/modules/${this.props.moduleId}/database`).then(r => r.data),
      onSuccess: () => {
        toast.success(t('admin.mdb_reverted'))
        void qc.invalidateQueries({ queryKey: ['module-database', this.props.moduleId] })
      },
      onError: () => toast.error(t('admin.mdb_save_failed')),
    })
    this.publish({ revertMut })
    return { cfg, body, testMut, saveMut, migrateMut, revertMut }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, isSuperuser: s.isSuperuser, toast: s.toast, qc: s.qc })
    const h = this.useHooks()
    this.publish({ cfg: h.cfg, testMut: h.testMut, saveMut: h.saveMut, migrateMut: h.migrateMut, revertMut: h.revertMut })
  }

  get ov(): OverrideView | null {
    return this.memo('ov', [this.cfg], () => this.cfg.data?.override ?? null)
  }

  get engine(): EngineName | null {
    return this.mode === 'inherit' ? null : this.mode
  }

  get inheritedEngine(): string {
    if (!(!(!this.isSuperuser))) return undefined as never
    return this.cfg.data?.inherited_engine ?? 'postgres'
  }

  get engines(): EngineName[] {
    return this.memo('engines', [this.cfg, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return this.cfg.data?.engines ?? ['postgres', 'mysql', 'sqlite']
    })
  }

  get hasOverride(): boolean {
    if (!(!(!this.isSuperuser))) return undefined as never
    return !!(this.ov && this.ov.enabled)
  }

  get main(): MainView | null {
    return this.memo('main', [this.cfg, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return this.cfg.data?.main ?? null
    })
  }

  get busy(): boolean {
    if (!(!(!this.isSuperuser))) return undefined as never
    return this.testMut.isPending || this.saveMut.isPending || this.revertMut.isPending || this.migrateMut.isPending
  }

  get fields() {
    return this.memo('fields', [this.engine, this.tr, this.host, this.test, this.memo, this.port, this.database, this.props, this.user, this.hasOverride, this.passwordTouched, this.password, this.path, this.prefix, this.migrateResult, this.isSuperuser, this.testMut, this.saveMut, this.migrateMut, this.revertMut], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      const testMut = this.testMut
      const saveMut = this.saveMut
      const migrateMut = this.migrateMut
      const busy = testMut.isPending || saveMut.isPending || this.revertMut.isPending || migrateMut.isPending
      return this.engine && (
    <div className="mt-4 flex flex-col gap-4">
      {this.engine !== 'sqlite' && (
        <>
          <div className="flex gap-3">
            <div className="flex-1">
              <OutlinedField label={this.tr('admin.mdb_host')} value={this.host} onChange={this.onEdit(this.memo("setHost:bound", [], () => this.setHost.bind(this)))}
                icon={<Database size={20} strokeWidth={1.8} />} primaryColor={PRIMARY} />
            </div>
            <div style={{ width: 120 }}>
              <OutlinedField label={this.tr('admin.mdb_port')} value={this.port} onChange={this.onEdit(this.memo("setPort:bound", [], () => this.setPort.bind(this)))}
                placeholder={DEFAULT_PORT[this.engine]} inputMode="numeric" primaryColor={PRIMARY} />
            </div>
          </div>
          {this.engine === 'postgres' && (
            <OutlinedField label={this.tr('admin.mdb_database')} value={this.database} onChange={this.onEdit(this.memo("setDatabase:bound", [], () => this.setDatabase.bind(this)))}
              primaryColor={PRIMARY} />
          )}
          {this.engine === 'mysql' && (
            <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              {this.tr('admin.mdb_mysql_db_hint', { schema: this.props.moduleId })}
            </p>
          )}
          <OutlinedField label={this.tr('admin.mdb_user')} value={this.user} onChange={this.onEdit(this.memo("setUser:bound", [], () => this.setUser.bind(this)))} primaryColor={PRIMARY} />
          <OutlinedField
            label={this.hasOverride && !this.passwordTouched ? this.tr('admin.mdb_password_kept') : this.tr('admin.mdb_password')}
            value={this.password}
            onChange={(v) => { this.password = v; this.passwordTouched = true; this.test = null }}
            type="password" autoComplete="off" primaryColor={PRIMARY} />
        </>
      )}
      {this.engine === 'sqlite' && (
        <div>
          <OutlinedField label={this.tr('admin.mdb_sqlite_path')} value={this.path} onChange={this.onEdit(this.memo("setPath:bound", [], () => this.setPath.bind(this)))}
            placeholder="/var/lib/kubuno/db" primaryColor={PRIMARY} />
          <p className="mt-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {this.tr('admin.mdb_sqlite_hint', { schema: this.props.moduleId })}
          </p>
        </div>
      )}
      <div>
        <OutlinedField label={this.tr('admin.mdb_schema_prefix')} value={this.prefix} onChange={this.onEdit(this.memo("setPrefix:bound", [], () => this.setPrefix.bind(this)))}
          primaryColor={PRIMARY} />
        <p className="mt-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {this.tr('admin.mdb_schema_prefix_hint')}
        </p>
      </div>

      {/* Test result */}
      {this.test?.ok && (
        <Callout variant={this.test.already_initialised ? 'warning' : 'success'}>
          <span className="inline-flex items-center gap-1.5">
            <Check size={15} />
            {this.test.server_version
              ? this.tr('admin.mdb_connected_version', { version: this.test.server_version })
              : this.tr('admin.mdb_connected')}
          </span>
          {this.test.already_initialised && <div className="mt-1">{this.tr('admin.mdb_already_initialised')}</div>}
        </Callout>
      )}
      {this.test && !this.test.ok && this.test.database_missing && (
        <Callout variant={this.test.can_create_database ? 'info' : 'warning'}>
          {this.test.can_create_database ? this.tr('admin.mdb_missing_creatable') : this.tr('admin.mdb_missing_not_creatable')}
        </Callout>
      )}
      {this.test && !this.test.ok && !this.test.database_missing && (
        <Callout variant="danger" title={this.tr('admin.mdb_test_error')}>
          {this.test.error}
        </Callout>
      )}

      {this.migrateResult && (
        <Callout variant={this.migrateResult.ok ? 'success' : 'danger'}>{this.migrateResult.text}</Callout>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={() => testMut.mutate()} loading={testMut.isPending} disabled={busy}>
          {this.tr('admin.mdb_test')}
        </Button>
        <Button variant="primary" size="sm" onClick={() => saveMut.mutate()} loading={saveMut.isPending} disabled={busy}>
          {this.tr('admin.mdb_save')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => migrateMut.mutate()} loading={migrateMut.isPending} disabled={busy}>
          {this.tr('admin.mdb_copy')}
        </Button>
      </div>
      <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
        {this.tr('admin.mdb_copy_hint')}
      </p>
    </div>
  )
    })
  }

  get show_case_1() {
    return !!(!this.isSuperuser)
  }

  get show_main() {
    return !(!this.isSuperuser)
  }

  get show_not_cfg_is_loading() {
    if (!(!(!this.isSuperuser))) return undefined as never
    return !(this.cfg.isLoading)
  }

  get show_not_cfg_is_error() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading))) return undefined as never
    return !(this.cfg.isError)
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.isSuperuser, this.cfg], () => {
      if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(this.cfg.isError)) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Callout> icon: a value the property converts (null-when-false)). */
  get Part1() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(this.cfg.isError)) return undefined as never
    return __parts.Part1
  }

  get selected_value() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
    return this.mode === 'inherit'
  }

  get mdb_inherit_engine() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
    return engineLabel(this.tr, this.inheritedEngine as EngineName)
  }

  /** The rows of the Repeater over `engines`. */
  get rows_engines() {
    return this.memo('rows_engines', [this.engines, this.isSuperuser, this.cfg, this.mode, this.tr], () => {
      if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
      return this.engines.map((e) => {
      return { e, selected_value: ((!(!this.isSuperuser)) && (!(this.cfg.isLoading)) && (!(this.cfg.isError))) ? (this.mode === e) : undefined, text: ((!(!this.isSuperuser)) && (!(this.cfg.isLoading)) && (!(this.cfg.isError))) ? (engineLabel(this.tr, e)) : undefined, key: e }
    })
    })
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_fields() {
    return this.memo('content_fields', [this.fields, this.isSuperuser, this.cfg], () => {
      if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
      return ({ children: this.fields })
    })
  }

  get show_mode_inherit_has_override() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
    return this.mode === 'inherit' && this.hasOverride
  }

  get enabled_unless_busy() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError)) || !(this.mode === 'inherit' && this.hasOverride)) return undefined as never
    return !(this.busy)
  }

  get visible() {
    return this.memo('visible', [this.show_mode_inherit_has_override, this.show_not_cfg_is_error, this.isSuperuser, this.cfg], () => {
      if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading))) return undefined as never
      return this.show_mode_inherit_has_override && this.show_not_cfg_is_error
    })
  }

  get visible2() {
    return this.memo('visible2', [this.cfg, this.show_not_cfg_is_loading, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return this.cfg.isError && this.show_not_cfg_is_loading
    })
  }

  get visible3() {
    return this.memo('visible3', [this.show_not_cfg_is_error, this.show_not_cfg_is_loading, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return this.show_not_cfg_is_error && this.show_not_cfg_is_loading
    })
  }

  get visible4() {
    return this.memo('visible4', [this.visible, this.show_not_cfg_is_loading, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return this.visible && this.show_not_cfg_is_loading
    })
  }

  /** `<KnownConnectionsCard>`, rendered by a ReactHost. */
  get KnownConnectionsCard() {
    if (!(!(!this.isSuperuser))) return undefined as never
    return KnownConnectionsCard
  }

  get known_connections_card_props() {
    return this.memo('known_connections_card_props', [this.props, this.tr, this.qc, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return ({ basePath: `/admin/modules/${this.props.moduleId}/database`, queryKey: ['module', this.props.moduleId], embedded: true, heading: this.tr('admin.dbconn_title'), onChanged: () => void this.qc.invalidateQueries({ queryKey: ['module-database', this.props.moduleId] }) } as React.ComponentProps<typeof KnownConnectionsCard>)
    })
  }

  onEdit<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); this.test = null }
  }

  pickEngine(e: EngineName) {
    if (!(!(!this.isSuperuser))) return undefined as never
    if (!this.hasOverride && this.mode === 'inherit' && this.main) {
      this.host = this.main.host || ''
      this.user = this.main.user || ''
      this.database = this.main.database || ''
      this.path = this.main.path || ''
      this.port = e === this.main.engine && this.main.port != null ? String(this.main.port) : ''
    }
    this.mode = e
    this.test = null
  }

  radio_button_checked_changed(_sender: unknown, _args: ValueChangedEventArgs) {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
 this.mode = 'inherit'; this.test = null }

  radio_button_checked_changed2(_sender: unknown, args: ValueChangedEventArgs) {
    const { e } = args.row as RowOf_rows_engines
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
    this.pickEngine(e)
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError)) || !(this.mode === 'inherit' && this.hasOverride)) return undefined as never
    this.revertMut.mutate()
  }

  /** `setHost` of the TSX: a value, or an update of the previous one. */
  setHost(value: ModuleDatabaseCard['host'] | ((prev: ModuleDatabaseCard['host']) => ModuleDatabaseCard['host'])) {
    this.host = typeof value === 'function' ? (value as (prev: ModuleDatabaseCard['host']) => ModuleDatabaseCard['host'])(this.host) : value
  }

  /** `setPort` of the TSX: a value, or an update of the previous one. */
  setPort(value: ModuleDatabaseCard['port'] | ((prev: ModuleDatabaseCard['port']) => ModuleDatabaseCard['port'])) {
    this.port = typeof value === 'function' ? (value as (prev: ModuleDatabaseCard['port']) => ModuleDatabaseCard['port'])(this.port) : value
  }

  /** `setDatabase` of the TSX: a value, or an update of the previous one. */
  setDatabase(value: ModuleDatabaseCard['database'] | ((prev: ModuleDatabaseCard['database']) => ModuleDatabaseCard['database'])) {
    this.database = typeof value === 'function' ? (value as (prev: ModuleDatabaseCard['database']) => ModuleDatabaseCard['database'])(this.database) : value
  }

  /** `setUser` of the TSX: a value, or an update of the previous one. */
  setUser(value: ModuleDatabaseCard['user'] | ((prev: ModuleDatabaseCard['user']) => ModuleDatabaseCard['user'])) {
    this.user = typeof value === 'function' ? (value as (prev: ModuleDatabaseCard['user']) => ModuleDatabaseCard['user'])(this.user) : value
  }

  /** `setPath` of the TSX: a value, or an update of the previous one. */
  setPath(value: ModuleDatabaseCard['path'] | ((prev: ModuleDatabaseCard['path']) => ModuleDatabaseCard['path'])) {
    this.path = typeof value === 'function' ? (value as (prev: ModuleDatabaseCard['path']) => ModuleDatabaseCard['path'])(this.path) : value
  }

  /** `setPrefix` of the TSX: a value, or an update of the previous one. */
  setPrefix(value: ModuleDatabaseCard['prefix'] | ((prev: ModuleDatabaseCard['prefix']) => ModuleDatabaseCard['prefix'])) {
    this.prefix = typeof value === 'function' ? (value as (prev: ModuleDatabaseCard['prefix']) => ModuleDatabaseCard['prefix'])(this.prefix) : value
  }

}

type RowOf_rows_engines = ModuleDatabaseCard['rows_engines'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type ModuleDatabaseCardStores = ReturnType<ModuleDatabaseCard['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ModuleDatabaseCardHooks = ReturnType<ModuleDatabaseCard['useHooks']>

export default ModuleDatabaseCard.component()
