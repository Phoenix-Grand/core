// Turning a rule back into a sentence.
//
// The table shows "14 juillet", "Pâques + 39 jours", "dernier lundi de mai" —
// not `{"month":5,"weekday":1,"nth":-1}`. This is the whole reason the
// referential stores rules rather than dates: a rule can be *read*, and an
// administrator who cannot read it cannot judge whether it is right.
//
// Nothing here computes a date. The dates come from the server, which owns the
// one expander; this file only names the rule.

import type { TFunction } from 'i18next'
import type { Observance, RuleKind, RuleParams } from './api'

/** Month names in the console's language, from the platform's own data. */
export function monthName(locale: string, month: number): string {
  // Day 15 rather than 1: no time zone shift can push mid-month into another one.
  const date = new Date(Date.UTC(2026, Math.max(0, Math.min(11, month - 1)), 15))
  return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(date)
}

/** Weekday names, ISO-numbered (Monday = 1) like the rule itself. */
export function weekdayName(locale: string, weekday: number): string {
  // 5 January 2026 is a Monday, so +n lands on ISO weekday n.
  const date = new Date(Date.UTC(2026, 0, 4 + Math.max(1, Math.min(7, weekday))))
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(date)
}

/** A date the server returned, written the way the reader writes dates. */
export function formatDate(locale: string, iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)))
}

/**
 * "de mai", "d'octobre", "of May".
 *
 * The elision is French and lives here rather than in the translation, because
 * no interpolation can decide it: it depends on the first letter of the value
 * being interpolated. Other languages fall through untouched.
 */
function ofMonth(t: TFunction, locale: string, month: string): string {
  const raw = t('admin.hol_of_month', { month })
  return locale.startsWith('fr') ? raw.replace(/\bde ([aeiouâàéèêîôûh])/i, "d'$1") : raw
}

/**
 * The rule, in one line.
 *
 * `dates` is the honest case: there is no sentence for "the Islamic new year",
 * only the list the dataset computed, so the line says how many dates are known
 * and over which years — which is exactly the limit a reader needs to see.
 */
export function ruleText(
  t: TFunction,
  locale: string,
  kind: RuleKind,
  rule: RuleParams,
): string {
  switch (kind) {
    case 'fixed':
      return t('admin.hol_rule_fixed', {
        day: rule.day ?? 1,
        month: monthName(locale, rule.month ?? 1),
      })
    case 'easter': {
      const offset = rule.offset ?? 0
      const easter = rule.basis === 'julian'
        ? t('admin.hol_easter_orthodox')
        : t('admin.hol_easter')
      if (offset === 0) return easter
      return offset > 0
        ? t('admin.hol_rule_easter_after',  { easter, count: offset })
        : t('admin.hol_rule_easter_before', { easter, count: -offset })
    }
    case 'nth_weekday': {
      const weekday = weekdayName(locale, rule.weekday ?? 1)
      const month   = ofMonth(t, locale, monthName(locale, rule.month ?? 1))
      const rank    = t(`admin.hol_rank_${rule.nth === -1 ? 'last' : (rule.nth ?? 1)}`)
      // "1er lundi de mai" / "1st Monday of May" — the rank comes from the same
      // labels the editor's dropdown shows, so the table and the form agree.
      return t('admin.hol_rule_nth_weekday', { rank, weekday, month })
    }
    case 'dates': {
      const dates = rule.dates ?? []
      if (dates.length === 0) return t('admin.hol_rule_dates_empty')
      const years = dates.map(d => Number(d.slice(0, 4))).filter(Number.isFinite)
      return t('admin.hol_rule_dates', {
        count: dates.length,
        from: Math.min(...years),
        to: Math.max(...years),
      })
    }
    default:
      return kind
  }
}

/** The weekend shift, in the same register — empty when the day never moves. */
export function observanceText(t: TFunction, observance: Observance): string {
  return observance === 'none' ? '' : t(`admin.hol_obs_${observance}`)
}
