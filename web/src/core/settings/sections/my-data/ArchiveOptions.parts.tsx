/**
 * The parts of `ArchiveOptions.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Combobox } from "@ui"
import type { ArchiveOptions } from './ArchiveOptions'

export function Part1({ t }: { t: NonNullable<ArchiveOptions['tr']> }) {
  return (
    <label
              htmlFor="mde-max-file"
              className="block text-text-primary font-medium"
              style={{ fontSize: 'var(--kb-text-body)' }}
            >
              {t('settings.mde_opt_size', { defaultValue: 'Taille maximale d’un fichier' })}
            </label>
  )
}

export function Part2({ maxFileMb, onMaxFileMb, options, t }: { maxFileMb: NonNullable<ArchiveOptions['props']['maxFileMb']>; onMaxFileMb: NonNullable<ArchiveOptions['props']['onMaxFileMb']>; options: NonNullable<ArchiveOptions['options']>; t: NonNullable<ArchiveOptions['tr']> }) {
  return (
    <Combobox
              id="mde-max-file"
              value={String(maxFileMb)}
              onChange={value => onMaxFileMb(Number(value))}
              options={options}
              width={260}
              aria-label={t('settings.mde_opt_size', { defaultValue: 'Taille maximale d’un fichier' })}
              t={t}
            />
  )
}
