// Localised names of the closed vocabularies a detector is built from.
//
// The server sends keys (`regex`, `luhn`, `finance`) rather than sentences, for
// the same reason it does everywhere else: an English string travelling through
// an API is an English string in thirteen locales. The keys are enumerable, so
// the console can name them all.

import type { TFunction } from 'i18next'
import type { ChecksumAlgo, DetectorKind } from './api'

export function kindLabel(t: TFunction, kind: DetectorKind): string {
  return t(`admin.det_kind_${kind}`)
}

export function checksumLabel(t: TFunction, algo: ChecksumAlgo | null): string {
  return algo ? t(`admin.det_sum_${algo}`) : t('admin.det_sum_none')
}

/** Categories the seeded catalogue uses. Anything else falls back to its key. */
const KNOWN_CATEGORIES = ['identity', 'finance', 'contact', 'technical', 'secret', 'other']

export function categoryLabel(t: TFunction, category: string): string {
  return KNOWN_CATEGORIES.includes(category)
    ? t(`admin.det_cat_${category}`)
    : category
}

export function categoryOrder(category: string): number {
  const index = KNOWN_CATEGORIES.indexOf(category)
  return index < 0 ? KNOWN_CATEGORIES.length : index
}

/** A confidence as a percentage, which is how everybody reads 0.85. */
export function asPercent(value: number): string {
  return `${Math.round(value * 100)} %`
}
