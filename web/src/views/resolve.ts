/**
 * What the runtime resolves at run time rather than through imports: components of interpreted plans (the
 * designer's - compiled plans import theirs), Lucide icons by name, `{Res}` strings, and the elements
 * modules register at load time (`registerElements`, the module isolation rule 2: a module's own controls
 * are registered dynamically, never statically linked from another module).
 */
import type { ComponentType } from 'react'

type AnyComponent = ComponentType<Record<string, unknown>>
type IconComponent = ComponentType<{ size?: number; color?: string; className?: string }>

const modules = new Map<string, Readonly<Record<string, unknown>>>()
let iconResolver: (name: string) => IconComponent | undefined = () => undefined
/** The values of a `{Res}`'s arguments, by the name written in the view (`Count`, `Name`). */
export type ResourceArgs = Readonly<Record<string, unknown>>

let resourceResolver: (key: string, set?: string, args?: ResourceArgs) => string = (key) => key
let resourceVersion = 0

/**
 * Registers the exports of a module under its specifier (`'@ui'`, `'@kubuno/sdk'`, a module's own
 * `'controls'`…), for plans that name components by module/export (interpreted plans, the designer).
 */
export function registerElements(specifier: string, exports: Readonly<Record<string, unknown>>): void {
  modules.set(specifier, { ...(modules.get(specifier) ?? {}), ...exports })
}

/** The component exported as `name` by `specifier` (registered with `registerElements`). */
export function resolveComponent(specifier: string | undefined, name: string | undefined): AnyComponent | undefined {
  if (!specifier || !name) return undefined
  return modules.get(specifier)?.[name] as AnyComponent | undefined
}

/** Sets how an icon name (`Save`, `trash`) becomes a component (the host passes its `ICON_MAP` lookup). */
export function setIconResolver(resolve: (name: string) => IconComponent | undefined): void {
  iconResolver = resolve
}

export function resolveIcon(name: string): IconComponent | undefined {
  return iconResolver(name)
}

/**
 * Sets how `{Res key[, Source=set]}` resolves (the host passes i18next's `t`). Call
 * `invalidateResources()` when the language changes: every live view re-reads its strings.
 */
export function setResourceResolver(resolve: (key: string, set?: string, args?: ResourceArgs) => string): void {
  resourceResolver = resolve
  invalidateResources()
}

export function resolveResource(key: string, set?: string, args?: ResourceArgs): string {
  return resourceResolver(key, set, args)
}

/**
 * The interpolation options of a `{Res}`'s arguments for i18next: each argument under its name as written and
 * with its first letter lower-cased (`Count` fills `{{count}}` and selects the plural form, the way
 * `t(key, { count })` does; `UserName` fills `{{userName}}`). A numeric text count becomes a number, so the plural
 * rules apply to `Count="3"` too.
 */
export function interpolationOptions(args: ResourceArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(args)) {
    const isCount = name.toLowerCase() === 'count'
    const lower = isCount ? 'count' : name.charAt(0).toLowerCase() + name.slice(1)
    const value = isCount && typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw
    out[name] = value
    out[lower] = value
  }
  return out
}

/** The host's i18next `t` (default namespace), for `@ui` elements given their strings by the host (`HostStrings`). */
export type Translator = (key: string, options?: Record<string, unknown>) => string

let translatorImpl: Translator | undefined
let translatorAt = -1
let translatorFn: Translator | undefined

/**
 * Sets the host's translator: what an `@ui` element receives as its `t` prop when its view sets `HostStrings`
 * (the strings it carries itself - a close button's name, a default « Cancel » - then come from the host's
 * catalogue, as when a TSX screen passes its own `t`).
 */
export function setTranslator(t: Translator | undefined): void {
  translatorImpl = t
  translatorAt = -1
  invalidateResources()
}

/**
 * The host's translator, a new function after every language change (an element given it re-renders, as with
 * a `t` from `useTranslation`); `undefined` when the host set none (the element keeps its English defaults).
 */
export function hostTranslator(): Translator | undefined {
  if (!translatorImpl) return undefined
  if (translatorAt !== resourceVersion) {
    const impl = translatorImpl
    translatorFn = (key, options) => impl(key, options)
    translatorAt = resourceVersion
  }
  return translatorFn
}

const resourceListeners = new Set<() => void>()

export function invalidateResources(): void {
  resourceVersion++
  for (const l of resourceListeners) l()
}

/** @internal */
export function onResourcesChanged(listener: () => void): () => void {
  resourceListeners.add(listener)
  return () => resourceListeners.delete(listener)
}

/** @internal */
export function resourcesVersion(): number {
  return resourceVersion
}
