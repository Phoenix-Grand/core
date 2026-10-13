/**
 * The parts of `AudienceDialog.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Input } from "@ui"
import type { AudienceDialog } from './AudienceDialog'
const NAME_MAX = 40

export function Part1({ t, name, setName, nameLen }: { t: NonNullable<AudienceDialog['tr']>; name: NonNullable<AudienceDialog['name']>; setName: NonNullable<AudienceDialog['setName']>; nameLen: NonNullable<AudienceDialog['nameLen']> }) {
  return (
    <Input
                label={t('admin.aud_name', { defaultValue: 'Nom' })}
                value={name}
                autoFocus
                onChange={e => setName(e.target.value)}
                placeholder={t('admin.aud_name_ph', { defaultValue: 'Direction, Agence de Lyon…' })}
                error={nameLen > NAME_MAX
                  ? t('admin.aud_name_too_long', {
                      defaultValue_one: 'Trop long de {{count}} caractère.',
                      defaultValue: 'Trop long de {{count}} caractères.',
                      count: nameLen - NAME_MAX,
                    })
                  : undefined}
                hint={t('admin.aud_name_hint', {
                  defaultValue: 'Affiché dans la liste de partage, à côté d’un nom de fichier. {{n}}/{{max}}',
                  n: nameLen, max: NAME_MAX,
                })}
              />
  )
}
