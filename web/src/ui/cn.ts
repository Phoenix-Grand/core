/**
 * Class names, composed in house.
 *
 * `clsx` was pulled into eight repositories to do what fits in a dozen lines,
 * and `tailwind-merge` into one more. Neither earns a place in a supply chain we
 * want to keep small: this is finished logic - it will not gain features, and it
 * has no security surface worth tracking upstream.
 *
 * Accepts what call sites already pass: strings, conditions that fall through
 * when false, arrays, and objects keyed by class name.
 *
 *   cn('btn', isActive && 'btn--on', { 'btn--lg': big }, extra)
 */

export type ClassValue =
  | string
  | number
  | bigint      // `count && 'cls'` yields 0n when the count is a bigint zero
  | null
  | undefined
  | false
  | ClassValue[]
  | { [key: string]: unknown }

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = []
  for (const input of inputs) {
    if (!input) continue                      // false, null, undefined, '', 0
    if (typeof input === 'string' || typeof input === 'number' || typeof input === 'bigint') {
      out.push(String(input))
    } else if (Array.isArray(input)) {
      const nested = cn(...input)
      if (nested) out.push(nested)
    } else {
      for (const key in input) {
        if (input[key]) out.push(key)
      }
    }
  }
  return out.join(' ')
}

/** The name `clsx` used, kept so call sites can move without being rewritten. */
export const clsx = cn
export default cn
