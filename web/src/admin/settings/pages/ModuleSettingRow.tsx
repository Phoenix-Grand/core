/**
 * Code-behind of `ModuleSettingRow.kbcontrol` (converted from `ModuleSettingRow.tsx` by @kubuno/views-migrate).
 */
import { Fragment } from 'react'
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { normOptions, type SettingItem } from "../moduleSettingSchema"

import { ViewBase } from './ModuleSettingRow.kbcontrol'
import * as __parts from './ModuleSettingRow.parts.tsx'
import { RiskPill, Control } from './ModuleSettingRow.parts.tsx'

export interface ModuleSettingRowProps {
  item:     SettingItem
  value:    unknown
  /** Differs from the factory default. */
  modified: boolean
  /** Edited in this session and not saved yet. */
  pending:  boolean
  invalid:  boolean
  /** A level above pinned this value, or the caller may not write here. */
  readOnly?: boolean
  /**
   * Offer "back to the factory value".
   *
   * False on a unit, where it would be a trap: staging the factory value there
   * and saving does not clear the unit's row, it WRITES the factory value into
   * it — the unit stops following its parent while looking as if it had been
   * put back. On a unit the honest action is "hériter", which the panel renders
   * under the provenance sentence instead.
   */
  showFactoryReset?: boolean
  /**
   * The at-a-glance state of the value beside the label — inherited, overridden
   * here, locked. Passed in rather than derived: the row knows the module's
   * declaration, only the panel knows which scope is on screen.
   */
  statusPill?: ReactNode
  /** The provenance sentence under the control, with its revert/lock actions. */
  provenance?: ReactNode
  onChange: (v: unknown) => void
  onReset:  () => void
}

export class ModuleSettingRow extends ViewBase {
  tr!: ModuleSettingRowStores['t']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
  }

  get readOnly() {
    return this.props.readOnly ?? false
  }

  get showFactoryReset() {
    return this.props.showFactoryReset ?? true
  }

  get inline(): boolean {
    return this.props.item.type === 'bool'
  }

  get caption() {
    return this.memo('caption', [this.props, this.tr], () => (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
          {this.props.item.label ?? this.props.item.key}
        </p>
        {this.props.item.risk && <RiskPill risk={this.props.item.risk} />}
        {this.props.statusPill}
        {/* Knowing at a glance what still holds its factory value is what
            makes a long panel auditable. */}
        {this.props.modified && (
          <span className="text-primary" style={{ fontSize: 'var(--kb-text-micro)' }}>
            {this.props.pending
              ? this.tr('admin.m_pending', { defaultValue: 'non enregistré' })
              : this.tr('admin.m_modified', { defaultValue: 'modifié' })}
          </span>
        )}
      </div>
      {this.props.item.description && (
        <p className="mt-1 leading-relaxed text-text-secondary"
          style={{ fontSize: 'var(--kb-text-meta)' }}>{this.props.item.description}</p>
      )}
    </>
  ))
  }

  get trailer() {
    return this.memo('trailer', [this.props, this.readOnly, this.showFactoryReset, this.tr], () => (
    <>
      {this.props.modified && !this.readOnly && this.showFactoryReset && (
        // `block`: the controls it follows are inline-level, so without it the
        // link lands on their line and reads as one of their labels.
        <button
          type="button"
          onClick={this.props.onReset}
          className="mt-1.5 block text-left text-text-tertiary transition-colors hover:text-primary"
          style={{ fontSize: 'var(--kb-text-micro)' }}
        >
          {this.tr('admin.m_reset_default_named', {
            value: this.describeDefault(),
            defaultValue: `Rétablir la valeur par défaut : ${this.describeDefault()}`,
          })}
        </button>
      )}
      {this.props.provenance}
    </>
  ))
  }

  get control() {
    return this.memo('control', [this.props, this.readOnly], () => (
    <Control item={this.props.item} value={this.props.value} invalid={this.props.invalid} readOnly={this.readOnly} onChange={this.props.onChange} />
  ))
  }

  get div_class() {
    return `border-t border-border px-5 py-4 ${this.props.pending ? 'bg-surface-1' : ''}`
  }

  get show_not_inline() {
    return !(this.inline)
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_control() {
    return this.memo('content_control', [this.control, this.inline], () => {
      if (!(this.inline)) return undefined as never
      return ({ children: this.control })
    })
  }

  get content_caption() {
    return this.memo('content_caption', [this.caption, this.inline], () => {
      if (!(this.inline)) return undefined as never
      return ({ children: this.caption })
    })
  }

  get content_trailer() {
    return this.memo('content_trailer', [this.trailer, this.inline], () => {
      if (!(this.inline)) return undefined as never
      return ({ children: this.trailer })
    })
  }

  get content_caption2() {
    return this.memo('content_caption2', [this.caption, this.inline], () => {
      if (!(!(this.inline))) return undefined as never
      return ({ children: this.caption })
    })
  }

  get content_control2() {
    return this.memo('content_control2', [this.control, this.inline], () => {
      if (!(!(this.inline))) return undefined as never
      return ({ children: this.control })
    })
  }

  get content_trailer2() {
    return this.memo('content_trailer2', [this.trailer, this.inline], () => {
      if (!(!(this.inline))) return undefined as never
      return ({ children: this.trailer })
    })
  }

  describeDefault(): string {
    if (this.props.item.type === 'bool') {
      return this.props.item.default
        ? this.tr('common.enabled', { defaultValue: 'activé' })
        : this.tr('common.disabled', { defaultValue: 'désactivé' })
    }
    if (this.props.item.type === 'enum') {
      const opt = normOptions(this.props.item.values).find(o => String(o.value) === String(this.props.item.default))
      if (opt) return opt.label
    }
    const raw = this.props.item.default === null || this.props.item.default === undefined ? '' : String(this.props.item.default)
    return raw.trim() === '' ? this.tr('common.empty', { defaultValue: 'vide' }) : raw
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ModuleSettingRowStores = ReturnType<ModuleSettingRow['useStores']>

export default ModuleSettingRow.component()
