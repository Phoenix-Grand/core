/**
 * Label marks shown on a labelled drive entry: the label glyph tinted with the
 * label colour, and NOTHING else - no names (they would eat the row; the
 * tooltip carries them). Fed through a context rather than a prop so the
 * themeable card/row components keep their signatures.
 */
import { createContext, useContext } from 'react'
import { LabelIcon } from '@ui'
import type { CoreLabel } from '../core/api/labels'
import type { LabelsOf } from './useDriveLabels'

const NONE: CoreLabel[] = []

/** Default: no labels - so an explorer that never provides one renders nothing. */
export const DriveLabelsCtx = createContext<LabelsOf>(() => NONE)

/** Beyond this, marks are replaced by a "+N" counter rather than wrapping. */
const MAX = 3

export function LabelDots({ kind, id, size = 10, className = '' }: {
  kind:       'file' | 'folder'
  id:         string
  size?:      number
  className?: string
}) {
  const labels = useContext(DriveLabelsCtx)(kind, id)
  if (!labels.length) return null
  return (
    <span
      className={`flex items-center gap-0.5 shrink-0 ${className}`}
      title={labels.map(l => l.name).join(' · ')}
    >
      {labels.slice(0, MAX).map(l => (
        <LabelIcon key={l.id} size={size} style={{ color: l.color }} />
      ))}
      {labels.length > MAX && (
        <span className="text-[10px] leading-none text-text-tertiary">+{labels.length - MAX}</span>
      )}
    </span>
  )
}
