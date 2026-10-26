import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { Role } from './types'
import seededText from './seededText.json'

/**
 * Localised wording for the delegated-administration catalogue.
 *
 * ## Why the resolution happens here and not server-side
 *
 * `core.privileges` and `core.roles` store `label` / `name` / `description` as
 * plain text, seeded in French by migrations 000044, 000053 and 000054. Those
 * columns cannot become translation keys: the catalogue is **extensible by
 * modules** - a module declares its privileges at registration and the core
 * prefixes them by force - so the core can never know the whole key space ahead
 * of time. The stored text stays the source of truth.
 *
 * What the core *does* know is its own `core.*` catalogue and its own system
 * roles, both addressed by a stable identifier the API already returns (`key`,
 * `slug`, `domain`). So the translation is looked up **from that identifier, in
 * the browser**, and falls back to the stored column whenever no entry exists -
 * which is exactly the module-declared case.
 *
 * Resolving client-side rather than by `Accept-Language` on the server also
 * means: no second translation pipeline to maintain in Rust, no language in the
 * React Query cache key, and an instant re-render on a language switch instead
 * of a refetch.
 *
 * ## An operator's own wording always wins
 *
 * A system role's `name` and `description` remain editable (only its privilege
 * set is frozen server-side). Compare them with the canonical migration text in
 * `seededText.json`, independent of which locale bundles have been downloaded.
 * A French lookup can fall back to English before French is loaded, making an
 * untouched French name look like an administrator edit. Translation wording
 * can also differ from the seed's punctuation. Neither should affect whether
 * a factory field is translated. Edited or explicitly cleared fields retain
 * the operator's value in every language.
 *
 * The seed snapshot and its English entries are checked against the database
 * migration by regression tests.
 */

/** `core.users.read` → `core_users_read`; `read-only-admin` → `read_only_admin`. */
function flatten(identifier: string): string {
  return identifier.replace(/[.-]/g, '_')
}

export const privilegeLabelKey = (key: string) => `admin.privlbl_${flatten(key)}`
export const privilegeDescKey  = (key: string) => `admin.privdsc_${flatten(key)}`
export const roleNameKey       = (slug: string) => `admin.rolelbl_${flatten(slug)}`
export const roleDescKey       = (slug: string) => `admin.roledsc_${flatten(slug)}`
/** Functional group heading. Domains carry neither dot nor dash. */
export const domainKey         = (domain: string) => `admin.privdom_${domain}`

/**
 * The core's translation when it ships one and the stored text is still the one
 * the core seeded; the stored text otherwise.
 */
function resolve(
  translate: (key: string, fallback: string) => string,
  key: string,
  stored: string | null | undefined,
): string | null {
  const text = stored?.trim() ?? ''
  if (!text) return null
  if (text !== (seededText as Record<string, string>)[key]?.trim()) return text
  return translate(key, text)
}

/** Anything carrying a catalogue key and its stored wording. */
export interface KeyedEntry {
  key:          string
  label:        string
  description?: string | null
}

export interface AuthzLabels {
  /** Privilege (or API-token scope) title. Never empty: falls back to the key. */
  privilegeLabel:       (entry: KeyedEntry) => string
  privilegeDescription: (entry: KeyedEntry) => string | null
  /** System-role name; a custom role is always shown as its author wrote it. */
  roleName:             (role: Role) => string
  roleDescription:      (role: Role) => string | null
  /** Functional group heading, or the raw segment for a module domain. */
  domainLabel:          (domain: string) => string
}

export function createAuthzLabels(t: TFunction): AuthzLabels {
  const translate = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  return {
    privilegeLabel: entry =>
      resolve(translate, privilegeLabelKey(entry.key), entry.label) ?? entry.key,

    privilegeDescription: entry =>
      resolve(translate, privilegeDescKey(entry.key), entry.description),

    roleName: role =>
      (role.is_system ? resolve(translate, roleNameKey(role.slug), role.name) : role.name.trim())
      || role.slug,

    roleDescription: role =>
      role.is_system
        ? resolve(translate, roleDescKey(role.slug), role.description)
        : (role.description?.trim() || null),

    domainLabel: domain => t(domainKey(domain), { defaultValue: domain }),
  }
}

export function useAuthzLabels(): AuthzLabels {
  const { t, i18n: instance } = useTranslation()
  // Rebuilt on every language change so memoised consumers re-render with it.
  return useMemo(() => createAuthzLabels(t), [t, instance.language])
}
