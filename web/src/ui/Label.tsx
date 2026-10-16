import React from 'react'

/**
 * The typographic roles shared with the desktop (`Label Role`, VIEWS-SPEC §7.1), as the host's text
 * steps: `Meta` and `Body` are Tailwind's `text-xs` / `text-sm` (re-pointed at 11.5 / 13.5 px by
 * `index.css`, with Tailwind's line heights), the others the `--kb-text-*` tokens.
 */
export type TextRole = 'Micro' | 'Meta' | 'Body' | 'Heading' | 'Title' | 'Badge' | 'Caption' | 'Subtitle' | 'Display'

export const TEXT_ROLE_CLASS: Readonly<Record<TextRole, string>> = {
  Micro: 'text-[length:var(--kb-text-micro)]',
  Meta: 'text-xs',
  Body: 'text-sm',
  Heading: 'text-[length:var(--kb-text-heading)]',
  Title: 'text-[length:var(--kb-text-title)]',
  // The four steps added for what screens wrote as free sizes: the small ones set the size only (the line stays the
  // running text's, as `text-[10px]` did), the large ones Tailwind's pairs (`text-base` 16/24, `text-2xl` 24/32).
  Badge: 'text-[length:var(--kb-text-badge)]',
  Caption: 'text-[length:var(--kb-text-caption)]',
  Subtitle: 'text-base',
  Display: 'text-2xl',
}

/** `TextAlign` (WinForms `ContentAlignment`) → the horizontal part, the only one a flow label has. */
export type TextAlign =
  | 'TopLeft' | 'TopCenter' | 'TopRight'
  | 'MiddleLeft' | 'MiddleCenter' | 'MiddleRight'
  | 'BottomLeft' | 'BottomCenter' | 'BottomRight'

const ALIGN_CLASS = (a: TextAlign | undefined): string | undefined =>
  a?.endsWith('Center') ? 'text-center' : a?.endsWith('Right') ? 'text-end' : a ? 'text-start' : undefined

/** `Overflow`: what a text too long for its box does. */
export type TextOverflow = 'Ellipsis' | 'Clip' | 'Wrap'

const OVERFLOW_CLASS: Readonly<Record<TextOverflow, string | undefined>> = {
  Ellipsis: 'truncate',
  Clip: 'overflow-hidden whitespace-nowrap',
  Wrap: undefined,
}

/** `FontWeight` (web): the host's weight steps. The host renders `font-medium` at 600 and running text at 500. */
export type TextWeight = 'Regular' | 'Medium' | 'SemiBold' | 'Bold'

export const TEXT_WEIGHT_CLASS: Readonly<Record<TextWeight, string>> = {
  Regular: 'font-normal',
  Medium: 'font-medium',
  SemiBold: 'font-semibold',
  Bold: 'font-bold',
}

/** `FontStyle` (web): upright or italic. */
export type TextStyle = 'Normal' | 'Italic'

/** A size utility written by the caller wins over the role's step (migration: hand-written sizes). */
const HAS_SIZE = /(^|\s)(text-(xs|sm|base|lg|xl|[2-9]xl)|text-\[\d)/

/** The HTML element of a `Label` (web `HtmlTag`): a paragraph by default, a heading, an inline run… */
export type TextTag = 'p' | 'span' | 'div' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'strong' | 'em' | 'small' | 'label' | 'code' | 'li'

export interface LabelProps extends Omit<React.HTMLAttributes<HTMLParagraphElement>, 'role'> {
  /** The element rendered (default `p`): the text's HTML semantics (a heading level, an inline run). */
  as?: TextTag
  /** No role size class: the text keeps its parent's font size (a run inside a sentence, a migrated screen's text without its own size). */
  inheritSize?: boolean
  text?: React.ReactNode
  role?: TextRole
  textAlign?: TextAlign
  overflow?: TextOverflow
  /** Text weight; unset = the running text's (500). */
  weight?: TextWeight
  fontStyle?: TextStyle
  /** The ARIA role of the paragraph (rarely needed). */
  ariaRole?: string
}

/**
 * A line or paragraph of text in one of the shared typographic roles (the `.kbview` `Label`). Colours come
 * from theme tokens (`ForeColor`), sizes from the role.
 */
export const Label = React.forwardRef<HTMLParagraphElement, LabelProps>(function Label(
  { text, role = 'Body', textAlign, overflow = 'Ellipsis', weight, fontStyle, ariaRole, as: Tag = 'p', inheritSize, className, children, ...rest },
  ref,
) {
  const cls = [
    inheritSize || (className && HAS_SIZE.test(className)) ? undefined : TEXT_ROLE_CLASS[role],
    ALIGN_CLASS(textAlign),
    OVERFLOW_CLASS[overflow],
    weight ? TEXT_WEIGHT_CLASS[weight] : undefined,
    fontStyle === 'Italic' ? 'italic' : undefined,
    className,
  ].filter(Boolean).join(' ')
  return (
    // createElement: the props of a paragraph fit every text tag (a heading, a span…).
    React.createElement(Tag, { ref, role: ariaRole, className: cls || undefined, ...rest }, text ?? children)
  )
})

Label.displayName = 'Label'

export interface LinkLabelProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  text?: React.ReactNode
  role?: TextRole
  /** No role size class: the link keeps its parent's font size. */
  inheritSize?: boolean
  weight?: TextWeight
  fontStyle?: TextStyle
}

/**
 * A link (the `.kbview` `LinkLabel`). With an `href`, a plain left click stays in the app - its `onClick`
 * decides where to go (SPA routing) - while a middle or modified click opens the address as any link does.
 */
export const LinkLabel = React.forwardRef<HTMLAnchorElement, LinkLabelProps>(function LinkLabel(
  { text, role = 'Body', weight, fontStyle, inheritSize, className, onClick, href, children, ...rest },
  ref,
) {
  const cls = [inheritSize || (className && HAS_SIZE.test(className)) ? undefined : TEXT_ROLE_CLASS[role], weight ? TEXT_WEIGHT_CLASS[weight] : undefined, fontStyle === 'Italic' ? 'italic' : undefined, className].filter(Boolean).join(' ')
  return (
    <a
      ref={ref}
      href={href}
      className={cls || undefined}
      onClick={(e) => {
        if (href && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) e.preventDefault()
        onClick?.(e)
      }}
      {...rest}
    >
      {text ?? children}
    </a>
  )
})

LinkLabel.displayName = 'LinkLabel'
