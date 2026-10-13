/**
 * The parts of `HolidayDialog.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Dropdown, Input } from "@ui"
import FieldLabel from "../resources/FieldLabel"
import { type Category, type Observance, type RuleKind, type RuleParams } from "./api"
import type { HolidayDialog } from './HolidayDialog'
const CATEGORIES: Category[] = [
  'public', 'bank', 'government', 'school', 'optional', 'half_day',
  'armed_forces', 'workday', 'observance',
]

const OBSERVANCES: Observance[] = [
  'none', 'next_workday', 'nearest_workday',
  'sunday_to_monday', 'saturday_to_monday', 'saturday_to_friday',
]

const KINDS: RuleKind[] = ['fixed', 'easter', 'nth_weekday', 'dates']

function defaultsFor(kind: RuleKind): RuleParams {
  switch (kind) {
    case 'fixed':       return { month: 1, day: 1 }
    case 'easter':      return { offset: 0, basis: 'gregorian' }
    case 'nth_weekday': return { month: 1, weekday: 1, nth: 1 }
    case 'dates':       return { dates: [] }
  }
}

export function Part1({ t, name, setName }: { t: NonNullable<HolidayDialog['tr']>; name: NonNullable<HolidayDialog['name']>; setName: NonNullable<HolidayDialog['setName']> }) {
  return (
    <Input
                label={t('admin.hol_day_name')}
                value={name}
                maxLength={200}
                autoFocus
                onChange={e => setName(e.target.value)}
              />
  )
}

export function Part2({ t }: { t: NonNullable<HolidayDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.hol_day_category')}</FieldLabel>
  )
}

export function Part3({ category, t, setCategory }: { category: NonNullable<HolidayDialog['category']>; t: NonNullable<HolidayDialog['tr']>; setCategory: NonNullable<HolidayDialog['setCategory']> }) {
  return (
    <Dropdown
                    value={category}
                    options={CATEGORIES.map(c => ({ value: c, label: t(`admin.hol_cat_${c}`) }))}
                    onChange={v => setCategory(v as Category)}
                    width="100%" height={36} focusable
                  />
  )
}

export function Part4({ t }: { t: NonNullable<HolidayDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.hol_day_kind')}</FieldLabel>
  )
}

export function Part5({ kind, t, setKind, setRule }: { kind: NonNullable<HolidayDialog['kind']>; t: NonNullable<HolidayDialog['tr']>; setKind: NonNullable<HolidayDialog['setKind']>; setRule: NonNullable<HolidayDialog['setRule']> }) {
  return (
    <Dropdown
                    value={kind}
                    options={KINDS.map(k => ({ value: k, label: t(`admin.hol_kind_${k}`) }))}
                    onChange={v => { const next = v as RuleKind; setKind(next); setRule(defaultsFor(next)) }}
                    width="100%" height={36} focusable
                  />
  )
}

export function Part6({ t }: { t: NonNullable<HolidayDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.hol_field_month')}</FieldLabel>
  )
}

export function Part7({ rule, months, setRule }: { rule: NonNullable<HolidayDialog['rule']>; months: NonNullable<HolidayDialog['months']>; setRule: NonNullable<HolidayDialog['setRule']> }) {
  return (
    <Dropdown
                      value={String(rule.month ?? 1)}
                      options={months}
                      onChange={v => setRule({ ...rule, month: Number(v) })}
                      width="100%" height={36} focusable
                    />
  )
}

export function Part8({ t }: { t: NonNullable<HolidayDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.hol_field_basis')}</FieldLabel>
  )
}

export function Part9({ rule, t, setRule }: { rule: NonNullable<HolidayDialog['rule']>; t: NonNullable<HolidayDialog['tr']>; setRule: NonNullable<HolidayDialog['setRule']> }) {
  return (
    <Dropdown
                      value={rule.basis ?? 'gregorian'}
                      options={[
                        { value: 'gregorian', label: t('admin.hol_basis_gregorian') },
                        { value: 'julian',    label: t('admin.hol_basis_julian') },
                      ]}
                      onChange={v => setRule({ ...rule, basis: v as 'gregorian' | 'julian' })}
                      width="100%" height={36} focusable
                    />
  )
}

export function Part10({ t }: { t: NonNullable<HolidayDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.hol_field_rank')}</FieldLabel>
  )
}

export function Part11({ rule, t, setRule }: { rule: NonNullable<HolidayDialog['rule']>; t: NonNullable<HolidayDialog['tr']>; setRule: NonNullable<HolidayDialog['setRule']> }) {
  return (
    <Dropdown
                      value={String(rule.nth ?? 1)}
                      options={[
                        { value: '1',  label: t('admin.hol_rank_1') },
                        { value: '2',  label: t('admin.hol_rank_2') },
                        { value: '3',  label: t('admin.hol_rank_3') },
                        { value: '4',  label: t('admin.hol_rank_4') },
                        { value: '5',  label: t('admin.hol_rank_5') },
                        { value: '-1', label: t('admin.hol_rank_last') },
                      ]}
                      onChange={v => setRule({ ...rule, nth: Number(v) })}
                      width="100%" height={36} focusable
                    />
  )
}

export function Part12({ t }: { t: NonNullable<HolidayDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.hol_field_weekday')}</FieldLabel>
  )
}

export function Part13({ rule, weekdays, setRule }: { rule: NonNullable<HolidayDialog['rule']>; weekdays: NonNullable<HolidayDialog['weekdays']>; setRule: NonNullable<HolidayDialog['setRule']> }) {
  return (
    <Dropdown
                      value={String(rule.weekday ?? 1)}
                      options={weekdays}
                      onChange={v => setRule({ ...rule, weekday: Number(v) })}
                      width="100%" height={36} focusable
                    />
  )
}

export function Part14({ t }: { t: NonNullable<HolidayDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.hol_field_month')}</FieldLabel>
  )
}

export function Part15({ rule, months, setRule }: { rule: NonNullable<HolidayDialog['rule']>; months: NonNullable<HolidayDialog['months']>; setRule: NonNullable<HolidayDialog['setRule']> }) {
  return (
    <Dropdown
                      value={String(rule.month ?? 1)}
                      options={months}
                      onChange={v => setRule({ ...rule, month: Number(v) })}
                      width="100%" height={36} focusable
                    />
  )
}

export function Part16({ t }: { t: NonNullable<HolidayDialog['tr']> }) {
  return (
    <FieldLabel htmlFor="hol-dates">{t('admin.hol_field_dates')}</FieldLabel>
  )
}

export function Part17({ datesText, setDatesText }: { datesText: NonNullable<HolidayDialog['datesText']>; setDatesText: NonNullable<HolidayDialog['setDatesText']> }) {
  return (
    <textarea
                    id="hol-dates"
                    value={datesText}
                    onChange={e => setDatesText(e.target.value)}
                    rows={5}
                    spellCheck={false}
                    className="w-full rounded border border-border bg-surface-0 p-2 font-mono text-text-primary"
                    style={{ fontSize: 'var(--kb-text-body)' }}
                    placeholder={'2026-03-20\n2027-03-09'}
                  />
  )
}

export function Part18({ t }: { t: NonNullable<HolidayDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.hol_field_observance')}</FieldLabel>
  )
}

export function Part19({ observance, t, setObservance }: { observance: NonNullable<HolidayDialog['observance']>; t: NonNullable<HolidayDialog['tr']>; setObservance: NonNullable<HolidayDialog['setObservance']> }) {
  return (
    <Dropdown
                    value={observance}
                    options={OBSERVANCES.map(o => ({ value: o, label: t(`admin.hol_obs_${o}`) }))}
                    onChange={v => setObservance(v as Observance)}
                    width="100%" height={36} focusable
                  />
  )
}

export function Part20({ t, fromYear, setFromYear }: { t: NonNullable<HolidayDialog['tr']>; fromYear: NonNullable<HolidayDialog['fromYear']>; setFromYear: NonNullable<HolidayDialog['setFromYear']> }) {
  return (
    <Input
                  label={t('admin.hol_field_from_year')}
                  value={fromYear}
                  inputMode="numeric"
                  maxLength={4}
                  onChange={e => setFromYear(e.target.value.replace(/\D/g, ''))}
                />
  )
}

export function Part21({ t, toYear, setToYear }: { t: NonNullable<HolidayDialog['tr']>; toYear: NonNullable<HolidayDialog['toYear']>; setToYear: NonNullable<HolidayDialog['setToYear']> }) {
  return (
    <Input
                  label={t('admin.hol_field_to_year')}
                  value={toYear}
                  inputMode="numeric"
                  maxLength={4}
                  onChange={e => setToYear(e.target.value.replace(/\D/g, ''))}
                />
  )
}

export function Part22({ t }: { t: NonNullable<HolidayDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.hol_preview')}</FieldLabel>
  )
}
