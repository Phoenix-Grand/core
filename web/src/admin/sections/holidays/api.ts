// Data access of the holiday referential.
//
// Three cache entries: the counters, the list of territories, and one
// territory's days. They are kept apart because they are read at different
// moments - the list is a long inventory, a territory's days are a page - but
// every mutation invalidates all three: enabling a country changes a counter,
// and editing a day changes the "corrigées" count on the list behind it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../core/api/client'
import i18n from '../../../core/i18n'

/** The language the console is being read in - sent with every read, because a
 *  territory's name and a holiday's name are both translated server-side. */
const locale = () => i18n.language || 'en'

export const OVERVIEW_KEY  = ['admin-holidays-overview'] as const
export const CALENDARS_KEY = ['admin-holiday-calendars'] as const
export const CALENDAR_KEY  = ['admin-holiday-calendar'] as const

/** The rule grammar, mirroring `holidays::model::Rule` server-side. */
export type RuleKind = 'fixed' | 'easter' | 'nth_weekday' | 'dates'

export type Observance =
  | 'none' | 'next_workday' | 'nearest_workday'
  | 'sunday_to_monday' | 'saturday_to_monday' | 'saturday_to_friday'

export type Category =
  | 'public' | 'bank' | 'government' | 'school' | 'optional'
  | 'half_day' | 'armed_forces' | 'workday' | 'observance'

export interface RuleParams {
  month?:   number
  day?:     number
  offset?:  number
  basis?:   'gregorian' | 'julian'
  weekday?: number
  nth?:     number
  dates?:   string[]
}

export interface HolidayCalendar {
  id:            string
  code:          string
  country_code:  string | null
  subdivision:   string | null
  parent_id:     string | null
  name:          string
  names:         Record<string, string>
  is_builtin:    boolean
  enabled:       boolean
  coverage_from: number | null
  coverage_to:   number | null
}

export interface CalendarSummary extends HolidayCalendar {
  holiday_count:     number
  inherited_count:   number
  overridden_count:  number
  subdivision_count: number
  /** The name in the console's language - what the list sorts and shows. */
  display_name:      string
}

export interface HolidayDate {
  date:          string
  observed_from: string | null
}

export interface Holiday {
  id:            string
  calendar_id:   string
  key:           string
  name:          string
  display_name:  string
  names:         Record<string, string>
  category:      Category
  kind:          RuleKind
  rule:          RuleParams
  observance:    Observance
  from_year:     number | null
  to_year:       number | null
  color:         string | null
  enabled:       boolean
  is_builtin:    boolean
  is_overridden: boolean
  is_orphan:     boolean
  /** Comes from the country calendar, not from this one. */
  inherited:     boolean
  /** This regional calendar explicitly does not observe it. */
  excluded:      boolean
  /** What the rule produces in the previewed year. */
  dates:         HolidayDate[]
}

export interface CalendarDetail {
  calendar:     HolidayCalendar
  display_name: string
  parent:       { id: string; code: string; name: string } | null
  year:         number
  holidays:     Holiday[]
  exclusions:   string[]
}

export interface HolidaysOverview {
  calendars:          number
  countries:          number
  disabled_calendars: number
  holidays:           number
  overridden:         number
  custom:             number
  orphans:            number
  unit_prefs:         number
  dataset_loaded:     string | null
  dataset_shipped:    string
}

export function useHolidaysOverview() {
  return useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn:  async () => (await api.get<HolidaysOverview>('/admin/holidays/overview')).data,
  })
}

export function useHolidayCalendars(search: string, countriesOnly: boolean) {
  return useQuery({
    queryKey: [...CALENDARS_KEY, search, countriesOnly, locale()],
    queryFn:  async () => (await api.get<{ calendars: CalendarSummary[] }>(
      '/admin/holidays/calendars',
      { params: { search: search || undefined, countries_only: countriesOnly || undefined, locale: locale() } },
    )).data.calendars,
    // The list is long and rarely changes under the operator's feet; keeping the
    // previous page visible while a new search resolves is what makes typing in
    // the filter feel like filtering rather than reloading.
    placeholderData: previous => previous,
  })
}

export function useCalendarDetail(id: string | null, year: number) {
  return useQuery({
    queryKey: [...CALENDAR_KEY, id, year, locale()],
    enabled:  !!id,
    queryFn:  async () => (await api.get<CalendarDetail>(
      `/admin/holidays/calendars/${id}`, { params: { year, locale: locale() } },
    )).data,
  })
}

/** Every read of this section, after any write. */
function useInvalidateAll() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: OVERVIEW_KEY })
    qc.invalidateQueries({ queryKey: CALENDARS_KEY })
    qc.invalidateQueries({ queryKey: CALENDAR_KEY })
  }
}

export interface HolidayInput {
  name:       string
  names?:     Record<string, string>
  category:   Category
  kind:       RuleKind
  rule:       RuleParams
  observance: Observance
  from_year:  number | null
  to_year:    number | null
  color:      string | null
}

export function useCreateHoliday(calendarId: string) {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: async (input: HolidayInput) =>
      (await api.post(`/admin/holidays/calendars/${calendarId}/holidays`, input)).data,
    onSuccess: invalidate,
  })
}

export function useUpdateHoliday() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: HolidayInput }) =>
      (await api.patch(`/admin/holidays/days/${id}`, input)).data,
    onSuccess: invalidate,
  })
}

export function useSetHolidayEnabled() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      (await api.patch(`/admin/holidays/days/${id}/enabled`, { enabled })).data,
    onSuccess: invalidate,
  })
}

export function useDeleteHoliday() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/holidays/days/${id}`)).data,
    onSuccess: invalidate,
  })
}

export function useResetHoliday() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: async (id: string) => (await api.post(`/admin/holidays/days/${id}/reset`)).data,
    onSuccess: invalidate,
  })
}

export function useSetCalendarEnabled() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      (await api.patch(`/admin/holidays/calendars/${id}`, { enabled })).data,
    onSuccess: invalidate,
  })
}

export function useRenameCalendar() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) =>
      (await api.patch(`/admin/holidays/calendars/${id}`, { name })).data,
    onSuccess: invalidate,
  })
}

export function useCreateCalendar() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: async (input: { name: string; code?: string; country_code?: string }) =>
      (await api.post<{ id: string; code: string }>('/admin/holidays/calendars', input)).data,
    onSuccess: invalidate,
  })
}

export function useDeleteCalendar() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/holidays/calendars/${id}`)).data,
    onSuccess: invalidate,
  })
}

/** The whole exclusion set of a regional calendar, never a delta. */
export function useSetExclusions(calendarId: string) {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: async (keys: string[]) =>
      (await api.put(`/admin/holidays/calendars/${calendarId}/exclusions`, { keys })).data,
    onSuccess: invalidate,
  })
}

export function useReloadDataset() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: async () => (await api.post('/admin/holidays/reload')).data,
    onSuccess: invalidate,
  })
}

export interface PreviewDate { year: number; date: string; observed_from: string | null }

/**
 * The dates a rule being written produces - computed by the server.
 *
 * Deliberately not reimplemented in TypeScript: the expander *is* the definition
 * of what a rule means, and a second implementation here would be a second
 * answer, free to disagree with the one that actually feeds the modules.
 */
export function usePreviewRule() {
  return useMutation({
    mutationFn: async (input: { kind: RuleKind; rule: RuleParams; observance: Observance; years?: number[] }) =>
      (await api.post<{ dates: PreviewDate[] }>('/admin/holidays/preview', input)).data.dates,
  })
}

/** The organisational-unit overlay. */
export interface UnitPref {
  id:            string
  calendar_id:   string | null
  holiday_id:    string | null
  enabled:       boolean
  calendar_code: string | null
  calendar_name: string | null
  holiday_name:  string | null
  holiday_calendar_code: string | null
}

export function useUnitOverlay(unitId: string | null) {
  return useQuery({
    queryKey: ['admin-holiday-unit', unitId],
    enabled:  !!unitId,
    queryFn:  async () => (await api.get<{ prefs: UnitPref[] }>(
      `/admin/holidays/units/${unitId}`)).data.prefs,
  })
}

export function useSetUnitPref(unitId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { calendar_id?: string; holiday_id?: string; enabled: boolean | null }) =>
      (await api.put(`/admin/holidays/units/${unitId}`, input)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-holiday-unit', unitId] }) },
  })
}

/** One implementation, shared: reading the failure of a request is the same
 *  problem everywhere. Re-exported under the name this section's callers
 *  already use. */
export { apiErrorMessage as errorMessage } from '../../../core/api/errorMessage'
