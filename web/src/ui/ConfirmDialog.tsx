import { useEffect } from 'react'
import { AlertTriangle, Trash2 } from 'lucide-react'
import { FloatingWindow } from './FloatingWindow'

export type ConfirmVariant = 'danger' | 'warning' | 'default'

export interface ConfirmOptions {
  title:         string
  message:       string
  confirmLabel?: string
  cancelLabel?:  string
  variant?:      ConfirmVariant
  /** Masque le bouton « Annuler » → dialogue d'information à un seul bouton. */
  hideCancel?:   boolean
}

interface Props extends ConfirmOptions {
  onConfirm: () => void
  onCancel:  () => void
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirmer',
  cancelLabel  = 'Annuler',
  variant      = 'default',
  hideCancel   = false,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter') onConfirm() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onConfirm])

  const iconBg    = variant === 'danger'  ? 'bg-red-100'    : variant === 'warning' ? 'bg-amber-100'  : 'bg-gray-100'
  const iconColor = variant === 'danger'  ? 'text-red-600'  : variant === 'warning' ? 'text-amber-600' : 'text-gray-600'

  // The footer belongs to the window now: a confirmation is a dialog like any
  // other, and it was the last one still drawing two full-width filled buttons
  // of its own - the shape every other dialog had just stopped using.
  return (
    <FloatingWindow
      title={title}
      onClose={onCancel}
      defaultWidth={380}
      backdrop
      actions={{
        confirm: { label: confirmLabel, onClick: onConfirm, danger: variant === 'danger', autoFocus: true },
        cancel:  hideCancel ? false : { label: cancelLabel, onClick: onCancel },
      }}
    >
      <div className="p-6 flex flex-col gap-4">
        {/* Icône */}
        <div className={`w-12 h-12 rounded-full ${iconBg} flex items-center justify-center flex-shrink-0`}>
          {variant === 'danger'
            ? <Trash2        className={`w-6 h-6 ${iconColor}`} />
            : <AlertTriangle className={`w-6 h-6 ${iconColor}`} />
          }
        </div>

        {/* Message */}
        <p className="text-sm text-gray-500 leading-relaxed whitespace-pre-line">{message}</p>
      </div>
    </FloatingWindow>
  )
}
