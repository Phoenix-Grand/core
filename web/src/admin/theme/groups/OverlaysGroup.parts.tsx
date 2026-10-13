/**
 * The parts of `OverlaysGroup.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { ConfirmDialog, ConflictDialog, FloatingWindow } from "@ui"
import { noop } from "../PreviewDemos"
import AnchoredDemo from "../AnchoredDemo"
import PreviewStage from "../PreviewStage"
import type { OverlaysGroup } from './OverlaysGroup'

export function Part1({ t }: { t: NonNullable<OverlaysGroup['tr']> }) {
  return (
    <PreviewStage title={t('admin.t_prev_window', { defaultValue: 'Fenêtre flottante' })} width={360} height={280}>
              <FloatingWindow title="Fenêtre flottante" onClose={noop} defaultWidth={260} minWidth={200} minHeight={120}>
                <div className="p-4 text-sm text-text-secondary">{t('admin.t_prev_window_body', { defaultValue: 'Contenu de la fenêtre.' })}</div>
              </FloatingWindow>
            </PreviewStage>
  )
}

export function Part2({ t }: { t: NonNullable<OverlaysGroup['tr']> }) {
  return (
    <PreviewStage title={t('admin.t_prev_confirm', { defaultValue: 'Boîte de confirmation' })} width={480} height={360}>
              <ConfirmDialog
                title={t('admin.t_prev_confirm_title', { defaultValue: 'Supprimer l’élément ?' })}
                message={t('admin.t_prev_confirm_msg', { defaultValue: 'Cette action est définitive et ne peut pas être annulée.' })}
                variant="danger"
                confirmLabel={t('common.delete', { defaultValue: 'Supprimer' })}
                onConfirm={noop}
                onCancel={noop}
              />
            </PreviewStage>
  )
}

export function Part3({ t }: { t: NonNullable<OverlaysGroup['tr']> }) {
  return (
    <PreviewStage title={t('admin.t_prev_conflict', { defaultValue: 'Conflit de nom' })} width={500} height={440}>
              <ConflictDialog type="file" name="rapport.pdf" onChoice={noop} />
            </PreviewStage>
  )
}

export function Part4({ t }: { t: NonNullable<OverlaysGroup['tr']> }) {
  return (
    <PreviewStage title={t('admin.t_prev_anchored', { defaultValue: 'Menu ancré' })} width={240} height={220}>
              <AnchoredDemo />
            </PreviewStage>
  )
}
