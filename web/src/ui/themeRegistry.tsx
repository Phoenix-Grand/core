import { createContext, createElement, forwardRef, useContext, useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'

/**
 * ComponentRegistry - the indirection that lets a theme replace the *markup and
 * behaviour* (not just the colours) of a UI "object", from primitives to complex
 * components, either globally or for a specific module.
 *
 * A themeable component is declared with `themed('<key>', Base)`. At render time
 * it resolves its implementation through this registry: a per-module override
 * wins over a global override, which wins over the built-in `Base`. A theme's
 * script registers overrides here (via the theme API handed to it at load time);
 * switching theme calls `clearAll()` to drop the previous theme's overrides.
 *
 * Lives in `@ui` so primitives can consult it without importing from `core`; it
 * is also re-exported from `@kubuno/sdk` for module authors.
 */
type AnyComp = ComponentType<any>

const globalOverrides = new Map<string, AnyComp>()
const moduleOverrides = new Map<string, Map<string, AnyComp>>()
// Isolated overrides used by the admin preview pane: a theme's components can be
// shown WITHOUT applying the theme to the live app. Resolved only inside a
// `ThemePreviewContext`, ignoring global/module overrides.
const previewOverrides = new Map<string, AnyComp>()

let version = 0
const listeners = new Set<() => void>()
function emit() {
  version += 1
  for (const l of listeners) l()
}

export const ComponentRegistry = {
  /** Register an override for `key`. With `moduleId`, scopes it to that module. */
  register(key: string, Component: AnyComp, opts?: { moduleId?: string }): void {
    if (opts?.moduleId) {
      let m = moduleOverrides.get(opts.moduleId)
      if (!m) {
        m = new Map()
        moduleOverrides.set(opts.moduleId, m)
      }
      m.set(key, Component)
    } else {
      globalOverrides.set(key, Component)
    }
    emit()
  },

  unregister(key: string, opts?: { moduleId?: string }): void {
    if (opts?.moduleId) moduleOverrides.get(opts.moduleId)?.delete(key)
    else globalOverrides.delete(key)
    emit()
  },

  /** Resolve the active implementation: module-scoped → global → undefined. */
  resolve(key: string, moduleId?: string): AnyComp | undefined {
    if (moduleId) {
      const scoped = moduleOverrides.get(moduleId)?.get(key)
      if (scoped) return scoped
    }
    return globalOverrides.get(key)
  },

  /** Drop every override registered for a single module (e.g. on module unload). */
  clearModule(moduleId: string): void {
    if (moduleOverrides.delete(moduleId)) emit()
  },

  /** Drop ALL overrides - called when switching theme. */
  clearAll(): void {
    globalOverrides.clear()
    moduleOverrides.clear()
    emit()
  },

  // ── Preview scope (admin pane) ──────────────────────────────────────────────
  /** Register an override for the isolated preview scope (flat, ignores moduleId). */
  registerPreview(key: string, Component: AnyComp): void {
    previewOverrides.set(key, Component)
    emit()
  },
  /** Resolve an override within the preview scope only. */
  resolvePreview(key: string): AnyComp | undefined {
    return previewOverrides.get(key)
  },
  /** Drop every preview override - called when the previewed theme changes. */
  clearPreview(): void {
    if (previewOverrides.size) {
      previewOverrides.clear()
      emit()
    }
  },

  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },
  getVersion(): number {
    return version
  },
}

/**
 * Context carrying the id of the module currently being rendered. The host's
 * `ModuleArea` provides it, so a `themed()` primitive rendered inside a module
 * automatically prefers that module's overrides.
 */
export const ThemeScopeContext = createContext<string | undefined>(undefined)

/**
 * When true, `themed()` components resolve from the isolated preview scope only
 * (theme being previewed in the admin pane), never from the live global/module
 * overrides. Wrap a preview gallery in `<ThemePreviewContext.Provider value>`.
 */
export const ThemePreviewContext = createContext<boolean>(false)

/** Subscribe a component to registry changes so it re-renders on theme swap. */
export function useThemeVersion(): number {
  return useSyncExternalStore(
    ComponentRegistry.subscribe,
    ComponentRegistry.getVersion,
    ComponentRegistry.getVersion,
  )
}

const REACT_FORWARD_REF = Symbol.for('react.forward_ref')
const REACT_MEMO = Symbol.for('react.memo')

/** Whether a render target can receive a `ref` (host element, forwardRef, memo). */
function acceptsRef(target: unknown): boolean {
  if (typeof target === 'string') return true
  const tag = (target as { $$typeof?: symbol } | null)?.$$typeof
  return tag === REACT_FORWARD_REF || tag === REACT_MEMO
}

/**
 * Wrap a base component so a theme can override it. The returned component is a
 * drop-in replacement for `Base`: same props, same type (including generics and
 * `forwardRef` refs), and it renders `Base` unchanged until a theme registers an
 * override. Refs are forwarded only to targets that accept them, so wrapping a
 * plain function component never triggers React's "cannot be given refs" warning.
 */
export function themed<C extends ComponentType<any>>(key: string, Base: C): C {
  const Themed = forwardRef<unknown, Record<string, unknown>>(function Themed(props, ref) {
    useThemeVersion()
    const inPreview = useContext(ThemePreviewContext)
    const moduleId = useContext(ThemeScopeContext)
    const Override = (
      inPreview ? ComponentRegistry.resolvePreview(key) : ComponentRegistry.resolve(key, moduleId)
    ) as AnyComp | undefined
    const Target = (Override ?? Base) as AnyComp
    return createElement(Target, ref != null && acceptsRef(Target) ? { ...props, ref } : props)
  })
  Themed.displayName = `Themed(${key})`
  return Themed as unknown as C
}
