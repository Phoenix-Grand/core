import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil } from 'lucide-react'
import { Button, Callout, Card } from '@ui'
import { useUnsavedEditor } from './unsaved'

/**
 * A card of a record sheet that turns into its own form.
 *
 * The console used to answer "Modifier" with a floating window laid over the
 * sheet. Two things followed, every time: the window offered fewer fields than
 * the sheet displayed — so an operator could read a value where they could not
 * change it — and the duplicated form quietly drifted from the card it was
 * supposed to mirror. There is no third form here: the same card is the reading
 * surface and the editing surface.
 *
 * What the two states owe the operator:
 *
 * - **Distinguishable.** In edit mode the card takes a primary ring and a footer
 *   with the two verbs; nothing else on the sheet moves, so it is obvious which
 *   block is being edited and which are not.
 * - **Cancel restores.** The caller's `onCancel` resets its draft (see
 *   [`useDraft`]); this component never writes.
 * - **Save is refused when nothing moved**, so an operator cannot produce an
 *   audit entry announcing a change they did not make.
 * - **Errors surface.** A refusal that belongs to one field is passed to that
 *   field's `error` prop by the caller; anything else lands in `error` here, at
 *   the top of the card body, and is never swallowed.
 *
 * Read-only records simply pass `canEdit={false}`: no pencil is drawn, and the
 * card is an ordinary `Card`.
 */
export interface EditableCardProps {
  title:     ReactNode
  icon?:     ReactNode
  subtitle?: ReactNode
  className?: string
  /** Draw the pencil at all. Mirror the privilege the server will demand. */
  canEdit:   boolean
  editing:   boolean
  onEdit:    () => void
  onCancel:  () => void
  onSave:    () => void
  /** Save is disabled while false — nothing changed, nothing to write. */
  dirty:     boolean
  saving?:   boolean
  /** A refusal that belongs to no single field. Shown atop the card body. */
  error?:    string
  /** Extra header controls, kept in both states (a badge, a secondary verb). */
  actions?:  ReactNode
  /** Explains what the pencil covers, when the title does not say it all. */
  editLabel?: string
  children:  ReactNode
}

export default function EditableCard({
  title, icon, subtitle, className,
  canEdit, editing, onEdit, onCancel, onSave,
  dirty, saving = false, error, actions, editLabel,
  children,
}: EditableCardProps) {
  const { t } = useTranslation()

  // Leaving the sheet with this card half-edited must not lose the field in
  // silence — see `unsaved.ts`.
  useUnsavedEditor(editing && dirty)

  // The ring is the whole "you are editing this one" signal — a full token
  // colour, never an opacity modifier, so the dark theme remaps it too.
  const skin = [className, editing ? 'ring-1 ring-primary' : ''].filter(Boolean).join(' ')

  return (
    <Card
      title={title}
      icon={icon}
      subtitle={subtitle}
      className={skin || undefined}
      actions={
        <span className="flex shrink-0 items-center gap-2">
          {actions}
          {canEdit && !editing && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Pencil size={14} />}
              onClick={onEdit}
              aria-label={editLabel ?? t('admin.edit')}
            >
              {t('admin.edit')}
            </Button>
          )}
        </span>
      }
      footer={editing ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" size="sm" className="min-w-24" onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" className="min-w-24" onClick={onSave} loading={saving} disabled={!dirty || saving}>
            {t('common.save')}
          </Button>
        </div>
      ) : undefined}
    >
      {error && (
        <Callout variant="danger" t={t} className="mb-3">{error}</Callout>
      )}
      {children}
    </Card>
  )
}
