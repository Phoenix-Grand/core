// Labels and skins of the rules console.
//
// The five modes are the whole point of this screen, so their presentation is
// centralised: a mode is never rendered as its wire string, and the badge colour
// is a promise about what the rule is allowed to do — simulation must never look
// like enforcement, and enforcement must never look ordinary.

import type { TFunction } from 'i18next'
import type { ExecutionMode, Mode, Outcome, Severity } from './types'

export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'neutral'

/** What each mode actually does, verbatim from `rules::model::Mode`. */
export interface ModeFacts {
  evaluates: boolean
  logs:      boolean
  acts:      boolean
  alerts:    'none' | 'isolated' | 'real'
}

export const MODE_FACTS: Record<Mode, ModeFacts> = {
  inactive: { evaluates: false, logs: false, acts: false, alerts: 'none' },
  simulate: { evaluates: true,  logs: true,  acts: false, alerts: 'isolated' },
  monitor:  { evaluates: true,  logs: true,  acts: false, alerts: 'real' },
  enforce:  { evaluates: true,  logs: true,  acts: true,  alerts: 'real' },
}

/** Display order in the picker: from harmless to consequential, never reordered. */
export const MODE_ORDER: Mode[] = ['inactive', 'simulate', 'monitor', 'enforce']

export function modeLabel(t: TFunction, mode: string): string {
  return t(`admin.rl_mode_${mode}`, { defaultValue: mode })
}

export function modeVariant(mode: string): BadgeVariant {
  switch (mode) {
    case 'enforce':  return 'danger'
    case 'monitor':  return 'warning'
    case 'simulate': return 'primary'
    case 'backtest': return 'neutral'
    default:         return 'default'
  }
}

/** Does this mode run the rule's actions? Exactly one does. */
export function modeActs(mode: string): boolean {
  return mode === 'enforce'
}

export function outcomeLabel(t: TFunction, outcome: string): string {
  return t(`admin.rl_outcome_${outcome}`, { defaultValue: outcome })
}

export function outcomeVariant(outcome: Outcome | string): BadgeVariant {
  switch (outcome) {
    case 'acted':          return 'danger'
    case 'matched':        return 'warning'
    case 'error':          return 'danger'
    case 'depth_exceeded': return 'danger'
    case 'no_match':       return 'default'
    default:               return 'default'
  }
}

export function severityLabel(t: TFunction, severity: string): string {
  return t(`admin.rl_sev_${severity}`, { defaultValue: severity })
}

export function severityVariant(severity: string): BadgeVariant {
  switch (severity) {
    case 'critical': return 'danger'
    case 'warning':  return 'warning'
    default:         return 'primary'
  }
}

export const SEVERITIES: Severity[] = ['critical', 'warning', 'info']

/** Verdict of one action inside an execution row (`dispatch::ActionVerdict`). */
export function actionStatusLabel(t: TFunction, status: string): string {
  return t(`admin.rl_astatus_${status}`, { defaultValue: status })
}

export function actionStatusVariant(status: string): BadgeVariant {
  if (status === 'ok' || status === 'done' || status === 'success') return 'success'
  if (status.startsWith('skipped')) return 'default'
  return 'danger'
}

/** Human duration of a threshold window. */
export function windowLabel(t: TFunction, seconds: number): string {
  if (seconds % 86400 === 0) return t('admin.rl_win_days', { n: seconds / 86400 })
  if (seconds % 3600 === 0)  return t('admin.rl_win_hours', { n: seconds / 3600 })
  if (seconds % 60 === 0)    return t('admin.rl_win_minutes', { n: seconds / 60 })
  return t('admin.rl_win_seconds', { n: seconds })
}

/** A simulated run must be legible as such at a glance in a dense table. */
export function isSimulated(mode: ExecutionMode | string): boolean {
  return mode === 'simulate' || mode === 'backtest'
}
