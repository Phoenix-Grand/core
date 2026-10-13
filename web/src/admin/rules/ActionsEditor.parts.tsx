/**
 * The parts of `ActionsEditor.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { AlertTriangle, Undo2 } from "lucide-react"
import { Badge, Combobox, Input, MenuDropdown, Toggle } from "@ui"
import type { ParamDef } from "./types"
import type { ActionsEditor } from './ActionsEditor'

function ParamControl({ param, value, onChange, disabled }: {
  param:    ParamDef
  value:    unknown
  onChange: (v: unknown) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()

  if (param.type === 'bool') {
    return <Toggle checked={value === true} onChange={() => onChange(value !== true)} disabled={disabled} />
  }
  if (param.type === 'enum') {
    const options = (param.values ?? []).map(v => ({ value: String(v), label: String(v) }))
    return (
      <Combobox
        value={value === undefined || value === null ? null : String(value)}
        onChange={v => onChange(v)}
        options={options}
        placeholder={t('admin.rl_param_default')}
        clearable={!param.required}
        onClear={() => onChange(null)}
        disabled={disabled}
        width={220}
        aria-label={param.label}
      />
    )
  }
  return (
    <Input
      type={param.type === 'number' ? 'number' : 'text'}
      value={value === null || value === undefined ? '' : String(value)}
      onChange={e => onChange(param.type === 'number'
        ? (e.target.value === '' ? null : Number(e.target.value))
        : e.target.value)}
      disabled={disabled}
      className="max-w-md"
      aria-label={param.label}
    />
  )
}
export { ParamControl }

export function Part1({ t }: { t: NonNullable<ActionsEditor['tr']> }) {
  return (
    <Badge variant="success" size="sm"><Undo2 size={11} />{t('admin.rl_action_reversible')}</Badge>
  )
}

export function Part2({ t }: { t: NonNullable<ActionsEditor['tr']> }) {
  return (
    <Badge variant="warning" size="sm"><AlertTriangle size={11} />{t('admin.rl_action_irreversible')}</Badge>
  )
}

export function Part3({ schema, spec, setParam, index, disabled }: { schema: NonNullable<ActionsEditor['rows_value']>[number]['schema']; spec: NonNullable<ActionsEditor['rows_value']>[number]['spec']; setParam: ActionsEditor['setParam']; index: NonNullable<ActionsEditor['rows_value']>[number]['index']; disabled: ActionsEditor['props']['disabled'] }) {
  return (
    <>{schema.map(p => (
                        <div key={p.name} className="flex min-w-0 flex-wrap items-center gap-3">
                          <label className="w-56 shrink-0 text-text-secondary"
                            style={{ fontSize: 'var(--kb-text-meta)' }}>
                            {p.label}
                            {p.required && <span className="ms-1 text-danger" aria-hidden>*</span>}
                          </label>
                          <div className="min-w-0 flex-1">
                            <ParamControl param={p} value={spec.params?.[p.name]}
                              onChange={v => setParam(index, p.name, v)} disabled={disabled} />
                          </div>
                        </div>
                      ))}</>
  )
}

export function Part4({ menu_pos, addItems, menu }: { menu_pos: NonNullable<NonNullable<ActionsEditor['menu']>['pos']>; addItems: NonNullable<ActionsEditor['addItems']>; menu: NonNullable<ActionsEditor['menu']> }) {
  return (
    <MenuDropdown pos={menu_pos} items={addItems} onClose={menu.close} />
  )
}
