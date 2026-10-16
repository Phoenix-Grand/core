/**
 * What the runtime resolves at run time rather than through imports: components of interpreted plans (the
 * designer's - compiled plans import theirs), Lucide icons by name, `{Res}` strings, and the elements
 * modules register at load time (`registerElements`, the module isolation rule 2: a module's own controls
 * are registered dynamically, never statically linked from another module).
 */
import type { ComponentType } from 'react';
type AnyComponent = ComponentType<Record<string, unknown>>;
type IconComponent = ComponentType<{
    size?: number;
    color?: string;
    className?: string;
}>;
/** The values of a `{Res}`'s arguments, by the name written in the view (`Count`, `Name`). */
export type ResourceArgs = Readonly<Record<string, unknown>>;
/**
 * Registers the exports of a module under its specifier (`'@ui'`, `'@kubuno/sdk'`, a module's own
 * `'controls'`…), for plans that name components by module/export (interpreted plans, the designer).
 */
export declare function registerElements(specifier: string, exports: Readonly<Record<string, unknown>>): void;
/** The component exported as `name` by `specifier` (registered with `registerElements`). */
export declare function resolveComponent(specifier: string | undefined, name: string | undefined): AnyComponent | undefined;
/** Sets how an icon name (`Save`, `trash`) becomes a component (the host passes its `ICON_MAP` lookup). */
export declare function setIconResolver(resolve: (name: string) => IconComponent | undefined): void;
export declare function resolveIcon(name: string): IconComponent | undefined;
/**
 * Sets how `{Res key[, Source=set]}` resolves (the host passes i18next's `t`). Call
 * `invalidateResources()` when the language changes: every live view re-reads its strings.
 */
export declare function setResourceResolver(resolve: (key: string, set?: string, args?: ResourceArgs) => string): void;
export declare function resolveResource(key: string, set?: string, args?: ResourceArgs): string;
/**
 * The interpolation options of a `{Res}`'s arguments for i18next: each argument under its name as written and
 * with its first letter lower-cased (`Count` fills `{{count}}` and selects the plural form, the way
 * `t(key, { count })` does; `UserName` fills `{{userName}}`). A numeric text count becomes a number, so the plural
 * rules apply to `Count="3"` too.
 */
export declare function interpolationOptions(args: ResourceArgs): Record<string, unknown>;
/** The host's i18next `t` (default namespace), for `@ui` elements given their strings by the host (`HostStrings`). */
export type Translator = (key: string, options?: Record<string, unknown>) => string;
/**
 * Sets the host's translator: what an `@ui` element receives as its `t` prop when its view sets `HostStrings`
 * (the strings it carries itself - a close button's name, a default « Cancel » - then come from the host's
 * catalogue, as when a TSX screen passes its own `t`).
 */
export declare function setTranslator(t: Translator | undefined): void;
/**
 * The host's translator, a new function after every language change (an element given it re-renders, as with
 * a `t` from `useTranslation`); `undefined` when the host set none (the element keeps its English defaults).
 */
export declare function hostTranslator(): Translator | undefined;
export declare function invalidateResources(): void;
/** @internal */
export declare function onResourcesChanged(listener: () => void): () => void;
/** @internal */
export declare function resourcesVersion(): number;
export {};
