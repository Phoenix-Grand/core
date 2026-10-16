import type { TFunction } from 'i18next'
import type { LucideIcon } from 'lucide-react'
import { getIcon } from '../utils/iconMap'
import type { ActiveModule } from '../types'
import type { WidgetDef, WidgetSize } from './WidgetRegistry'

export interface WidgetPresentation {
  title:       string
  description: string
  Icon:        LucideIcon
  accent?:     string
}

/** "photos-recent" → "Recent" (kebab/snake → Title Case). */
function humanize(s: string): string {
  return s.replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase())
}

/** A module's display label + sidebar icon, resolved dynamically (no hard-coded
 *  per-module knowledge - respects module independence). */
function moduleInfo(moduleId: string, modules: ActiveModule[]): { label: string; icon: string } {
  const m = modules.find(mod => mod.module_id === moduleId)
  const item = m?.sidebar_items?.[0]
  return { label: item?.label || humanize(moduleId), icon: item?.icon || 'Box' }
}

/**
 * Resolve how a widget is shown in the catalog / add gallery. Core widgets carry
 * explicit metadata; module widgets are described dynamically from the running
 * module (its sidebar label + icon), so the core never hard-codes module names.
 */
export function resolveWidgetPresentation(
  w: WidgetDef,
  modules: ActiveModule[],
  t: TFunction,
): WidgetPresentation {
  if (w.title) {
    return {
      title:       t(w.title),
      description: w.description ? t(w.description) : '',
      Icon:        getIcon(w.icon ?? 'Box'),
      accent:      w.accent,
    }
  }
  const mi = moduleInfo(w.moduleId, modules)
  const suffix = w.id.startsWith(`${w.moduleId}-`) ? w.id.slice(w.moduleId.length + 1) : w.id
  return {
    title:       mi.label,
    description: humanize(suffix),
    Icon:        getIcon(w.icon ?? mi.icon),
    accent:      w.accent,
  }
}

/** Human-friendly size label for the catalog card chip. */
export function widgetSizeLabel(size: WidgetSize | undefined, t: TFunction): string {
  if (size === 'large')  return t('home.size_large')
  if (size === 'medium') return t('home.size_medium')
  return t('home.size_small')
}
