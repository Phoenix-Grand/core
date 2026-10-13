/**
 * The parts of `UnitsTab.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Building2, Plus, X } from "lucide-react"
import { Button, Dropdown } from "@ui"
import FieldLabel from "../resources/FieldLabel"
import type { UnitsTab } from './UnitsTab'

export function Part1({ t }: { t: NonNullable<UnitsTab['tr']> }) {
  return (
    <FieldLabel>{t('admin.hol_units_pick')}</FieldLabel>
  )
}

export function Part2({ setPicking, unitName, t }: { setPicking: NonNullable<UnitsTab['setPicking']>; unitName: NonNullable<UnitsTab['unitName']>; t: NonNullable<UnitsTab['tr']> }) {
  return (
    <Button variant="secondary" onClick={() => setPicking(true)}>
                <Building2 size={16} /> {unitName || t('admin.hol_units_none')}
              </Button>
  )
}

export function Part3({ t }: { t: NonNullable<UnitsTab['tr']> }) {
  return (
    <FieldLabel>{t('admin.hol_units_add')}</FieldLabel>
  )
}

export function Part4({ adding, t, calendars, setAdding }: { adding: NonNullable<UnitsTab['adding']>; t: NonNullable<UnitsTab['tr']>; calendars: UnitsTab['calendars']; setAdding: NonNullable<UnitsTab['setAdding']> }) {
  return (
    <Dropdown
                    value={adding}
                    placeholder={t('admin.hol_units_pick_calendar')}
                    options={(calendars ?? []).map(c => ({ value: c.id, label: `${c.display_name} (${c.code})` }))}
                    onChange={setAdding}
                    width={280}
                    height={36}
                    focusable
                  />
  )
}

export function Part5({ adding, setPref, setError, setAdding, fail, t }: { adding: NonNullable<UnitsTab['adding']>; setPref: NonNullable<UnitsTab['setPref']>; setError: NonNullable<UnitsTab['setError']>; setAdding: NonNullable<UnitsTab['setAdding']>; fail: UnitsTab['fail']; t: NonNullable<UnitsTab['tr']> }) {
  return (
    <Button
                    variant="secondary"
                    disabled={adding === '' || setPref.isPending}
                    onClick={() => {
                      setError(null)
                      // Added as "observed here": the useful default, since a unit
                      // that is being given a second territory wants to see it.
                      setPref.mutate({ calendar_id: adding, enabled: true }, {
                        onSuccess: () => setAdding(''),
                        onError: fail,
                      })
                    }}
                  >
                    <Plus size={16} /> {t('admin.hol_units_add_action')}
                  </Button>
  )
}

export function Part6({ t, setError, setPref, pref, fail }: { t: NonNullable<UnitsTab['tr']>; setError: NonNullable<UnitsTab['setError']>; setPref: NonNullable<UnitsTab['setPref']>; pref: NonNullable<UnitsTab['rows_items']>[number]['pref']; fail: UnitsTab['fail'] }) {
  return (
    <Button
                      variant="ghost"
                      aria-label={t('admin.hol_units_clear')}
                      title={t('admin.hol_units_clear')}
                      onClick={() => {
                        setError(null)
                        // `null` deletes the row — the unit goes back to inheriting,
                        // rather than storing what it currently inherits.
                        setPref.mutate({
                          calendar_id: pref.calendar_id ?? undefined,
                          holiday_id:  pref.holiday_id ?? undefined,
                          enabled: null,
                        }, { onError: fail })
                      }}
                    >
                      <X size={16} />
                    </Button>
  )
}
