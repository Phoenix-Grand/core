/**
 * The parts of `DataGroup.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import TableDemo from "./data/TableDemo"
import CalloutsAndProgress from "./data/CalloutsAndProgress"
import { ToastsDemo } from "./data/ToastsDemo"
import ComboboxDemo from "./data/ComboboxDemo"
import EmptyStatesDemo from "./data/EmptyStatesDemo"
import StepperDemo from "./data/StepperDemo"
import type { DataGroup } from './DataGroup'

function Block({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="font-medium text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>{title}</h4>
      {hint && <p className="-mt-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>{hint}</p>}
      {children}
    </section>
  )
}
export { Block }

export function Part1({ t }: { t: NonNullable<DataGroup['tr']> }) {
  return (
    <Block
            title={t('admin.t_prev_g_table', { defaultValue: 'Table de données & carte' })}
            hint={t('admin.t_prev_g_table_h', {
              defaultValue: 'Tri par colonne, pagination, sélection multiple, colonnes configurables. La table défile horizontalement dans son propre cadre ; en dessous de 700 px de large, les lignes deviennent des cartes.',
            })}
          >
            <TableDemo />
          </Block>
  )
}

export function Part2({ t }: { t: NonNullable<DataGroup['tr']> }) {
  return (
    <Block title={t('admin.t_prev_g_empty', { defaultValue: 'États vides — quatre situations distinctes' })}
                 hint={t('admin.t_prev_g_empty_h', {
                   defaultValue: 'Premier usage (invite à créer) · résultat filtré vide (efface les filtres, jamais de création) · erreur (réessayer) · indisponible (documentation).',
                 })}>
            <EmptyStatesDemo />
          </Block>
  )
}

export function Part3({ t }: { t: NonNullable<DataGroup['tr']> }) {
  return (
    <Block title={t('admin.t_prev_g_feedback', { defaultValue: 'Encadrés & progression' })}>
            <CalloutsAndProgress />
          </Block>
  )
}

export function Part4({ t }: { t: NonNullable<DataGroup['tr']> }) {
  return (
    <Block title={t('admin.t_prev_g_toast', { defaultValue: 'Notifications' })}>
            <ToastsDemo />
          </Block>
  )
}

export function Part5({ t }: { t: NonNullable<DataGroup['tr']> }) {
  return (
    <Block title={t('admin.t_prev_g_combobox', { defaultValue: 'Sélection dans une longue liste' })}>
            <ComboboxDemo />
          </Block>
  )
}

export function Part6({ t }: { t: NonNullable<DataGroup['tr']> }) {
  return (
    <Block title={t('admin.t_prev_g_stepper', { defaultValue: 'Assistant multi-étapes' })}>
            <StepperDemo />
          </Block>
  )
}
