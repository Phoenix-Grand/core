/**
 * Registre d'extension générique : permet à un module d'EXPOSER un point
 * d'extension (par une simple chaîne) que N'IMPORTE QUEL autre module peut
 * enrichir/surcharger, sans dépendance croisée codée en dur.
 *
 * Le module « hôte » lit `getAll(point)` ; les modules « extenseurs » appellent
 * `register(point, moduleId, entry)` dans leur register.ts. Si l'hôte n'est pas
 * chargé, les enregistrements restent simplement inertes (et inversement).
 *
 * Exemple : calendar expose `'calendar.calendar-overlay'` et affiche les items
 * fournis ; tasks s'y branche pour superposer ses échéances - calendar ne contient
 * aucune référence à tasks.
 */
const points = new Map<string, Map<string, unknown>>()

export const ExtensionRegistry = {
  /** Enregistre (ou remplace) la contribution d'un module à un point d'extension. */
  register(point: string, moduleId: string, entry: unknown): void {
    const map = points.get(point) ?? new Map<string, unknown>()
    map.set(moduleId, entry)
    points.set(point, map)
  },

  /** Retire la contribution d'un module. */
  unregister(point: string, moduleId: string): void {
    points.get(point)?.delete(moduleId)
  },

  /** Toutes les contributions enregistrées pour un point (ordre d'insertion). */
  getAll<T = unknown>(point: string): T[] {
    const map = points.get(point)
    return map ? Array.from(map.values()) as T[] : []
  },
}
