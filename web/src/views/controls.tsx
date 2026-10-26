/**
 * Runtime-provided elements and helpers: `Repeater` (rendered by the renderer as a template), the
 * non-visual tray components `Timer`, `Query`, `Mutation`, `ReactHost` (the migration escape hatch),
 * `defineControl` (custom controls: a React component + its element metadata), `MessageBox` and
 * `Dialog` (on top of the host's `ConfirmDialog` / `FloatingWindow`, never browser dialogs).
 */
import { createElement, useEffect, useRef, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { useMutation, useQuery } from '@tanstack/react-query'

import { registerElements, resolveComponent } from './resolve'
import { notify, type Internals } from './view'

/** A `Repeater`'s children are an item template: the renderer instantiates them per item. */
export function Repeater({ children }: { children?: ReactNode }): ReactNode {
  return children ?? null
}

/** Context of the tray components: the view they belong to and their element id. */
export interface TrayProps {
  /** @internal */ __view?: Internals
  /** @internal */ __id?: string
}

function setOverride(i: Internals | undefined, id: string | undefined, values: Record<string, unknown>): void {
  if (!i || id === undefined) return
  let o = i.overrides.get(id)
  if (!o) i.overrides.set(id, (o = new Map()))
  let changed = false
  for (const [k, v] of Object.entries(values)) {
    if (!Object.is(o.get(k), v)) {
      o.set(k, v)
      changed = true
    }
  }
  if (changed) notify(i)
}

/** `<Timer Interval="1000" Enabled="true" OnTick="tick"/>`: raises `onTick` every `interval` ms while enabled. */
export function Timer({ interval = 100, enabled = false, onTick }: { interval?: number; enabled?: boolean; onTick?: () => void }): null {
  const tick = useRef(onTick)
  tick.current = onTick
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => tick.current?.(), Math.max(1, interval))
    return () => clearInterval(id)
  }, [enabled, interval])
  return null
}

/** The handle of a `<Query x:Name="q">`: `{Binding q.data…}`, `q.isLoading`, `await this.q.refetch()`. */
export interface QueryHandle<T = unknown> {
  readonly data: T | undefined
  readonly isLoading: boolean
  readonly isError: boolean
  readonly error: unknown
  refetch(): Promise<unknown>
}

/** The handle of a `<Mutation x:Name="m">`: `await this.m.run(args)`. */
export interface MutationHandle<A = unknown, R = unknown> {
  readonly isPending: boolean
  readonly error: unknown
  run(args: A): Promise<R>
}

/**
 * `<Query Key="weather-locations, {Binding city}" Fetch="load_locations"/>`: a React Query query whose
 * function is a code-behind method; its state is the element's handle.
 */
export function Query({ queryKey, fetch, enabled = true, staleTime, __view, __id }: { queryKey?: unknown; fetch?: () => Promise<unknown>; enabled?: boolean; staleTime?: number } & TrayProps): null {
  const key = Array.isArray(queryKey) ? queryKey : String(queryKey ?? '').split(',').map((s) => s.trim())
  const fn = useRef(fetch)
  fn.current = fetch
  const q = useQuery({ queryKey: key, queryFn: () => (fn.current ? fn.current() : Promise.resolve(null)), enabled: enabled && !__view?.design, staleTime })
  useEffect(() => {
    setOverride(__view, __id, { Data: q.data, IsLoading: q.isLoading, IsError: q.isError, Error: q.error, Refetch: q.refetch })
  }, [__view, __id, q.data, q.isLoading, q.isError, q.error, q.refetch])
  return null
}

/** `<Mutation Run="add_location" Invalidates="weather-locations"/>`. */
export function Mutation({ run, invalidates, __view, __id }: { run?: (args: unknown) => Promise<unknown>; invalidates?: string } & TrayProps): null {
  const fn = useRef(run)
  fn.current = run
  const m = useMutation({
    mutationFn: (args: unknown) => {
      if (__view?.design) return Promise.reject(new Error('[views] mutations never run in design mode'))
      return fn.current ? fn.current(args) : Promise.resolve(null)
    },
    meta: invalidates ? { invalidates: invalidates.split(',').map((s) => s.trim()) } : undefined,
  })
  useEffect(() => {
    setOverride(__view, __id, { IsPending: m.isPending, Error: m.error, Run: m.mutateAsync })
  }, [__view, __id, m.isPending, m.error, m.mutateAsync])
  return null
}

/** `<ReactHost Component="{Binding editor}" Props="{Binding editorProps}"/>`: any React component. */
export function ReactHost({ component, props }: { component?: ComponentType<Record<string, unknown>>; props?: Record<string, unknown> }): ReactNode {
  // In the designer, a template's bindings hold sample texts (`part2_props 1`), not a component and its props: the
  // element then shows nothing rather than failing the whole view.
  const isComponent = typeof component === 'function' || typeof component === 'symbol' || (typeof component === 'object' && component !== null)
  if (!isComponent) return null
  return createElement(component, props !== null && typeof props === 'object' ? props : {})
}

/** Element metadata of a custom control (the web counterpart of `#[derive(Component)]`, EVENTS.md §4.3). */
export interface ControlMeta {
  category?: string
  icon?: string
  defaultEvent?: string
  props?: Record<string, { kind: 'Bool' | 'F32' | 'String' | 'object' | { Enum: readonly string[] }; default?: unknown; bindable?: boolean; prop?: string }>
  events?: Record<string, { prop: string; args: string }>
  children?: 'None' | 'SingleWidget' | 'List'
}

export type DefinedControl<P> = ComponentType<P> & { readonly kbview: ControlMeta }

/** A custom control: the component, with its metadata for the Toolbox, Properties and the compiler. */
export function defineControl<P>(component: ComponentType<P>, meta: ControlMeta): DefinedControl<P> {
  return Object.assign(component, { kbview: meta })
}

/** Registers a module's own custom controls under its specifier (for interpreted plans, the designer). */
export function registerControls(specifier: string, controls: Record<string, ComponentType<never>>): void {
  registerElements(specifier, controls)
}

// ── Dialogs ──

export type DialogResult = 'OK' | 'Cancel' | 'Yes' | 'No' | 'None'
export type MessageBoxButtons = 'OK' | 'OKCancel' | 'YesNo'
export type MessageBoxIcon = 'None' | 'Information' | 'Warning' | 'Error' | 'Question'

function mount(render: (close: (r: DialogResult) => void) => ReactNode): Promise<DialogResult> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const close = (r: DialogResult): void => {
      root.unmount()
      host.remove()
      resolve(r)
    }
    root.render(render(close))
  })
}

/** `await MessageBox.show(text, caption, buttons, icon)` - rendered with the host's `ConfirmDialog`. */
export const MessageBox = {
  show(text: string, caption = '', buttons: MessageBoxButtons = 'OK', icon: MessageBoxIcon = 'None'): Promise<DialogResult> {
    const Confirm = resolveComponent('@ui', 'ConfirmDialog')
    if (!Confirm) return Promise.reject(new Error('[views] MessageBox needs @ui ConfirmDialog (registerElements("@ui", …))'))
    const yesNo = buttons === 'YesNo'
    return mount((close) =>
      createElement(Confirm, {
        title: caption,
        message: text,
        confirmLabel: yesNo ? "Yes" : 'OK',
        cancelLabel: yesNo ? "No" : "Cancel",
        hideCancel: buttons === 'OK',
        variant: icon === 'Error' ? 'danger' : icon === 'Warning' ? 'warning' : 'default',
        onConfirm: () => close(yesNo ? 'Yes' : 'OK'),
        onCancel: () => close(yesNo ? 'No' : 'Cancel'),
      }),
    )
  },
}

/** `await Dialog.show(SomeDialogView, props, title)`: the view gets `onClose(result)` in its props. */
export const Dialog = {
  show<P extends object>(view: ComponentType<P & { onClose: (r: DialogResult) => void }>, props: P, title = ''): Promise<DialogResult> {
    const Window = resolveComponent('@ui', 'FloatingWindow')
    return mount((close) => {
      const content = createElement(view, { ...props, onClose: close } as P & { onClose: (r: DialogResult) => void })
      return Window ? createElement(Window, { title, onClose: () => close('Cancel'), backdrop: true, children: content }) : content
    })
  },
}
