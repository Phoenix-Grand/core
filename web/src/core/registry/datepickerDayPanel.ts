/**
 * Datepicker day-panel extension point.
 *
 * When at least one provider is registered here - in practice, when the calendar
 * module is installed - the shared <DatePicker> grows a right-hand column that
 * lists the selected/hovered day's events. The column also folds in whatever sits
 * on CALENDAR_OVERLAY (e.g. tasks due that day), so it shows « events OR tasks ».
 *
 * Same neutral-core-contract idea as calendarOverlay.ts: no cross-module import.
 * A provider reuses the CalendarOverlayProvider shape (fetch a date range → items).
 * The string value is a stable channel name; a module may register with the raw
 * literal 'datepicker.day-panel' without importing this const (avoids an SDK
 * republish just to add a contributor).
 */
import type { CalendarOverlayProvider } from './calendarOverlay'

export const DATEPICKER_DAY_PANEL = 'datepicker.day-panel'
export type DatePickerDayPanelProvider = CalendarOverlayProvider
