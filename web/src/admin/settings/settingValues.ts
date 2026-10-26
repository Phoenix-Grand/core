import type { TFunction } from 'i18next'
import type { ResolvedSetting, ScopeType } from './scopeTypes'

/** Translate product copy only while it is inherited from the factory.
 * Instance/unit overrides and drafts are administrator content, even when
 * their text happens to match the original French default.
 */
export function settingDisplayValue(t: TFunction, key: string, value: unknown, source?: ScopeType): unknown {
  if (source === 'default' && key === 'instance.description' &&
      (value === 'Mon cloud personnel' || value === 'My personal cloud')) {
    return t('admin.setvalue_instance_description')
  }
  return value
}

export function settingControlValue(t: TFunction, setting: ResolvedSetting, edits: Record<string, unknown>): unknown {
  return setting.key in edits
    ? edits[setting.key]
    : settingDisplayValue(t, setting.key, setting.value, setting.source?.scope_type)
}
