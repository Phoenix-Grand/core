// The at-a-glance marker beside a setting's label: does this value belong to
// the scope on screen, or is it following a level above?
//
// The full sentence lives under the control (`ProvenanceLine`); this is the
// glance. Both are needed and they are not redundant: an operator scanning a
// folded page of thirty settings for "what did we change for this unit" reads
// pills, and only then reads the sentence of the one row that answered.
//
// ── Colour discipline ────────────────────────────────────────────────────────
// Tinted surface plus an accent GLYPH, never accent-coloured text on the card's
// own background: at 10px, `--color-warning` on white is roughly 2:1, the
// contrast failure `@ui/Callout` and `ProvenanceLine` both document.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CornerDownRight, Lock, Pencil, Users } from 'lucide-react'
import type { ResolvedSetting } from '../scopeTypes'
import { scopeLabel } from '../controls/ProvenanceLine'
import { inheritanceOf } from '../moduleScope'

function Pill({ tone, icon, children, title }: {
  tone:     'neutral' | 'primary' | 'warning'
  icon:     ReactNode
  children: ReactNode
  title?:   string
}) {
  const skin = {
    neutral: 'bg-surface-2 text-text-secondary',
    primary: 'bg-primary-light text-primary',
    warning: 'bg-warning-light text-text-primary',
  }[tone]
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${skin}`}
      style={{ fontSize: 'var(--kb-text-micro)' }}
    >
      {icon}
      {children}
    </span>
  )
}

export interface ScopeStatusPillProps {
  /** Resolved state of the setting at the scope on screen. */
  resolved?: ResolvedSetting
  /** The page is showing an organisational unit rather than the whole instance. */
  scoped:    boolean
  /**
   * The module declared this setting instance-wide: it has no per-unit meaning,
   * and the row is read-only while a unit is selected.
   */
  instanceOnly: boolean
}

export default function ScopeStatusPill({ resolved, scoped, instanceOnly }: ScopeStatusPillProps) {
  const { t } = useTranslation()

  // Said at BOTH levels, not only where the control is disabled: on a module
  // that mixes the two, an operator reading the instance page has no other way
  // to tell a knob a unit will be able to move from one it never will — and
  // finds out by selecting a unit and meeting a greyed control.
  if (instanceOnly) {
    return (
      <Pill
        tone="neutral"
        icon={<Lock size={10} className="shrink-0" />}
        title={t('admin.m_instance_only_hint', {
          defaultValue: "Ce réglage vaut pour toute l'instance et ne varie pas par unité.",
        })}
      >
        {t('admin.m_instance_only', { defaultValue: "Toute l'instance" })}
      </Pill>
    )
  }

  const state = inheritanceOf(resolved)

  // At instance level there is nothing above to inherit from, so the useful
  // marker is the opposite one: which units below have stopped following.
  if (!scoped) {
    const count = resolved?.overrides.length ?? 0
    if (count === 0) return null
    return (
      <Pill
        tone="neutral"
        icon={<Users size={10} className="shrink-0" />}
        title={t('admin.m_overridden_below_hint', {
          count,
          defaultValue: `${count} portée(s) remplacent ce réglage et ne suivront pas cette valeur.`,
        })}
      >
        {t('admin.m_overridden_below', { count, defaultValue: `${count} remplacement(s)` })}
      </Pill>
    )
  }

  if (state === 'locked') {
    return (
      <Pill
        tone="warning"
        icon={<Lock size={10} className="shrink-0 text-warning" />}
        title={t('admin.prov_locked', {
          scope: scopeLabel(t, resolved?.lock_source?.scope_type, resolved?.lock_source?.scope_name),
          defaultValue: 'Verrouillé par un niveau supérieur',
        })}
      >
        {t('admin.m_pill_locked', { defaultValue: 'Verrouillé' })}
      </Pill>
    )
  }

  if (state === 'own') {
    return (
      <Pill tone="primary" icon={<Pencil size={10} className="shrink-0" />}>
        {t('admin.m_pill_overridden', { defaultValue: 'Remplacé' })}
      </Pill>
    )
  }

  return (
    <Pill
      tone="neutral"
      icon={<CornerDownRight size={10} className="shrink-0" />}
      title={t('admin.prov_inherited', {
        scope: scopeLabel(t, resolved?.source?.scope_type, resolved?.source?.scope_name),
        defaultValue: 'Valeur héritée',
      })}
    >
      {t('admin.m_pill_inherited', { defaultValue: 'Hérité' })}
    </Pill>
  )
}
