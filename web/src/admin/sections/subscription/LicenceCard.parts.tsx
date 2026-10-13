/**
 * The parts of `LicenceCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { ExternalLink } from "./ExternalLink"
import type { LicenceCard } from './LicenceCard'

export function Part1({ licence, t }: { licence: NonNullable<LicenceCard['props']['licence']>; t: NonNullable<LicenceCard['tr']> }) {
  return (
    <ExternalLink href={licence.text_url}>{t('admin.sub_licence_text_link')}</ExternalLink>
  )
}

export function Part2({ licence, t }: { licence: NonNullable<LicenceCard['props']['licence']>; t: NonNullable<LicenceCard['tr']> }) {
  return (
    <ExternalLink href={licence.source_url}>{t('admin.sub_licence_source_link')}</ExternalLink>
  )
}
