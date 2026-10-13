/**
 * Silencing a health WARNING, shared by the places that offer it.
 *
 * Per-browser (`localStorage`) on purpose: it is a reading convenience, not a
 * decision about the instance. Deciding a finding does not apply is what
 * "ignore" is for, and that one is stored server-side with its author, audited.
 *
 * The silence expires on its own, because a warning nobody ever sees again is a
 * warning that was never raised.
 */
const SNOOZE_KEY = 'kubuno:health-banner-snoozed-until'

export const SNOOZE_DAYS = 7

/** Timestamp the snooze runs until, or 0 when there is none. */
export function snoozedUntil(): number {
  try {
    const raw = window.localStorage.getItem(SNOOZE_KEY)
    return raw ? Number(raw) || 0 : 0
  } catch {
    // Private mode, storage disabled: warnings simply always show, which is the
    // safe direction to fail in.
    return 0
  }
}

/** True while a warning is currently silenced. */
export function isSnoozed(): boolean {
  return Date.now() < snoozedUntil()
}

export function snooze(): void {
  try {
    window.localStorage.setItem(
      SNOOZE_KEY,
      String(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000),
    )
  } catch { /* nothing to do: it comes back on the next page */ }
}
