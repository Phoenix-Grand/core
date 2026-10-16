import { create } from 'zustand'
import type { ShareTarget } from '../registry/ShareRegistry'

/** A person a resource can be shared with. */
export interface ShareRecipient {
  id:           string
  display_name: string | null
  email:        string
  avatar_url:   string | null
}

export interface ShareCollaborator extends ShareRecipient {
  user_id:    string
  permission: string
}

/**
 * The calls the dialog needs. Each module wires its own routes - the core never
 * guesses a URL, it only knows the shape of the conversation.
 */
export interface ShareApi {
  list:   (id: string) => Promise<{ owner: ShareRecipient | null; collaborators: ShareCollaborator[] }>
  add:    (id: string, userId: string, permission: string) => Promise<unknown>
  update: (id: string, userId: string, permission: string) => Promise<unknown>
  remove: (id: string, userId: string) => Promise<unknown>
  searchRecipients: (q: string) => Promise<ShareRecipient[]>
}

export interface ShareOptions {
  target: ShareTarget
  api:    ShareApi
  title?: string
  /** Permission levels offered, most permissive first. Default: edit / view. */
  permissions?: string[]
  /** Human label for a permission id (default: the id itself). */
  permissionLabel?: (p: string) => string
  /**
   * Shareable URL. Optional: the dialog always offers "Copier le lien" and
   * falls back to the current page. Pass it when the useful link is NOT where
   * the user stands - a form's public link rather than its editor URL.
   */
  link?: string
  /**
   * Who may open the resource through its link. Every shareable thing has this
   * question, so the dialog renders it itself - the module only says what the
   * current scope is and how to change it.
   */
  linkAccess?: {
    value:    string
    onChange: (value: string) => void
    options:  Array<{ value: string; label: string; hint?: string }>
    /** Heading of the row; defaults to "Accès par lien". */
    label?:   string
  }
}

interface Entry extends ShareOptions {
  resolve: () => void
}

interface Store {
  current: Entry | null
  open:  (options: ShareOptions) => Promise<void>
  close: () => void
}

export const useShareStore = create<Store>((set, get) => ({
  current: null,
  open:  (options) => new Promise<void>(resolve => set({ current: { ...options, resolve } })),
  close: () => { get().current?.resolve(); set({ current: null }) },
}))

/**
 * Opens the project's share dialog. Resolves when it closes.
 *
 * THE way to share anything in the app: a module supplies its routes and, if it
 * needs more than people-and-permissions, registers extra sections through
 * `ShareRegistry`.
 *
 * Requires `<ShareHost />` mounted once (App.tsx).
 */
export const openShare = (options: ShareOptions): Promise<void> =>
  useShareStore.getState().open(options)
