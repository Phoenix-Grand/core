// The installer's language selector.
//
// Labelled rather than an icon: on this screen the choice is not a personal
// preference tucked away in a corner, it is one of the questions being asked -
// the answer becomes the instance's default language.
//
// It cannot reuse the shell's picker, which persists the choice on the signed-in
// account: at this point no account exists.
import { useRef, useState } from 'react'
import { ChevronDown, Globe } from 'lucide-react'
import { MenuDropdown, type MenuDropdownPos } from '@ui'
import { LANGUAGES, applyDir } from '../i18n'
import i18n from 'i18next'

export function LanguageMenu({ value, onChange }: { value: string; onChange: (lng: string) => void }) {
  const [pos, setPos] = useState<MenuDropdownPos | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const current = LANGUAGES.find(l => l.code === value) ?? LANGUAGES[0]

  const pick = (code: string) => {
    void i18n.changeLanguage(code)
    applyDir(code)          // ar / he read right to left
    onChange(code)
    setPos(null)
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => {
          const r = btn.current?.getBoundingClientRect()
          if (r) setPos({ top: r.bottom + 6, left: Math.max(8, r.right - 200), minWidth: 200 })
        }}
        className="flex h-9 items-center gap-2 rounded-md px-3 text-sm transition-colors"
        style={{ color: 'var(--color-text-secondary)', background: 'transparent', border: 0, cursor: 'pointer' }}
      >
        <Globe size={18} />
        <span>{current.label}</span>
        <ChevronDown size={16} />
      </button>

      {pos && (
        <MenuDropdown
          pos={pos}
          onClose={() => setPos(null)}
          items={LANGUAGES.map(l => ({
            type: 'action' as const,
            label: `${l.flag}  ${l.label}`,
            onClick: () => pick(l.code),
          }))}
        />
      )}
    </>
  )
}
