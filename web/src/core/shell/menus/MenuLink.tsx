/**
 * `MenuLink` - a link that is an item of the menu hosting the view (web custom control). In the shell's
 * menus (the `WaffleMenu`'s « Plus de modules ») it must be reachable with the menu's arrow keys and close
 * the menu when chosen like the tiles: the host's `MenuItemHostContext` makes it a menu item; anywhere else
 * it is a plain link. A plain click stays in the app (its `OnClick` decides where to go); a middle or
 * modified click opens `Href` in a new tab.
 */
import { forwardRef, type MouseEvent, type ReactNode } from 'react'

import { defineControl } from '@kubuno/views'
import { useMenuItemHost } from './menuItemHost'

export interface MenuLinkProps {
  text?: string
  href?: string
  className?: string
  style?: React.CSSProperties
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void
}

/**
 * The look of the menu's footer link: an outlined button across the menu, inset like the menu's cards (the
 * launcher's grid publishes its side inset as `--kb-waffle-inset`). A `Class` given in the view adds to it.
 */
const FOOTER_LINK =
  'mt-3 mb-4 mx-[var(--kb-waffle-inset,26px)] flex items-center justify-center rounded-md border border-border px-4 py-2.5 text-center text-xs text-primary hover:bg-black/[0.04] transition-colors outline-none'

const MenuLinkImpl = forwardRef<HTMLAnchorElement, MenuLinkProps>(function MenuLink({ text, href, className, style, onClick }, ref): ReactNode {
  const asItem = useMenuItemHost()
  return asItem(
    <a
      ref={ref}
      href={href ?? '#'}
      className={className ? `${FOOTER_LINK} ${className}` : FOOTER_LINK}
      style={style}
      onClick={(e) => {
        if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) e.preventDefault()
        onClick?.(e)
      }}
    >
      {text}
    </a>,
  )
})

export const MenuLink = defineControl(MenuLinkImpl, {
  category: 'Kubuno',
  icon: 'Link',
  defaultEvent: 'OnClick',
  props: {
    Text: { kind: 'String', prop: 'text' },
    Href: { kind: 'String', bindable: true, prop: 'href' },
  },
  events: { OnClick: { prop: 'onClick', args: 'MouseEventArgs' } },
  children: 'None',
})
