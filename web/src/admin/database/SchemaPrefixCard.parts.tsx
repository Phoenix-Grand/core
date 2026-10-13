/**
 * The parts of `SchemaPrefixCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { TriangleAlert } from "lucide-react"
import { Callout } from "@ui"
import type { SchemaPrefixCard } from './SchemaPrefixCard'

export function Part1({ t }: { t: NonNullable<SchemaPrefixCard['tr']> }) {
  return (
    <Callout variant="danger" icon={<TriangleAlert size={16} />}>{t('admin.dbprefix_load_error')}</Callout>
  )
}

export function Part2({ t, done }: { t: NonNullable<SchemaPrefixCard['tr']>; done: NonNullable<SchemaPrefixCard['done']> }) {
  return (
    <Callout variant="success">
                  {t('admin.dbprefix_done', { schemas: done.length ? done.join(', ') : '—' })}
                  <div className="mt-1">{t('admin.dbprefix_restart_hint')}</div>
                </Callout>
  )
}
