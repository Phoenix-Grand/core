import { useEffect, useRef, useState } from 'react'
import { FloatingWindow } from './FloatingWindow'

export interface PromptOptions {
  title:         string
  message?:      string
  defaultValue?: string
  placeholder?:  string
  confirmLabel?: string
  cancelLabel?:  string
  multiline?:    boolean
  /** Autorise une valeur vide à la validation (sinon le bouton est désactivé). */
  allowEmpty?:   boolean
}

interface Props extends PromptOptions {
  onConfirm: (value: string) => void
  onCancel:  () => void
}

export default function PromptDialog({
  title,
  message,
  defaultValue = '',
  placeholder,
  confirmLabel = 'OK',
  cancelLabel  = "Cancel",
  multiline    = false,
  allowEmpty   = false,
  onConfirm,
  onCancel,
}: Props) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const areaRef  = useRef<HTMLTextAreaElement>(null)

  // Focus + sélection du contenu initial à l'ouverture
  useEffect(() => {
    const el = multiline ? areaRef.current : inputRef.current
    el?.focus()
    el?.select()
  }, [multiline])

  const canConfirm = allowEmpty || value.trim() !== ''
  const submit = () => { if (canConfirm) onConfirm(value) }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <FloatingWindow
      title={title}
      onClose={onCancel}
      defaultWidth={400}
      backdrop
    >
      <div className="p-6 flex flex-col gap-4">
        {message && <p className="text-sm text-gray-500 leading-relaxed">{message}</p>}

        {multiline ? (
          <textarea
            ref={areaRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            rows={3}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg resize-y
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        ) : (
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        )}

        <div className="flex gap-3 mt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300
                       rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300 transition-colors whitespace-nowrap"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canConfirm}
            className="flex-1 px-4 py-2 text-sm font-medium rounded-lg focus:outline-none
                       focus:ring-2 focus:ring-offset-1 focus:ring-blue-500 transition-colors whitespace-nowrap
                       bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </FloatingWindow>
  )
}
