/**
 * @mention provider registry.
 *
 * A module (contacts, mail…) contributes a source of mention candidates by
 * registering a `MentionProvider` at the `'mentions.provider'` extension point.
 * Any mention-aware field (`Input`/`Textarea`/`RichText` with `mentions`) then
 * discovers those providers DYNAMICALLY - with no provider registered, mentions
 * are simply inert (silent degradation), per the polyrepo « never assume a
 * module is installed » rule.
 *
 * The contract types (`MentionItem`, `MentionProvider`) live in `@ui` so the
 * primitives can use them without importing the host; they are re-exported here
 * so a module sees the SAME types from `@kubuno/sdk`.
 */
import { api } from '../api/client'
import { signedUrl } from '../api/signedUrl'
import { ExtensionRegistry } from './ExtensionRegistry'
import { setMentionProviderSource } from '@ui'
import type { MentionProvider } from '@ui'

export type { MentionItem, MentionProvider } from '@ui'

/** The extension point string modules register their provider at. */
export const MENTIONS_PROVIDER_POINT = 'mentions.provider'

/** Register (or replace) a module's mention provider. */
export function registerMentionProvider(moduleId: string, provider: MentionProvider): void {
  ExtensionRegistry.register(MENTIONS_PROVIDER_POINT, moduleId, provider)
}

/** Remove a module's mention provider. */
export function unregisterMentionProvider(moduleId: string): void {
  ExtensionRegistry.unregister(MENTIONS_PROVIDER_POINT, moduleId)
}

/** Every registered mention provider (insertion order). */
export function getMentionProviders(): MentionProvider[] {
  return ExtensionRegistry.getAll<MentionProvider>(MENTIONS_PROVIDER_POINT)
}

/**
 * Bridge the `@ui` default-provider resolver to this registry. Called once at
 * host bootstrap (main.tsx) so that a mention-aware field given no explicit
 * `providers` discovers whatever modules registered here.
 */
export function installDefaultMentionSource(): void {
  setMentionProviderSource(() => getMentionProviders().map(withSignedAvatars))
}

/**
 * A provider whose candidates' `avatarUrl` is ready for an `<img>`: a module's
 * avatar route (contacts…) is authenticated and an image cannot send the
 * Authorization header, so it gets a signed ticket. The `@ui` list stays free of
 * any host dependency; public URLs (core avatars, external) pass through.
 */
function withSignedAvatars(provider: MentionProvider): MentionProvider {
  const wrapped = Object.create(provider) as MentionProvider
  wrapped.search = (query, opts) => provider.search(query, opts).then(items => Promise.all(
    items.map(async item => item.avatarUrl
      ? { ...item, avatarUrl: await signedUrl(item.avatarUrl).catch(() => item.avatarUrl) }
      : item),
  ))
  return wrapped
}

/**
 * The instance's own people, offered wherever `@` is typed.
 *
 * A mention field asked the modules and nobody else: with contacts absent - or
 * simply holding nobody by that name - typing `@` did nothing at all, which
 * reads as a broken feature rather than an empty one. Yet the one thing every
 * instance always has is its own accounts, and they belong to the core.
 *
 * So the core registers itself as a provider, under the same point and the same
 * rules as any module. It answers the directory's own endpoint, which means the
 * administrator's sharing policy applies untouched: a closed directory answers
 * nobody, a narrowed one answers the caller's unit, and an address travels only
 * when the policy shares it.
 */
export function installDirectoryMentions(): void {
  registerMentionProvider('core', {
    id:      'directory',
    trigger: '@',
    async search(query, opts) {
      try {
        const { data } = await api.get<{ users: DirectoryUser[] }>('/users/search', {
          params: { q: query, limit: opts?.limit ?? 6 },
          signal: opts?.signal,
        })
        return (data.users ?? []).map(u => ({
          id:           u.id,
          label:        u.display_name || u.username,
          // The address when the policy shares it, the username otherwise -
          // something to tell two people of the same name apart either way.
          secondary:    u.email ?? u.username,
          avatarUrl:    u.avatar_url ?? undefined,
          email:        u.email ?? undefined,
          kubunoUserId: u.id,
        }))
      } catch {
        return []   // annuaire fermé, hors périmètre, réseau : rien à proposer
      }
    },
  })
}

interface DirectoryUser {
  id:            string
  username:      string
  display_name:  string | null
  avatar_url:    string | null
  email?:        string | null
}
