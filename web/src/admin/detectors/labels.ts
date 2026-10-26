// Localised names of the closed vocabularies a detector is built from.
//
// The server sends keys (`regex`, `luhn`, `finance`) rather than sentences, for
// the same reason it does everywhere else: an English string travelling through
// an API is an English string in thirteen locales. The keys are enumerable, so
// the console can name them all.

import type { TFunction } from 'i18next'
import type { ChecksumAlgo, DetectorKind } from './api'
// Canonical migration text is used only to recognize untouched factory fields.
import builtinDefaults from './builtinDefaults.json'

type DetectorText = {
  key: string
  label: string
  description: string | null
  is_builtin?: boolean
}

/** Translate only unchanged factory text; administrator edits remain their data. */
function builtinText(t: TFunction, detector: DetectorText, field: 'label' | 'description'): string | null {
  const stored = detector[field]
  const defaults = (builtinDefaults as Record<string, { label: string; description: string }>)[detector.key]
  if (detector.is_builtin === false || !defaults || stored !== defaults[field]) return stored
  return t(`admin.det_builtin_${detector.key.slice('core.'.length)}_${field}`, { defaultValue: defaults[field] })
}

export function detectorLabel(t: TFunction, detector: DetectorText): string {
  return builtinText(t, detector, 'label') ?? detector.label
}

export function detectorDescription(t: TFunction, detector: DetectorText): string | null {
  return builtinText(t, detector, 'description')
}

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
