import React, { useEffect, useRef, useState } from 'react'
import { Bold, Italic, Underline, List, ListOrdered, Link2, Eraser } from 'lucide-react'
import type { MentionsConfig } from './mention/types'
import { useContentEditableMention } from './mention/useContentEditableMention'
import { Input } from './Input'

interface RichTextProps {
  /** HTML controlled value */
  value: string
  onChange: (html: string) => void
  placeholder?: string
  className?: string
  minHeight?: number
  disabled?: boolean
  /**
   * Opt-in @mention support. ABSENT (or `enabled` falsy) → unchanged behaviour.
   * When enabled, picking a mention inserts an inline chip directly in the
   * contenteditable; the chips are part of the emitted HTML `value`.
   */
  mentions?: MentionsConfig
}

// Éditeur de texte enrichi primitif (@ui) - contenteditable + execCommand.
// Toolbar : gras, italique, souligné, listes (numérotée/à puces), lien,
// effacer la mise en forme. Sans dépendance lourde ; le lien s'ajoute via un
// petit champ intégré (pas de dialogue navigateur).
export function RichText({ value, onChange, placeholder, className, minHeight = 96, disabled, mentions }: RichTextProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl]   = useState('')
  const [empty, setEmpty]       = useState(!value)
  const savedRange = useRef<Range | null>(null)
  // Opt-in @mention behaviour bound to THIS contenteditable. No-op when absent.
  const mention = useContentEditableMention(ref, mentions, () => emit())

  // Initialise le HTML une seule fois (évite de réinitialiser le curseur à chaque frappe).
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = value || ''
    setEmpty(!ref.current?.textContent?.trim() && !ref.current?.querySelector('img,ul,ol'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const emit = () => {
    const html = ref.current?.innerHTML ?? ''
    const isEmpty = !ref.current?.textContent?.trim() && !ref.current?.querySelector('img,ul,ol,li')
    setEmpty(isEmpty)
    onChange(isEmpty ? '' : html)
  }

  const exec = (cmd: string, val?: string) => { ref.current?.focus(); document.execCommand(cmd, false, val); emit() }

  const saveSel = () => { const s = window.getSelection(); if (s && s.rangeCount) savedRange.current = s.getRangeAt(0).cloneRange() }
  const restoreSel = () => { const s = window.getSelection(); if (s && savedRange.current) { s.removeAllRanges(); s.addRange(savedRange.current) } }

  const applyLink = () => {
    restoreSel()
    const url = linkUrl.trim()
    if (url) exec('createLink', /^https?:\/\//i.test(url) ? url : `https://${url}`)
    setLinkOpen(false); setLinkUrl('')
  }

  const Btn = ({ on, title, children }: { on: () => void; title: string; children: React.ReactNode }) => (
    <button type="button" title={title} aria-label={title} onMouseDown={e => e.preventDefault()} onClick={on}
      className="w-8 h-8 flex items-center justify-center rounded text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors">
      {children}
    </button>
  )

  // `kb-field-focus` reacts on `:focus-within`: the editable area is a
  // contenteditable INSIDE this box, and its own `outline-none` removed the only
  // mark left - a rich field that took focus and showed nothing for it.
  return (
    <div className={`kb-field-focus rounded-md border border-border bg-white overflow-hidden ${className ?? ''}`}>
      <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-border">
        <Btn title="Gras" on={() => exec('bold')}><Bold size={15} /></Btn>
        <Btn title="Italique" on={() => exec('italic')}><Italic size={15} /></Btn>
        <Btn title="Souligné" on={() => exec('underline')}><Underline size={15} /></Btn>
        <span className="w-px h-5 bg-border mx-1" />
        <Btn title="Liste numérotée" on={() => exec('insertOrderedList')}><ListOrdered size={15} /></Btn>
        <Btn title="Liste à puces" on={() => exec('insertUnorderedList')}><List size={15} /></Btn>
        <span className="w-px h-5 bg-border mx-1" />
        <Btn title="Insérer un lien" on={() => { saveSel(); setLinkOpen(o => !o) }}><Link2 size={15} /></Btn>
        <Btn title="Effacer la mise en forme" on={() => exec('removeFormat')}><Eraser size={15} /></Btn>
      </div>
      {linkOpen && (
        <div className="kb-richtext-linkbar flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-surface-1">
          <Input autoFocus value={linkUrl} onChange={e => setLinkUrl(e.target.value)} placeholder="https://…"
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyLink() } if (e.key === 'Escape') setLinkOpen(false) }}
            className="flex-1" />
          <button type="button" onClick={applyLink} className="text-sm font-medium text-primary px-2">OK</button>
        </div>
      )}
      <div className="relative">
        <div ref={ref} contentEditable={!disabled} suppressContentEditableWarning
          onInput={() => { emit(); mention.onInput() }}
          onKeyUp={mention.onKeyUp}
          onKeyDown={mention.onKeyDown}
          className="px-3 py-2 text-sm text-text-primary outline-none leading-relaxed
                     [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:ml-5 [&_ol]:ml-5"
          style={{ minHeight }} />
        {empty && placeholder && (
          <div className="absolute top-2 left-3 text-sm text-text-tertiary pointer-events-none select-none">{placeholder}</div>
        )}
        {mention.overlay}
      </div>
    </div>
  )
}
