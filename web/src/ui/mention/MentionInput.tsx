import { cn } from '../cn'
import React, { useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { MentionItem, MentionsConfig } from './types'
import { useMentionAutocomplete } from './useMentionAutocomplete'
import { MentionList } from './MentionList'

/** The value model a mention-aware single-line field emits. */
export interface MentionModel {
  /** The plain text typed by the user (mentions removed). */
  text: string
  /** The mentions picked so far, in insertion order. */
  mentions: MentionItem[]
}

export interface MentionInputProps {
  mentions: MentionsConfig
  placeholder?: string
  className?: string
  disabled?: boolean
  /** Initial model (uncontrolled thereafter). */
  defaultValue?: MentionModel
  /** Notified on every change to the {text, mentions} model. */
  onMentionsChange?: (model: MentionModel) => void
}

/**
 * Single-line mention field: a native `<input>` whose picked mentions render as
 * removable chips BESIDE it (a `<textarea>`/`<input>` cannot hold rich chips).
 * Generalises the mail `RecipientField` pattern. The exposed value is the
 * `{ text, mentions }` model via `onMentionsChange`, not the raw input string.
 */
export function MentionInput({
  mentions, placeholder, className, disabled, defaultValue, onMentionsChange,
}: MentionInputProps) {
  const [text, setText] = useState(defaultValue?.text ?? '')
  const [chips, setChips] = useState<MentionItem[]>(defaultValue?.mentions ?? [])
  const inputRef = useRef<HTMLInputElement>(null)

  const emit = (nextText: string, nextChips: MentionItem[]) => {
    onMentionsChange?.({ text: nextText, mentions: nextChips })
  }

  const auto = useMentionAutocomplete({
    providers: mentions.providers,
    trigger: mentions.trigger,
    onSelect: (item, match) => {
      const el = inputRef.current
      const caret = el?.selectionStart ?? text.length
      // Offsets from `detectMention` are relative to the text before the caret,
      // which - on a single line - are absolute offsets into `text`.
      const nextText = text.slice(0, match.start) + text.slice(caret)
      const nextChips = chips.some((c) => c.id === item.id) ? chips : [...chips, item]
      setText(nextText)
      setChips(nextChips)
      emit(nextText, nextChips)
      requestAnimationFrame(() => {
        el?.focus()
        el?.setSelectionRange(match.start, match.start)
      })
    },
  })

  const recompute = () => {
    const el = inputRef.current
    if (!el) return
    const caret = el.selectionStart ?? el.value.length
    const before = el.value.slice(0, caret)
    // No per-caret rect inside an <input>; anchor under the field.
    auto.handleCaret({ textBeforeCaret: before, anchorRect: el.getBoundingClientRect() })
  }

  const removeChip = (idx: number) => {
    const next = chips.filter((_, i) => i !== idx)
    setChips(next)
    emit(text, next)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (auto.handleKeyDown(e)) { e.preventDefault(); return }
    // Empty field + Backspace removes the last chip (Gmail-style comfort).
    if (e.key === 'Backspace' && !text && chips.length) removeChip(chips.length - 1)
  }

  return (
    <div
      className={cn(cn(
        'relative w-full flex flex-wrap items-center gap-1 rounded-md border bg-white',
        'px-2 py-1 min-h-9 text-sm text-text-primary border-border',
        'kb-field-focus',
        disabled && 'bg-surface-2 cursor-not-allowed opacity-60',
        className,
      ))}
    >
      {chips.map((c, i) => (
        <span
          key={c.id + i}
          className="flex items-center gap-1 max-w-[16rem] truncate rounded-full bg-primary-light
                     text-primary text-xs font-medium pl-2.5 pr-1 py-0.5"
        >
          <span className="truncate">{c.label}</span>
          <button
            type="button" aria-label="Retirer" disabled={disabled}
            onClick={() => removeChip(i)}
            className="shrink-0 opacity-60 hover:opacity-100"
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={text}
        disabled={disabled}
        onChange={(e) => { setText(e.target.value); emit(e.target.value, chips); recompute() }}
        onKeyUp={recompute}
        onKeyDown={onKeyDown}
        onBlur={() => auto.close()}
        placeholder={chips.length ? '' : placeholder}
        className="flex-1 min-w-[6rem] bg-transparent outline-none placeholder:text-text-tertiary"
      />
      <MentionList
        items={auto.items}
        activeIndex={auto.activeIndex}
        query={auto.query}
        anchorRect={auto.anchorRect}
        loading={auto.loading}
        onHover={auto.setActiveIndex}
        onPick={auto.selectItem}
      />
    </div>
  )
}
