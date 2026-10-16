/**
 * Contrat d'extension du calendrier (point d'extension exposé par calendar).
 *
 * N'importe quel module peut superposer des items datés sur la grille du
 * module calendar en enregistrant un `CalendarOverlayProvider` via
 * `ExtensionRegistry.register(CALENDAR_OVERLAY, '<moduleId>', provider)`.
 * Calendar lit `ExtensionRegistry.getAll(CALENDAR_OVERLAY)` et affiche les items -
 * sans aucune connaissance des modules contributeurs.
 *
 * Le contrat vit dans le core (lieu neutre) pour que calendar et les modules
 * contributeurs n'aient aucune dépendance d'import croisée.
 */
export const CALENDAR_OVERLAY = 'calendar.calendar-overlay'

export interface CalendarOverlayItem {
  id:     string
  /** Jour d'affichage au format 'yyyy-MM-dd'. */
  date:   string
  title:  string
  /** Couleur de l'accent (sinon une couleur neutre). */
  color?: string
  /** Affichage barré (item terminé). */
  done?:  boolean
  /** Route SPA ouverte au clic (ex: '/tasks/boards/<id>'). */
  link?:  string
}

export interface CalendarOverlayProvider {
  /** Items à superposer entre `fromISO` et `toISO` (bornes ISO). */
  fetch: (fromISO: string, toISO: string) => Promise<CalendarOverlayItem[]>
}
