/**
 * The metadata model of the web `.kbview` element registry.
 *
 * Normative description: `vskubuno/docs/VIEWS-SPEC.md` (§9, "Element registry"). One `*.meta.ts`
 * table per component family describes each `.kbview` element the web target renders: its
 * canonical (desktop) name, its properties and events with the same names, kinds, defaults and
 * French documentation as the desktop registry, and a `web` block saying how the views runtime
 * reaches the React component (`@ui` / `@kubuno/sdk` export, prop and event mapping,
 * children → props adapters, DOM root contract for the designer).
 *
 * Every table is written `satisfies ElementMeta<ComponentProps<typeof X>>`, so a renamed or
 * retyped React prop breaks `tsc` instead of letting the metadata drift.
 *
 * This module (and every meta table) is PURE DATA: no React, no runtime import, only
 * `import type`. That is what lets `node` execute the tables directly (type stripping) in
 * `npm run build:registry`, without bundling the UI.
 */

// ── Shared enums (the desktop registry's own values: `kubuno-views` `registry::export`) ──

/** A property's value kind - serialized like serde's externally tagged `PropKind`. */
export type PropKind = 'Bool' | 'F32' | 'String' | { readonly Enum: readonly string[] }

/** Properties-window groups (the desktop's category names, English, translated by the designer). */
export type PropertyCategory =
  | 'Accessibility' | 'Appearance' | 'Behavior' | 'Data' | 'Design' | 'Focus' | 'Icon'
  | 'Layout' | 'Misc' | 'Paging' | 'Title Bar' | 'Window Style'

/** ⚡ tab groups (the desktop's event category names). */
export type EventCategory =
  | 'Action' | 'Appearance' | 'Behavior' | 'Data' | 'Drag Drop' | 'Focus' | 'Key' | 'Layout'
  | 'Mouse' | 'Property Changed'

/** What an element accepts as child elements. */
export type ChildrenModel = 'None' | 'SingleWidget' | 'List'

/** The layout engine a container applies to its children (`null`: none of its own). */
export type LayoutKind = 'Flow' | 'DockAnchor' | 'Split' | 'Tabs'

/** Toolbox tab - the desktop export's `family` values. */
export type Family =
  | 'core' | 'display' | 'choice' | 'text' | 'containers' | 'data' | 'docking' | 'navigation'
  | 'components' | 'ribbon'

/** Properties-window editor (`null`: the default editor for the kind). */
export type Editor =
  | 'icon' | 'image' | 'color' | 'font' | 'cursor' | 'list' | 'object'
  | `reference:${string}` | `class:${string}`

/** How a value written in `.kbview` becomes the React prop value. */
export type Converter =
  /** The value as typed by its kind (`Bool` → boolean, `F32` → number, `String` → string). */
  | 'identity'
  /** A Kubuno (Lucide) icon name → an icon element sized by `IconSize`, tinted by `IconColor`. */
  | 'icon-node'
  /** A Kubuno (Lucide) icon name → the Lucide component itself (`TabDef.icon`). */
  | 'icon-component'
  /** A boolean negated (`Enabled="false"` → `disabled`). */
  | 'invert'
  /** A CSS gradient string (`linear-gradient(…)`) ↔ the `Gradient` object of `@ui`. */
  | 'gradient-css'
  /** An element index (`SelectedIndex`) ↔ the key of the child item at that index. */
  | 'index-to-key'
  /** A `{Binding Path}` of a `Column` → a cell renderer and a sort accessor reading `row[Path]`. */
  | 'binding-cell'
  /** `SelectedValue` of a `RadioButton` → `checked` when it equals the element's `Value` (two-way: checking writes `Value`). */
  | 'equals-value'
  /** `false` → `null` (the prop drops its default content, `Callout` `icon`), `true` → prop omitted. */
  | 'null-when-false'
  /** An `x:Name` (`Popover.Target`) → a ref to that element's DOM root. */
  | 'element-ref'
  /** `StatusText` (texts separated by `|`) → the status bar row of `WorkspaceShell`. */
  | 'status-text'
  /** `Theme` enum → the `WORKSPACE_*` palette constants of `@kubuno/sdk`. */
  | 'workspace-theme'
  /** `ItemsSource` → the array prop, each bound item mapped through `DisplayMember`/`ValueMember`. */
  | 'items-source'
  /** `items-source`, plus each item's `Icon` name made an icon element (`Sidebar` rows from a list). */
  | 'items-source-icons'
  /** `true` → the host's translator (`setTranslator`) as the element's `t`: its own strings from the host's catalogue. */
  | 'host-t'

/**
 * How a `.kbview` property reaches the component when it is not a plain React prop: the views
 * runtime (`@kubuno/views`, WV-3) implements it around the component.
 */
export type RuntimeTarget =
  /** `Visible="false"`: the element is not rendered. */
  | 'visible'
  /** `Enabled="false"` on a component without a `disabled` prop: the DOM root is made inert. */
  | 'enabled'
  /** `aria-label` / `aria-describedby` / `role` on the DOM root. */
  | 'aria-label' | 'aria-description' | 'aria-role' | 'aria-hidden'
  /** `tabindex` on the DOM root (`TabIndex`, `TabStop`). */
  | 'tab-index' | 'tab-stop'
  /** The DOM root's `title` (the shell draws the Kubuno tooltip for it). */
  | 'tooltip'
  /** Opens the named `ContextMenu` (rendered with `MenuDropdown`) on right click / on click. */
  | 'context-menu' | 'drop-down-menu'
  /** Layout attributes resolved by the parent container (flow, grid, dock, absolute). */
  | 'layout'
  /** CSS `cursor`, `dir`, theme colour tokens on the DOM root. */
  | 'cursor' | 'direction' | 'theme-color'
  /** HTML5 drag-and-drop listeners (`AllowDrop`). */
  | 'allow-drop'
  /** Read by the designer and the code generator only. */
  | 'design'
  /** Kept on the control handle (`Tag`), never rendered. */
  | 'tag'
  /** Applied to the element's icon by the `icon-node` converter. */
  | 'icon-size' | 'icon-color' | 'icon-scaling'
  /** Web-only `Class` (Tailwind classes) merged into the component's `className`. */
  | 'class'
  /** Web-only interaction states and outline (WV-5a): `HoverBackColor`, `PressedBackColor`, `CornerRadius`, `BorderBrush`, `BorderThickness`, `Elevation`. */
  | 'hover-color' | 'pressed-color' | 'corner-radius' | 'border-brush' | 'border-thickness' | 'elevation'
  /** The view's root: the page / dialog title. */
  | 'view-title'
  /** Selects one of the element's `alternates` components (`TextField Variant`). */
  | 'component-variant'
  /** Fed to the `@ui` Tooltip of every element of the view (the `ToolTip` component). */
  | 'tooltip-options'
  /** Kept on the item for the runtime (`Repeater`-like keys, values read back by events). */
  | 'item-state'
  /**
   * An inherited member only some elements support: each one maps it in `inheritedMap`; on an
   * element that does not, the language server reports it as unavailable on the web.
   */
  | 'element-mapped'

/** How the runtime builds a handler's `(sender, e)` from a React callback's arguments. */
export type ArgsAdapter =
  /** No argument used: `e` is a bare `EventArgs`. */
  | 'none'
  /** The callback's first argument is the new value: `e.value`. */
  | 'value'
  /** The callback receives a change event: `e.value = event.target.value`. */
  | 'target-value'
  /** The callback receives a change event: `e.value = event.target.checked`. */
  | 'target-checked'
  /** A React mouse event: `MouseEventArgs` (button, x, y, clicks, modifiers). */
  | 'mouse'
  /** The callback receives the selected child's key: `e.value` = that child's index. */
  | 'key-to-index'
  /** The callback receives `(id, index)`: `e.value = index`. */
  | 'id-index'
  /** The callback receives the open item keys: `e.value` = whether this item is open. */
  | 'open-keys'
  /** An item's own callback (`Crumb.onClick`, `MenuItem.onClick`): `ItemEventArgs` of that item. */
  | 'item'
  /** The callback receives a row: `ItemActivateEventArgs` with its index. */
  | 'row'
  /** The callback receives the new sort: `e.value` = the sorted column's binding path. */
  | 'sort'
  /** The callback receives `(index, checked)`: `ItemCheckEventArgs` (`e.index`, `e.checked`, `e.value` = checked). */
  | 'item-check'
  /** DOM events listened to on the element's root by the runtime (common events). */
  | 'dom'
  /** A `PaintBox` paints: `PaintEventArgs` (the 2D context, the size in CSS px, the pixel ratio, the data). */
  | 'paint'

/** The common events the runtime listens to on the DOM root (no React prop needed). */
export type DomEvent =
  | 'click' | 'dblclick' | 'auxclick' | 'mousedown' | 'mouseup' | 'mousemove' | 'mouseenter'
  | 'mouseleave' | 'mousehover' | 'wheel' | 'keydown' | 'keypress' | 'keyup' | 'focusin'
  | 'focus' | 'focusout' | 'blur' | 'resize' | 'drop' | 'dragenter' | 'dragover' | 'dragleave' | 'submit'

// ── Type-level helpers: the compile-time link to the component's Props ──

type StringKeys<P> = Extract<keyof P, string>

/** Keys of `P` whose (non-null) value is a function - the callback props. */
export type CallbackKeys<P> = {
  [K in StringKeys<P>]-?: NonNullable<P[K]> extends (...args: never[]) => unknown ? K : never
}[StringKeys<P>]

/** Keys of `P` whose (non-null) value is an array - the data props children are adapted into. */
export type ArrayKeys<P> = {
  [K in StringKeys<P>]-?: NonNullable<P[K]> extends readonly unknown[] ? K : never
}[StringKeys<P>]

/** Keys of `P` whose value is a plain (non-array, non-function) object, like `action`. */
export type ObjectKeys<P> = {
  [K in StringKeys<P>]-?: NonNullable<P[K]> extends readonly unknown[]
    ? never
    : NonNullable<P[K]> extends (...args: never[]) => unknown
      ? never
      : NonNullable<P[K]> extends object ? K : never
}[StringKeys<P>]

/** Every key of every member of a union (`keyof (A | B)` only keeps the common ones). */
export type KeysOfUnion<T> = T extends unknown ? Extract<keyof T, string> : never

/** The value type of `K` in whichever union member declares it. */
type ValueOfUnion<T, K extends string> = T extends unknown ? (K extends keyof T ? T[K] : never) : never

/** A property written to a React prop (or to an item field), checked against `P`. */
export type PropToProp<P> = {
  [K in KeysOfUnion<P>]: {
    readonly prop: K
    readonly convert?: Converter
    /** `.kbview` enum value → the prop's value, checked against the prop's type. */
    readonly values?: Readonly<Record<string, NonNullable<ValueOfUnion<P, K>>>>
    /** The event that reports a user change of this value (two-way binding). */
    readonly change?: string
  }
}[KeysOfUnion<P>]

/** The object members of a field's type (`Partial<WindowAction> | false` → `Partial<WindowAction>`), functions and arrays left out. */
type ObjectPart<V> = Exclude<Extract<NonNullable<V>, object>, readonly unknown[] | ((...args: never[]) => unknown)>

/** Dotted paths one level into an object type (`confirm.label` of a window's `actions`). */
export type NestedKeys<T> = {
  [K in KeysOfUnion<T>]-?: [ObjectPart<ValueOfUnion<T, K>>] extends [never] ? never : `${K}.${KeysOfUnion<ObjectPart<ValueOfUnion<T, K>>>}`
}[KeysOfUnion<T>]

/** Dotted paths one level into an object type that end on a callback (`confirm.onClick`). */
export type NestedCallbackKeys<T> = {
  [K in KeysOfUnion<T>]-?: [ObjectPart<ValueOfUnion<T, K>>] extends [never] ? never : `${K}.${CallbackKeys<ObjectPart<ValueOfUnion<T, K>>>}`
}[KeysOfUnion<T>]

/** A property written to one field of an object prop (`ActionLabel` → `action.label`), or to a field of a field (`ConfirmText` → `actions.confirm.label`). */
export type PropToField<P> = {
  [K in ObjectKeys<P>]: {
    readonly prop: K
    readonly field: KeysOfUnion<NonNullable<P[K]>> | NestedKeys<NonNullable<P[K]>>
    readonly convert?: Converter
    /** `.kbview` enum value → the field's value. */
    readonly values?: Readonly<Record<string, string | number | boolean | null>>
  }
}[ObjectKeys<P>]

/** A property the views runtime applies around the component. */
export interface PropToRuntime {
  readonly runtime: RuntimeTarget
  readonly change?: string
}

export type PropTarget<P> = PropToProp<P> | PropToField<P> | PropToRuntime

/** An event raised from a callback prop (or a callback field of an object prop). */
export type EventFromProp<P> =
  | { readonly prop: CallbackKeys<P>; readonly args: ArgsAdapter }
  | {
      [K in ObjectKeys<P>]: {
        readonly prop: K
        readonly field: CallbackKeys<NonNullable<P[K]>> | NestedCallbackKeys<NonNullable<P[K]>>
        readonly args: ArgsAdapter
      }
    }[ObjectKeys<P>]
  | {
      [K in KeysOfUnion<P>]: NonNullable<ValueOfUnion<P, K>> extends (...args: never[]) => unknown
        ? { readonly prop: K; readonly args: ArgsAdapter }
        : never
    }[KeysOfUnion<P>]

/** An event the runtime raises itself (DOM listeners on the root, view lifecycle). */
export interface EventFromRuntime {
  readonly dom?: DomEvent
  /**
   * `view-*`: the view root's lifecycle; `parent-adapter`: an item's event raised by its parent's
   * children → props adapter (an `AccordionSection` toggled through `Accordion.onOpenChange`).
   */
  readonly runtime?: 'view-load' | 'view-shown' | 'view-unload' | 'parent-adapter' | 'menu-open'
  readonly args: ArgsAdapter
}

export type EventSource<P> = EventFromProp<P> | EventFromRuntime

// ── The metadata tables ──

/** One `.kbview` property - the desktop `PropertyJson` fields plus its web mapping. */
export interface PropertyMeta<P> {
  readonly name: string
  readonly kind: PropKind
  /** The default as written in `.kbview` (`""` when the property has no default). */
  readonly default: string
  readonly doc: string
  /** French user documentation (the Properties window shows it in a French Visual Studio). */
  readonly docFr: string
  readonly category: PropertyCategory
  readonly bindable?: boolean
  readonly localizable?: boolean
  readonly browsable?: boolean
  readonly editor?: Editor
  readonly typeConverter?: string
  /** `"Content"` for a property element slot (`<Card.Actions>`). */
  readonly serialization?: 'Visible' | 'Hidden' | 'Content'
  readonly designTime?: boolean
  readonly aliases?: readonly string[]
  /** Present on the web only (the conformance allowlist says why). */
  readonly webOnly?: boolean
  /** How the value reaches the React component. */
  readonly to: PropTarget<P>
}

/** One `.kbview` event - the desktop `EventJson` fields plus its web source. */
export interface EventMeta<P> {
  readonly name: string
  readonly doc: string
  readonly docFr: string
  readonly category: EventCategory
  /** The args type (`MouseEventArgs`, `ValueChangedEventArgs`…), a key of `EVENT_ARGS`. */
  readonly args: EventArgsName
  readonly aliases?: readonly string[]
  readonly browsable?: boolean
  readonly routing?: 'Direct' | 'Bubble'
  readonly from: EventSource<P>
}

/** What every children → prop adapter declares. */
interface ChildrenAdapter {
  /** The child element(s) adapted into the prop. */
  readonly item: string | readonly string[]
  /**
   * Where an item's own content (its child element) goes: an item field
   * (`AccordionSection` content → `content`), or `selected-after` - the runtime renders the
   * selected item's content after the component (`Tabs`, whose `@ui` component is the tab strip).
   */
  readonly content?: 'selected-after' | 'none' | { readonly field: string }
  /** The item field the runtime fills with a stable key (the child's `x:Name` or its index). */
  readonly key?: string
  /** The item field that receives an item's own items, recursively (`MenuItem` sub-menus → `items`). */
  readonly nested?: string
}

/**
 * Children → prop: an array prop (`<TabItem>` children → `Tabs.tabs[]`), or - `shape: 'record'` - an
 * object keyed by each child's key (`<DockPanel>` children → `DockArea.panels`).
 */
export type ChildrenToProp<P> =
  | { [K in ArrayKeys<P>]: ChildrenAdapter & { readonly prop: K; readonly shape?: 'array' } }[ArrayKeys<P>]
  | { [K in ObjectKeys<P>]: ChildrenAdapter & { readonly prop: K; readonly shape: 'record' } }[ObjectKeys<P>]

/** How the designer reaches the component's root DOM node (`data-kb-id`, layout map). */
export type DomRoot =
  /** The component forwards a ref (or spreads props) to its root element. */
  | 'ref'
  /** The runtime adds a layout-neutral wrapper (`display: contents` + measured child), design mode only. */
  | 'wrapper'
  /** The component renders through a portal: the designer maps the portal's root instead. */
  | 'portal'
  /** Not rendered (non-visual, or an item consumed by its parent's adapter). */
  | 'none'

/**
 * Another `@ui` component that renders the same element when some property has a given value
 * (`TextField Variant="Outlined"` → `OutlinedField`). Its maps are checked against ITS props;
 * a property or event missing from them is not available in that variant (language-server warning).
 */
export interface AlternateBinding<P> {
  /** The property values that select this component (all must match). */
  readonly when: Readonly<Record<string, string>>
  readonly module: '@ui' | '@kubuno/sdk'
  readonly export: string
  readonly domRoot: DomRoot
  readonly propMap: Readonly<Record<string, PropTarget<P>>>
  readonly eventMap: Readonly<Record<string, EventSource<P>>>
  readonly fixed?: Readonly<Partial<Record<KeysOfUnion<P>, string | number | boolean>>>
}

/** The `web` block: everything only the web compiler/runtime/designer reads. */
export interface WebBinding<P> {
  /** Components that replace the main one for some property values. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly alternates?: readonly AlternateBinding<any>[]
  /** Import specifier of the component (`null` for an item consumed by its parent). */
  /**
   * `@kubuno/views`: an element the views runtime renders itself (layout containers, `Repeater`); a
   * project path (`./AppTileGrid`, relative to the registry file): a project's own custom control.
   */
  readonly module: '@ui' | '@kubuno/sdk' | '@kubuno/views' | `./${string}` | null
  /** Named export of that module. */
  readonly export: string | null
  readonly domRoot: DomRoot
  /** Single child element → this prop (`Card` → `children`). */
  readonly content?: KeysOfUnion<P>
  readonly childrenToProp?: ChildrenToProp<P>
  /** Property elements (`<Card.Actions>…</Card.Actions>`) → ReactNode props. */
  readonly slots?: Readonly<Record<string, KeysOfUnion<P>>>
  /** For an item element: the parent element(s) whose adapter consumes it. */
  readonly itemOf?: readonly string[]
  /** Fixed props the runtime always passes (`IconButton` → no text). */
  readonly fixed?: Readonly<Partial<Record<KeysOfUnion<P>, string | number | boolean>>>
  /**
   * The children are an item template instantiated once per item of `ItemsSource` (`Repeater`); bindings
   * inside resolve against the row first (VIEWS-SPEC §6.1).
   */
  readonly template?: boolean
}

/** What the designer writes when the element is added from the Toolbox. */
export interface DesignDefaults {
  /** Attributes written on the new element (`Text="Bouton"`). */
  readonly attributes?: Readonly<Record<string, string>>
  /** Default size (DIP) when dropped into an absolute container. */
  readonly size?: readonly [number, number]
}

/** One `.kbview` element of the web target. */
export interface ElementMeta<P> {
  /** Canonical element name - the desktop name (VIEWS-SPEC §2). */
  readonly name: string
  readonly doc: string
  readonly docFr: string
  readonly family: Family
  /** The element's class then its ancestors, `Component` last (as the desktop exports it). */
  readonly baseChain: readonly string[]
  readonly children: ChildrenModel
  readonly allowedChildren?: readonly string[]
  readonly layoutKind?: LayoutKind | null
  readonly defaultEvent?: string | null
  /** `component`: non-visual (component tray). Default `control`. */
  readonly kind?: 'control' | 'component'
  /** Own properties (inherited levels come from `levels.ts`, per `baseChain`). */
  readonly properties: readonly PropertyMeta<P>[]
  /** Own events. */
  readonly events: readonly EventMeta<P>[]
  /** Overrides of inherited members' mapping (`Spinner`: `AccessibleName` → `label`). */
  readonly inheritedMap?: Readonly<Record<string, PropTarget<P>>>
  readonly designDefaults?: DesignDefaults
  readonly web: WebBinding<P>
}

/**
 * Erases the component type parameter once a table has been checked with `satisfies`, so the
 * tables of different components can live in one list.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyElementMeta = ElementMeta<any>

// ── Event args catalogue (shared names; chains as the desktop exports them) ──

export interface EventArgsInfo {
  /** The args type then its bases, `EventArgs` last. */
  readonly chain: readonly string[]
  /** Handlers write back into the args (`handled`, `cancel`). */
  readonly mutable: boolean
  readonly cancelable: boolean
}

export const EVENT_ARGS = {
  EventArgs: { chain: ['EventArgs'], mutable: false, cancelable: false },
  MouseEventArgs: { chain: ['MouseEventArgs', 'EventArgs'], mutable: false, cancelable: false },
  KeyEventArgs: { chain: ['KeyEventArgs', 'EventArgs'], mutable: true, cancelable: false },
  KeyPressEventArgs: { chain: ['KeyPressEventArgs', 'EventArgs'], mutable: true, cancelable: false },
  CancelEventArgs: { chain: ['CancelEventArgs', 'EventArgs'], mutable: true, cancelable: true },
  DragEventArgs: { chain: ['DragEventArgs', 'EventArgs'], mutable: false, cancelable: false },
  ValueChangedEventArgs: { chain: ['ValueChangedEventArgs', 'EventArgs'], mutable: false, cancelable: false },
  ItemEventArgs: { chain: ['ItemEventArgs', 'EventArgs'], mutable: false, cancelable: false },
  ItemActivateEventArgs: { chain: ['ItemActivateEventArgs', 'EventArgs'], mutable: false, cancelable: false },
  PaintEventArgs: { chain: ['PaintEventArgs', 'EventArgs'], mutable: false, cancelable: false },
  ItemCheckEventArgs: { chain: ['ItemCheckEventArgs', 'EventArgs'], mutable: false, cancelable: false },
} as const satisfies Record<string, EventArgsInfo>

export type EventArgsName = keyof typeof EVENT_ARGS
