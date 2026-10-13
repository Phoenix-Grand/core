/**
 * The parts of `ModuleDatabaseCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { TriangleAlert } from "lucide-react"
import { Callout } from "@ui"
import type { ModuleDatabaseCard } from './ModuleDatabaseCard'

export function Part1({ t }: { t: NonNullable<ModuleDatabaseCard['tr']> }) {
  return (
    <Callout variant="danger" icon={<TriangleAlert size={16} />}>{t('admin.mdb_load_error')}</Callout>
  )
}
