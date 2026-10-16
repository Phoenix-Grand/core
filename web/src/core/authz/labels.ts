import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import type { Role } from './types'

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
 * set is frozen server-side). The French entries in `i18n/locales/fr/core.json`
 * are byte-identical to the migration seed, so "the stored value still equals
 * the French string" is precisely "nobody has rewritten it" - and a rewritten
 * role keeps the operator's wording, in every language. Should the two ever
 * drift apart, the fallback is the stored French label: what this screen showed
 * before any of this existed, never a raw key and never a blank.
 *
 * Which is why the French strings must be edited in step with the migrations,
 * not "improved" on their own.
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

/** The seeded French string for a key, or '' when the core does not ship one. */
function seededValue(key: string): string {
  return i18n.getFixedT('fr')(key, { defaultValue: '' }).trim()
}

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
  if (!i18n.exists(key)) return text || null
  if (text && text !== seededValue(key)) return text
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

export function useAuthzLabels(): AuthzLabels {
  const { t, i18n: instance } = useTranslation()

  // Rebuilt on every language change so memoised consumers re-render with it.
  return useMemo<AuthzLabels>(() => {
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
    // `instance.language` is the dependency that matters here: `t` is stable for
    // a given language, and every consumer memoises on these functions.
  }, [t, instance.language])
}
