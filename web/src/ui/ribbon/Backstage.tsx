// <Backstage> - MS Office style "File" view, shared by ALL the modules' sub-editors.
// Vertical rail on the left (app accent colour) = back arrow +
// sections (Home/New/Open/Save/Export/Print/Info…); content panel
// on the right. Data-driven: each editor provides `sections`.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { RibbonTheme } from './types'
import { useIsMobile } from '../interaction'

export interface BackstageSection {
  id:        string
  label:     string
  icon:      ReactNode
  // Right-hand panel ("view" section: Home, New, Open, Export…). If
  // absent AND `onSelect` is present → the section triggers an immediate action
  // (Print, Close…) instead of showing a panel.
  content?:  ReactNode
  onSelect?: () => void
  disabled?: boolean
  // Separator above this section in the rail.
  separated?: boolean
}

export function Backstage({ sections, theme, onBack, locked = false, initial }: {
  sections: BackstageSection[]
  theme:    RibbonTheme
  onBack:   () => void
  locked?:  boolean          // no file open → no way back
  initial?: string           // id of the section displayed initially
}) {
  const views = sections.filter(s => s.content != null)
  const [active, setActive] = useState<string>(initial ?? views[0]?.id ?? '')
  const cur = sections.find(s => s.id === active) ?? views[0]

  // Escape closes the backstage (unless locked: no file open).
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !locked) { e.preventDefault(); onBack() } }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [locked, onBack])

  const isMobile = useIsMobile()
  const accentBg = `var(--kbn-office-file-accent, ${theme.fileAccent ?? theme.accent})`

  // Mobile: the vertical rail (240px) would eat half of the screen - the
  // sections become a horizontal row of chips under the header, the
  // content takes the full width.
  if (isMobile) {
    return (
      <div className="flex flex-col h-full w-full" style={{ background: theme.bg, color: theme.text }} data-module="office">
        <div className="flex items-center gap-1 px-2 py-2 overflow-x-auto flex-shrink-0"
          style={{ background: accentBg, color: 'var(--kbn-office-file-accent-text, #fff)', scrollbarWidth: 'none' }}>
          {sections.map(s => {
            const isActive = active === s.id && s.content != null
            return (
              <button key={s.id} disabled={s.disabled}
                onClick={() => { if (s.onSelect) s.onSelect(); else setActive(s.id) }}
                className="flex items-center gap-1.5 h-9 px-3 rounded-full text-xs flex-shrink-0 disabled:opacity-40 disabled:cursor-default"
                style={{ background: isActive ? 'rgba(255,255,255,0.22)' : 'transparent', fontWeight: isActive ? 600 : 400 }}>
                <span className="flex justify-center flex-shrink-0">{s.icon}</span>
                <span className="whitespace-nowrap">{s.label}</span>
              </button>
            )
          })}
        </div>
        <div className="flex-1 min-w-0 overflow-auto">
          {cur?.content}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full" style={{ background: theme.bg, color: theme.text }} data-module="office">
      {/* Left rail (File tab colour, derived from the module accent) */}
      <div className="flex flex-col w-60 flex-shrink-0 py-2 overflow-y-auto" style={{ background: `var(--kbn-office-file-accent, ${theme.fileAccent ?? theme.accent})`, color: 'var(--kbn-office-file-accent-text, #fff)' }}>
        {/* Back arrow removed (the tab strip stays visible → one leaves by
            clicking another tab); we KEEP the vertical space it used to create. */}
        <div className="h-10 mb-2 flex-shrink-0" aria-hidden />

        {sections.map(s => {
          const isActive = active === s.id && s.content != null
          return (
            <div key={s.id}>
              {s.separated && <div className="my-1.5 mx-5 border-t" style={{ borderColor: 'rgba(255,255,255,0.2)' }} />}
              <button disabled={s.disabled}
                onClick={() => { if (s.onSelect) s.onSelect(); else setActive(s.id) }}
                className="flex items-center gap-3 w-full px-5 h-9 text-xs text-left disabled:opacity-40 disabled:cursor-default"
                style={{ background: isActive ? 'rgba(255,255,255,0.18)' : 'transparent', fontWeight: isActive ? 600 : 400 }}
                onMouseEnter={e => { if (!isActive && !s.disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.1)' }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}>
                <span className="w-5 flex justify-center flex-shrink-0">{s.icon}</span>
                <span className="truncate">{s.label}</span>
              </button>
            </div>
          )
        })}
      </div>

      {/* Content panel */}
      <div className="flex-1 min-w-0 overflow-auto">
        {cur?.content}
      </div>
    </div>
  )
}
