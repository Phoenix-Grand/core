/**
 * Types of the web `.kbview` compiler's results - the JSON produced by `kubuno-views-web` (Rust, WASM).
 * Field names follow the Rust structs (snake_case where serde keeps them). The plan itself is described
 * normatively in `vskubuno/docs/WEB-VIEWS.md` §13 ("WV-2 as built"); the runtime (`@kubuno/views`) has
 * its own, authoritative, plan types.
 */

/** What to compile. */
export interface CompileOptions {
  /** The view file, relative to the project root, `/`-separated (`src/NotesSettingsPage.kbview`). */
  file: string
  /** The code-behind as imported from the view's folder (`./NotesSettingsPage`); `null` = none. */
  code_behind?: string | null
  /** The class the code-behind exports (default: the file stem). */
  class_name?: string | null
  /** Keep design-time values (`d:` attributes, `DesignWidth`/`DesignHeight`) in the plan. */
  design?: boolean
}

export type Severity = 'error' | 'warning' | 'info'

/** A problem of a view, 1-based line / UTF-16 column. */
export interface Diagnostic {
  severity: Severity
  code: string
  message: string
  line: number
  column: number
  end_line: number
  end_column: number
}

/** `[line, column]`, 1-based, UTF-16 columns. */
export type At = [number, number]

export interface PlanBinding {
  path: string
  mode: 'OneWay' | 'TwoWay' | 'OneTime' | 'OneWayToSource'
  trigger?: 'LostFocus' | 'Explicit'
  conv?: string
  param?: string
  fallback?: string
  format?: string
  null?: string
  culture?: string
  depth?: number
  at: At
}

/** One argument of a `{Res key, Name=value}` (WV-6): a literal or a one-way binding. */
export interface PlanResArg {
  n: string
  v?: string
  b?: PlanBinding
}

/** A `{Res key[, Source=set][, Name=value]…}`. */
export interface PlanRes {
  key: string
  set?: string
  args?: PlanResArg[]
}

export interface PlanProp {
  n: string
  to: { prop?: string; field?: string; runtime?: string; convert?: string; values?: Record<string, unknown>; change?: string }
  v?: unknown
  b?: PlanBinding
  res?: PlanRes
  kind: 'Bool' | 'F32' | 'String' | 'Enum'
  at: At
}

export interface PlanEvent {
  n: string
  h: string
  from: { prop?: string; field?: string; dom?: string; runtime?: string; args: string }
  args_type: string
  at: At
}

export interface PlanNode {
  id: string
  el: string
  name?: string
  at: At
  m?: string
  x?: string
  dom?: string
  kind?: 'user_control'
  fixed?: Record<string, unknown>
  props?: PlanProp[]
  events?: PlanEvent[]
  children?: PlanNode[]
  content?: string
  slots?: Record<string, PlanNode[]>
  items?: { prop: string; shape: string; content?: unknown; key?: string; nested?: string; list: PlanNode[] }
  template?: boolean
  sc?: Record<string, PlanProp[]>
  design?: PlanProp[]
}

export interface Plan {
  abi: number
  file: string
  kind: 'view' | 'control'
  root: PlanNode
  tray?: PlanNode[]
  names: Record<string, string>
  handlers: string[]
  design_size?: [number, number]
}

/** One mapped span of a check file (generated line/columns → `.kbview` range). */
export interface CheckSpan {
  line: number
  start: number
  end: number
  src: At
  src_end: At
  exact: boolean
  what: string
}

export interface NameInfo {
  name: string
  element: string
  id: string
  handle: string
  at: At
}

export interface HandlerUse {
  name: string
  event: string
  element: string
  sender: string
  args: string
  at: At
  end: At
}

/** Everything one compile produces. */
export interface CompileOutput {
  ok: boolean
  diagnostics: Diagnostic[]
  plan: Plan | null
  dts: string
  check: string
  check_map: CheckSpan[]
  names: NameInfo[]
  handlers: HandlerUse[]
  class_name: string
  abi: number
  compiler: string
}

/**
 * One member of a user control's `x:Props` type (WV-7), extracted from its code-behind: a bindable
 * property (a non-function field) or an event (a function field).
 */
export interface UserControlProp {
  /** The field name, verbatim - the React prop the compiled control reads (`file`, `onOpen`). */
  name: string
  /** The field is a function type: it becomes an event (`onOpen` → `OnOpen`), not a bindable property. */
  event: boolean
  /** For a property: the broad value category used to type-check its bindings. */
  kind?: 'string' | 'number' | 'boolean' | 'array' | 'object'
  /** For an event: how the handler's args are built (`value` = first argument as `e.value`, `none` = no args). */
  args?: 'value' | 'none'
}

/** A user control of the project: `<MessageRow/>` for `MessageRow.kbcontrol`. */
export interface UserControlRef {
  name: string
  /** Project-root-relative module (`/src/MessageRow`), rendered by its default export. */
  module: string
  /** The members of its `x:Props` type (WV-7); absent when it declares none (pass-through). */
  props?: UserControlProp[]
}
