/**
 * The parts of `EmptyStatesDemo.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { EmptyState } from "@ui"
import { CloudOff, FolderPlus, Inbox } from "lucide-react"
import type { EmptyStatesDemo } from './EmptyStatesDemo'

export function Part1({ t }: { t: NonNullable<EmptyStatesDemo['tr']> }) {
  return (
    <EmptyState
              t={t}
              variant="first-use"
              icon={<Inbox size={24} />}
              title={t('admin.t_prev_es_first_t', { defaultValue: 'Aucune unité pour l’instant' })}
              description={t('admin.t_prev_es_first_d', { defaultValue: 'Créez une première unité pour organiser vos comptes.' })}
              action={{ label: t('admin.t_prev_es_first_a', { defaultValue: 'Nouvelle unité' }), onClick: () => {}, icon: <FolderPlus size={14} /> }}
              docHref="https://kubuno.com"
              compact
            />
  )
}

export function Part2({ t }: { t: NonNullable<EmptyStatesDemo['tr']> }) {
  return (
    <EmptyState
              t={t}
              variant="unavailable"
              icon={<CloudOff size={24} />}
              title={t('admin.t_prev_es_unav_t', { defaultValue: 'Module non installé' })}
              description={t('admin.t_prev_es_unav_d', { defaultValue: 'Installez le module Annuaire pour gérer les unités ici.' })}
              docHref="https://kubuno.com"
              compact
            />
  )
}
