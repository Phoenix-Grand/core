/**
 * The sentence to show when a request fails.
 *
 * ## The trap this exists to close
 *
 * The response interceptor in `client.ts` rejects with `{ message, code }` **at
 * the root** - not with the original `AxiosError`. So the reflex,
 * `err.response.data.message`, silently yields `undefined`, and the screen shows
 * its own fallback instead of what the server took the trouble to explain.
 *
 * Lived through on the building sheet: the server answered "L'adresse est
 * obligatoire : c'est la seule question que se pose quelqu'un qui a rendez-vous
 * là-bas", and the console printed "Enregistrement impossible." - leaving the
 * operator to guess which of eight fields was wrong.
 *
 * The axios shape is read FIRST because a caller that bypasses the interceptor
 * still carries the useful text there, while its root `message` is the useless
 * "Request failed with status code 422". When the interceptor did its work there
 * is no `response`, and the root message is the server's own.
 */
/**
 * The server's own sentence, or `undefined` when it said nothing useful.
 *
 * For callers that already pick their fallback at the point of use - a toast, a
 * banner with its own wording. Same reading rules as {@link apiErrorMessage}.
 */
export function apiErrorDetail(err: unknown): string | undefined {
  const e = err as {
    message?:  string
    response?: { data?: { message?: string; error?: string } }
  }
  const data = e?.response?.data
  const msg = data?.message ?? data?.error ?? e?.message
  return msg && msg.trim() !== '' ? msg : undefined
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  const e = err as {
    message?:  string
    response?: { data?: { message?: string; error?: string } }
  }
  const data = e?.response?.data
  const msg = data?.message ?? data?.error ?? e?.message
  return msg && msg.trim() !== '' ? msg : fallback
}
