import type { TFunction } from 'i18next'

interface ExportServiceText {
  id: string
  module_id: string
  label: string
  description: string | null
}

/** The account sheet belongs to Core. Other services supply their own copy. */
export function exportServiceLabel(t: TFunction, service: ExportServiceText, context: 'self' | 'admin'): string {
  if (service.id !== 'core' || service.module_id !== 'core') return service.label
  return context === 'self' ? t('settings.mde_core_label') : t('admin.dx_core_label')
}

export function exportServiceDescription(t: TFunction, service: ExportServiceText, context: 'self' | 'admin'): string | null {
  if (service.id !== 'core' || service.module_id !== 'core') return service.description
  return context === 'self' ? t('settings.mde_core_description') : t('admin.dx_core_description')
}

