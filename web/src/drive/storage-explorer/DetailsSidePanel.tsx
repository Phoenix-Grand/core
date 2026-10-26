/**
 * Details of the current item, in the shell's right panel.
 *
 * Replaces the floating "Informations" window for the explorer: a window had to
 * be dismissed before the next file could be inspected, so comparing two items
 * meant opening and closing it twice. The panel stays open and follows the
 * selection - which is what makes it useful with nothing selected too, as a
 * place that says what to do rather than an empty rectangle.
 *
 * Renders the BODY only: the shell draws the title, the close button, the
 * pop-out and the resize joint around whatever a rail entry mounts.
 *
 * The body is the very same `FileInfoContent` the window used, so the two never
 * drift and module-contributed sections (labels, and anything else registered on
 * the `files-info-extra` slot) keep working untouched.
 */
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { FileInfoContent } from '../FileInfoModal'
import { useDetailsTargetStore } from '../detailsTargetStore'

/** Rail entry id. Separate from `drive`, which already mounts the mini panel. */
export const DRIVE_DETAILS_PANEL = 'drive-details'

export function DriveDetailsPanel() {
  const { t } = useTranslation('drive')
  const target     = useDetailsTargetStore(s => s.target)
  const folderName = useDetailsTargetStore(s => s.folderName)

  if (!target) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <Info size={40} className="text-text-tertiary opacity-40" />
        {folderName && <p className="text-sm font-medium text-text-primary">{folderName}</p>}
        <p className="text-sm text-text-secondary">
          {t('info.pick_item', { defaultValue: "Select an item to view its details." })}
        </p>
      </div>
    )
  }

  // Keyed on the item: switching selection remounts, so the active tab and the
  // fetched data never belong to the previously shown file.
  return <FileInfoContent key={`${target.type}:${target.item.id}`} target={target} />
}
