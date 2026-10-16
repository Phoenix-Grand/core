// @mention contract - the reusable shape shared by every mention-aware field and
// by any module that wants to feed people (contacts, mail…) into those fields.
//
// These types live in `@ui` (the lowest shared layer) so that the primitives can
// depend on them without importing the host. The core registry re-exports them
// under `@kubuno/sdk`, so a module sees the SAME types whichever specifier it
// imports from.

/** One selectable entity behind a mention (a person, most of the time). */
export interface MentionItem {
  /** Stable identifier, unique within a provider (used for dedup/rendering). */
  id: string
  /** Human-readable name shown in the dropdown and the inserted chip. */
  label: string
  /** Secondary line under the label (typically the email). */
  secondary?: string
  /** Optional avatar; when absent a letter pill is rendered instead. */
  avatarUrl?: string
  /** Email address, when the entity has one (used by `serializeMentions`). */
  email?: string
  /** Kubuno user id, when the entity maps to a real account. */
  kubunoUserId?: string
}

/** A source of mention candidates. A module registers one at `'mentions.provider'`. */
export interface MentionProvider {
  /** Provider identity (used for diagnostics; not shown to the user). */
  id: string
  /** Trigger character this provider answers to. Defaults to `'@'`. */
  trigger?: string
  /** Return candidates for `query`. Must honour `signal` (abort) when given. */
  search(query: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<MentionItem[]>
}

/**
 * Opt-in mention configuration accepted by `Input`, `Textarea` and `RichText`.
 * ABSENT (or `enabled` falsy) → the primitive behaves EXACTLY as before.
 */
export interface MentionsConfig {
  /** Turn the feature on. */
  enabled?: boolean
  /**
   * Explicit provider list. When omitted, the primitives fall back to the
   * providers registered at the `'mentions.provider'` extension point
   * (dynamic discovery - no provider means the feature is silently inert).
   */
  providers?: MentionProvider[]
  /** Trigger character (default `'@'`). */
  trigger?: string
}

/** A detected trigger occurrence in the text before the caret. */
export interface MentionMatch {
  /** Text typed after the trigger, before the caret (never contains spaces). */
  query: string
  /** The trigger character that matched. */
  trigger: string
  /** Offset of the trigger character within the scanned text-before-caret. */
  start: number
  /** Offset of the caret within the scanned text-before-caret. */
  end: number
}
