/**
 * The parts of `AddDomainDialog.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Dropdown, Input } from "@ui"
import FieldLabel from "../resources/FieldLabel"
import type { AddDomainDialog } from './AddDomainDialog'

export function Part1({ t, name, setName }: { t: NonNullable<AddDomainDialog['tr']>; name: NonNullable<AddDomainDialog['name']>; setName: NonNullable<AddDomainDialog['setName']> }) {
  return (
    <Input
                label={t('admin.dom_field_name')}
                value={name}
                autoFocus
                maxLength={253}
                placeholder="exemple.fr"
                onChange={e => setName(e.target.value)}
                hint={t('admin.dom_field_name_hint')}
              />
  )
}

export function Part2({ t }: { t: NonNullable<AddDomainDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.dom_field_kind')}</FieldLabel>
  )
}

export function Part3({ Choice, t }: { Choice: AddDomainDialog['Choice']; t: NonNullable<AddDomainDialog['tr']> }) {
  return (
    <Choice value="secondary" title={t('admin.dom_kind_secondary')} description={t('admin.dom_kind_secondary_desc')} />
  )
}

export function Part4({ Choice, t }: { Choice: AddDomainDialog['Choice']; t: NonNullable<AddDomainDialog['tr']> }) {
  return (
    <Choice value="alias"     title={t('admin.dom_kind_alias')}     description={t('admin.dom_kind_alias_desc')} />
  )
}

export function Part5({ t }: { t: NonNullable<AddDomainDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.dom_field_parent')}</FieldLabel>
  )
}

export function Part6({ parent, t, parents, setParent }: { parent: NonNullable<AddDomainDialog['parent']>; t: NonNullable<AddDomainDialog['tr']>; parents: NonNullable<AddDomainDialog['parents']>; setParent: NonNullable<AddDomainDialog['setParent']> }) {
  return (
    <Dropdown
                      value={parent}
                      placeholder={t('admin.dom_field_parent_ph')}
                      options={parents.map(d => ({ value: d.id, label: d.name }))}
                      onChange={setParent}
                      width="100%"
                      height={36}
                      focusable
                    />
  )
}
