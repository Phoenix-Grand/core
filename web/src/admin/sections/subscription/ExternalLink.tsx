import type { ReactNode } from "react"

/**
 * An outgoing link, styled once for the whole page.
 *
 * `rel="noreferrer"` on every one of them: these point at public pages, and the
 * address of a private instance is not something a click should hand to them.
 */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2 hover:text-primary-hover"
    >
      {children}
    </a>
  )
}
