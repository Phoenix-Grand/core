/**
 * The parts of `FeatureDialog.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Input, Textarea } from "@ui"
import type { FeatureDialog } from './FeatureDialog'

export function Part1({ t, name, setName }: { t: NonNullable<FeatureDialog['tr']>; name: NonNullable<FeatureDialog['name']>; setName: NonNullable<FeatureDialog['setName']> }) {
  return (
    <Input
                label={t('admin.res_feature_name')}
                required
                value={name}
                maxLength={60}
                autoFocus
                onChange={e => setName(e.target.value)}
                hint={t('admin.res_feature_name_hint')}
              />
  )
}

export function Part2({ t, note, setNote }: { t: NonNullable<FeatureDialog['tr']>; note: NonNullable<FeatureDialog['note']>; setNote: NonNullable<FeatureDialog['setNote']> }) {
  return (
    <Textarea
                label={t('admin.res_admin_note')}
                value={note}
                rows={2}
                className="h-20 min-h-20"
                maxLength={256}
                onChange={e => setNote(e.target.value)}
              />
  )
}
