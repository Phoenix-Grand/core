/**
 * The parts of `RoleCreateDialog.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Input, Textarea } from "@ui"
import FieldLabel from "../sections/resources/FieldLabel"
import type { RoleCreateDialog } from './RoleCreateDialog'
function slugify(value: string): string {
  return value
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

export function Part1({ t, name, setName, slugTouched, setSlug }: { t: NonNullable<RoleCreateDialog['tr']>; name: NonNullable<RoleCreateDialog['name']>; setName: NonNullable<RoleCreateDialog['setName']>; slugTouched: NonNullable<RoleCreateDialog['slugTouched']>; setSlug: NonNullable<RoleCreateDialog['setSlug']> }) {
  return (
    <Input
                  label={<>{t('admin.role_name')}<span className="text-danger ml-0.5">*</span></>}
                  value={name}
                  onChange={e => {
                    setName(e.target.value)
                    if (!slugTouched) setSlug(slugify(e.target.value))
                  }}
                  placeholder={t('admin.role_name_ph')}
                  required
                />
  )
}

export function Part2({ t, description, setDescription }: { t: NonNullable<RoleCreateDialog['tr']>; description: NonNullable<RoleCreateDialog['description']>; setDescription: NonNullable<RoleCreateDialog['setDescription']> }) {
  return (
    <Textarea
                label={t('admin.roles_col_desc')}
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={2}
                placeholder={t('admin.role_desc_ph')}
              />
  )
}

export function Part3({ t }: { t: NonNullable<RoleCreateDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.roles_privileges')}</FieldLabel>
  )
}
