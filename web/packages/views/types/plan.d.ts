/**
 * The render plan of a `.kbview` view - the data `@kubuno/views` renders. Produced by the web compiler
 * (`kubuno-views-web`, through `@kubuno/views-compiler`): as plain JSON in the designer (bindings walked by
 * path), or as a compiled module where components/icons are imported and every binding has a precompiled
 * getter `g` / setter `s` and every event a dispatcher `f`. Normative description: `vskubuno/docs/WEB-VIEWS.md`
 * §13 ("WV-2 as built").
 */
import type { ComponentType } from 'react';
/** The plan format this runtime reads (`viewsAbi` of modules). */
export declare const VIEWS_ABI = 1;
/** `[line, column]` in the `.kbview`, 1-based (UTF-16 columns). */
export type At = readonly [number, number];
/** Where a property goes (VIEWS-SPEC §10.5 `prop_map`). */
export interface PropTarget {
    readonly prop?: string;
    readonly field?: string;
    readonly runtime?: string;
    readonly convert?: string;
    readonly values?: Readonly<Record<string, unknown>>;
    /** The event reporting a user change (two-way bindings). */
    readonly change?: string;
    /** That event's source (filled by the compiler for two-way bindings). */
    readonly change_from?: EventSource;
}
/** Where an event comes from (VIEWS-SPEC §10.5 `event_map`). */
export interface EventSource {
    readonly prop?: string;
    readonly field?: string;
    readonly dom?: string;
    readonly runtime?: string;
    readonly args: string;
}
export type BindingMode = 'OneWay' | 'TwoWay' | 'OneTime' | 'OneWayToSource';
export interface PlanBinding {
    readonly path: string;
    readonly mode: BindingMode;
    readonly trigger?: 'LostFocus' | 'Explicit';
    readonly conv?: string;
    readonly param?: string;
    readonly fallback?: string;
    readonly format?: string;
    readonly null?: string;
    readonly culture?: string;
    /** Template depth (0 = the view). */
    readonly depth?: number;
    readonly at: At;
    /** Compiled getter: the value of the path from the owner of its first segment. */
    readonly g?: (owner: never) => unknown;
    /** Compiled setter. */
    readonly s?: (owner: never, value: unknown) => void;
}
/** A literal icon / image value in a compiled plan. */
export interface IconValue {
    readonly $icon?: string;
    readonly $img?: string;
    readonly c?: ComponentType<{
        size?: number;
        color?: string;
        className?: string;
    }>;
}
export interface PlanProp {
    readonly n: string;
    readonly to: PropTarget;
    readonly v?: unknown;
    readonly b?: PlanBinding;
    readonly res?: PlanRes;
    readonly kind: 'Bool' | 'F32' | 'String' | 'Enum';
    readonly at: At;
}
/** One argument of a `{Res key, Name=value}`: a literal or a one-way binding. */
export interface PlanResArg {
    /** The name as written (`Count`, `Name`). */
    readonly n: string;
    readonly v?: string;
    readonly b?: PlanBinding;
}
/** A `{Res key[, Source=set][, Name=value]…}` (WV-6: arguments fill `{{name}}` placeholders, `Count` picks the plural form). */
export interface PlanRes {
    readonly key: string;
    readonly set?: string;
    readonly args?: readonly PlanResArg[];
}
export interface PlanEvent {
    readonly n: string;
    readonly h: string;
    readonly from: EventSource;
    readonly args_type: string;
    readonly at: At;
    /** Compiled dispatcher `(vm, sender, e) => vm.handler(sender, e)`. */
    readonly f?: (vm: never, sender: unknown, e: unknown) => unknown;
}
export interface PlanItems {
    readonly prop: string;
    readonly shape: string;
    readonly content?: unknown;
    readonly key?: string;
    readonly nested?: string;
    readonly list: readonly PlanNode[];
}
export interface PlanNode {
    readonly id: string;
    readonly el: string;
    readonly name?: string;
    readonly at: At;
    readonly m?: string;
    readonly x?: string;
    /** The component (compiled plans). */
    readonly c?: ComponentType<Record<string, unknown>>;
    readonly dom?: string;
    readonly kind?: 'user_control';
    readonly fixed?: Readonly<Record<string, unknown>>;
    readonly props?: readonly PlanProp[];
    readonly events?: readonly PlanEvent[];
    readonly children?: readonly PlanNode[];
    readonly content?: string;
    readonly slots?: Readonly<Record<string, readonly PlanNode[]>>;
    readonly items?: PlanItems;
    readonly template?: boolean;
    readonly sc?: Readonly<Record<string, readonly PlanProp[]>>;
    readonly design?: readonly PlanProp[];
}
export interface ViewPlan {
    readonly abi: number;
    readonly file: string;
    readonly kind: 'view' | 'control';
    readonly root: PlanNode;
    readonly tray?: readonly PlanNode[];
    readonly names: Readonly<Record<string, string>>;
    readonly handlers: readonly string[];
    readonly design_size?: readonly [number, number];
}
