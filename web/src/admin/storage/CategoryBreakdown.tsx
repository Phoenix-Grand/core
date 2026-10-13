/**
 * The category reading, shared by the instance card and the account sheet.
 *
 * ## What it is allowed to say
 *
 * Volumes, object counts, and the technical category the bytes fall in. Never a
 * file name, a folder, a path, a MIME type, an extension or a title — see the
 * banner on `AccountUsageDialog`.
 *
 * ## The two totals it keeps apart
 *
 * **Held** is what the disk carries. **Billed** is the part of it charged to a
 * quota — the files somebody can delete, their bin, the versions they can purge.
 * Thumbnails, indexes and caches are held and not billed, deliberately: nobody
 * asked for them and nobody can remove them, so charging for them would invoice
 * a user for the software's own housekeeping.
 *
 * ## `delegated`
 *
 * Never added to either total, in any view. It is bytes a module *caused* while
 * another module stores them — office writing its documents into drive — and the
 * module that holds them already counts them. It is rendered as its own note,
 * outside the bar and outside every sum, because the point of showing it at all
 * is to make the anti-double-count rule visible rather than to move a figure.
 */

/** Grouped digits: object counts routinely run into the millions. */
export function formatCount(n: number): string {
  return n.toLocaleString()
}
