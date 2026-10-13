// The shape of a module's declarative settings manifest once the core has
// resolved it for the current account (`GET /modules/:id/config`), plus the
// pure helpers the admin panel needs to render it.
//
// Everything after `editable_by_user` is PRESENTATION metadata declared by the
// module and forwarded verbatim by the core. All of it is optional: a module
// that declares none renders exactly as it did before these fields existed.
// That is the whole point of the pattern — a knob added in a `module.toml`
// shows up in the console, in the filter box and in the validation without a
// line of code changing on this side.

/**
 * One page of a module's administration surface, as the module declares it
 * (`[[setting_groups]]` in its manifest).
 *
 * A group sits ABOVE `category`: it is an entry of the admin menu under the
 * module and an address of its own (`/admin/modules/<module>/<id>`), and the
 * `category` of each of its settings becomes a tab inside it. `id` is a stable,
 * UNTRANSLATED slug because it travels in the URL — an address may not change
 * shape with the interface language.
 *
 * A module that declares none keeps the single page it has always had.
 */
export interface ModuleSettingGroup {
  id:           string
  label:        string
  /** Lucide icon name, resolved through `ICON_MAP`; unknown names show none. */
  icon?:        string | null
  /** Menu order. Already applied by the API, kept for readers that re-sort. */
  position?:    number | null
  /** One sentence, read at the top of the page. */
  description?: string | null
}

/** What the API says about a module's pages, in either spelling it may use. */
interface GroupCarrier {
  setting_groups?: ModuleSettingGroup[]
  groups?:         ModuleSettingGroup[]
}

/**
 * The declared pages of a module, in menu order — `[]` when it declares none.
 *
 * Tolerant of both field names the API may use and of a core that sends
 * neither: the module then reads as ungrouped, which is exactly the panel it
 * had before pages existed. An entry with no id is dropped rather than kept —
 * it could not be addressed, so it could not be opened.
 */
export function groupsOf(module: GroupCarrier | null | undefined): ModuleSettingGroup[] {
  const raw = module?.setting_groups ?? module?.groups
  return Array.isArray(raw) ? raw.filter(g => !!g && !!g.id) : []
}

export type Scope = 'global' | 'user' | 'overridable'
export type ValueType = 'bool' | 'int' | 'string' | 'enum'
export type Risk = 'info' | 'warning' | 'danger'
export type EnumOption = string | number | boolean | { value: unknown; label?: string }

export interface SettingItem {
  key: string; scope: Scope; type: ValueType; values: EnumOption[] | null
  label: string | null; description: string | null; category: string
  /**
   * Which PAGE of the module's panel this belongs to — a `[[setting_groups]]`
   * id of the same module. `null` (or absent) means ungrouped, which is what
   * every module declared before groups existed and what most still declare.
   */
  group?: string | null
  default: unknown; global: unknown; user: unknown; effective: unknown
  editable_by_user: boolean
  /** Rare/expert knob: folded behind the section's "Avancé" disclosure. */
  advanced?: boolean
  /** How loudly to warn before this changes. `danger` also asks to confirm. */
  risk?: Risk | null
  /** Bounds for `int`. Also enforced by the API — this is only the fast no. */
  min?: number | null
  max?: number | null
  /** Suffix shown after the field: "Mo", "s", "min", "‰". */
  unit?: string | null
  placeholder?: string | null
  /** The `string` value is a LIST, one entry per line → textarea. */
  multiline?: boolean
  /** Key of a `bool` setting of the same module gating this one. */
  depends_on?: string | null
}

/** Loose equality: values come back from JSON, so 25 and "25" mean the same. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null)
  }
  return String(a) === String(b)
}

export function normOptions(values: EnumOption[] | null): { value: unknown; label: string }[] {
  return (values ?? []).map(v =>
    v !== null && typeof v === 'object'
      ? { value: (v as { value: unknown }).value, label: String((v as { label?: string }).label ?? (v as { value: unknown }).value) }
      : { value: v, label: String(v) },
  )
}

/**
 * Is this value outside the bounds the module declared?
 *
 * An empty field is not "out of range", it is unfinished — reported as invalid
 * all the same, because an int setting saved as `""` would land in the database
 * as a string. Anything that is not an integer is refused for the same reason.
 */
export function outOfRange(item: SettingItem, value: unknown): boolean {
  if (item.type !== 'int') return false
  const raw = value === null || value === undefined ? '' : String(value).trim()
  if (raw === '') return true
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return true
  if (item.min !== null && item.min !== undefined && n < item.min) return true
  if (item.max !== null && item.max !== undefined && n > item.max) return true
  return false
}

/**
 * Non-empty entries of a list value.
 *
 * One per line is what the field asks for, but a value stored before the field
 * became multiline — or pasted from a configuration file — separates with
 * commas, and every module that reads such a list accepts both. The count has
 * to agree with what the module will actually read: showing "1 entrée" beside
 * `a.example,b.example` would simply be false.
 */
export function countEntries(value: unknown): number {
  if (value === null || value === undefined) return 0
  return String(value)
    .split(/[\n,]/)
    .filter(entry => entry.trim() !== '')
    .length
}

/**
 * Should this row be shown, given the current (edited) value of the boolean it
 * depends on?
 *
 * Hiding rather than greying is deliberate: a panel of seventy knobs has to get
 * SHORTER when a feature is switched off, otherwise turning something off makes
 * the page no easier to read. A `depends_on` that points at a setting this
 * account cannot see (a `global` one, for a non-admin) is ignored rather than
 * treated as false — never hide a row for a reason the reader cannot check.
 */
export function isVisible(
  item: SettingItem,
  valueOf: (key: string) => unknown,
  known: (key: string) => boolean,
): boolean {
  const parent = item.depends_on
  if (!parent || !known(parent)) return true
  return !!valueOf(parent)
}
