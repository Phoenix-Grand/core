/**
 * Code-behind of `QuotaField.kbcontrol` (converted from `QuotaField.tsx` by @kubuno/views-migrate).
 */
import { useMemo } from "react"

import { ViewBase } from './QuotaField.kbcontrol'
import * as __parts from './QuotaField.parts'

const UNITS = [
  { id: 'MiB', label: 'Mo', factor: 1024 ** 2 },
  { id: 'GiB', label: 'Go', factor: 1024 ** 3 },
  { id: 'TiB', label: 'To', factor: 1024 ** 4 },
] as const

export type QuotaUnit = (typeof UNITS)[number]['id']

export function splitQuota(bytes: number): { amount: string; unit: QuotaUnit } {
  for (const u of [...UNITS].reverse()) {
    if (bytes >= u.factor) {
      const v = bytes / u.factor
      // One decimal only when it carries information: "1,5 To", never "50,0 Go".
      return { amount: Number.isInteger(v) ? String(v) : v.toFixed(1), unit: u.id }
    }
  }
  return { amount: String(Math.max(1, Math.round(bytes / UNITS[0].factor))), unit: 'MiB' }
}

export function toBytes(amount: string, unit: QuotaUnit): number | null {
  const n = Number(amount.replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  const factor = UNITS.find(u => u.id === unit)?.factor ?? UNITS[1].factor
  return Math.round(n * factor)
}

export type QuotaFieldProps = {
  amount:   string
  unit:     QuotaUnit
  onAmount: (v: string) => void
  onUnit:   (u: QuotaUnit) => void
  label:    string
  hint?:    string
  error?:   string
  autoFocus?: boolean
}

export class QuotaField extends ViewBase {
  bytes!: number | null

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const bytes = useMemo(() => toBytes(this.props.amount, this.props.unit), [this.props.amount, this.props.unit])
    this.publish({ bytes })
    return { bytes }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const h = this.useHooks()
    this.publish({ bytes: h.bytes })
  }

  get part1_props() {
    return this.memo('part1_props', [this.props], () => ({ label: this.props.label, amount: this.props.amount, autoFocus: this.props.autoFocus, onAmount: this.props.onAmount, error: this.props.error }))
  }

  /** A part of the screen still written in React (<TextField> inputMode, autoFocus: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  /** A part of the screen still written in React (<button aria-pressed>: attribute(s) without a .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  /** The rows of the Repeater over `UNITS`. */
  get rows_units() {
    return this.memo('rows_units', [this.props], () => UNITS.map((u) => {
      return { u, part2_props: { u: u, unit: this.props.unit, onUnit: this.props.onUnit }, key: u.id }
    }))
  }

  get show_hint_bytes() {
    return !!(this.props.hint || this.bytes != null)
  }

  get text() {
    if (!((this.props.hint || this.bytes != null))) return undefined as never
    return this.props.hint && this.bytes != null ? ' · ' : ''
  }

  get show_bytes() {
    if (!((this.props.hint || this.bytes != null))) return undefined as never
    return this.bytes != null
  }

  get span_text() {
    return this.memo('span_text', [this.bytes, this.props], () => {
      if (!((this.props.hint || this.bytes != null)) || !(this.bytes != null)) return undefined as never
      return String(this.bytes.toLocaleString()) + " o"
    })
  }

}

/** What `useHooks()` gives (the types of the fields it fills). */
export type QuotaFieldHooks = ReturnType<QuotaField['useHooks']>

export default QuotaField.component()
