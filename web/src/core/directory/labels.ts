import type { TFunction } from 'i18next'
import builtin from './builtinText.json'

type GroupText = { name?: string; description?: string | null; is_system?: boolean }
type AudienceText = { name: string; description?: string | null; is_everyone: boolean }

/** Only product defaults are translated. Custom/cleared fields remain data.
 * Canonical seed text is independent of the lazily loaded French bundle.
 * Group UUIDs vary between installations, so use the system flag and exact
 * factory wording; neither editable names nor UUIDs are translation keys.
 */
function groupText(t: TFunction, group: GroupText, field: 'name' | 'description'): string | null {
  const stored = group[field] ?? null
  if (!group.is_system || !stored) return stored
  const match = Object.entries(builtin.groups).find(([, text]) => text[field] === stored)
  return match ? t(`admin.group_builtin_${match[0]}_${field}`, { defaultValue: stored }) : stored
}

export const groupName = (t: TFunction, group: GroupText): string => groupText(t, group, 'name') ?? ''
export const groupDescription = (t: TFunction, group: GroupText): string | null => groupText(t, group, 'description')

function audienceText(t: TFunction, audience: AudienceText, field: 'name' | 'description'): string | null {
  const stored = audience[field] ?? null
  return audience.is_everyone && stored === builtin.everyone[field]
    ? t(`admin.audience_builtin_everyone_${field}`, { defaultValue: stored })
    : stored
}

export const audienceName = (t: TFunction, audience: AudienceText): string => audienceText(t, audience, 'name') ?? ''
export const audienceDescription = (t: TFunction, audience: AudienceText): string | null => audienceText(t, audience, 'description')
