/**
 * Runtime-provided elements and helpers: `Repeater` (rendered by the renderer as a template), the
 * non-visual tray components `Timer`, `Query`, `Mutation`, `ReactHost` (the migration escape hatch),
 * `defineControl` (custom controls: a React component + its element metadata), `MessageBox` and
 * `Dialog` (on top of the host's `ConfirmDialog` / `FloatingWindow`, never browser dialogs).
 */
import { type ComponentType, type ReactNode } from 'react';
import { type Internals } from './view';
/** A `Repeater`'s children are an item template: the renderer instantiates them per item. */
export declare function Repeater({ children }: {
    children?: ReactNode;
}): ReactNode;
/** Context of the tray components: the view they belong to and their element id. */
export interface TrayProps {
    /** @internal */ __view?: Internals;
    /** @internal */ __id?: string;
}
/** `<Timer Interval="1000" Enabled="true" OnTick="tick"/>`: raises `onTick` every `interval` ms while enabled. */
export declare function Timer({ interval, enabled, onTick }: {
    interval?: number;
    enabled?: boolean;
    onTick?: () => void;
}): null;
/** The handle of a `<Query x:Name="q">`: `{Binding q.data…}`, `q.isLoading`, `await this.q.refetch()`. */
export interface QueryHandle<T = unknown> {
    readonly data: T | undefined;
    readonly isLoading: boolean;
    readonly isError: boolean;
    readonly error: unknown;
    refetch(): Promise<unknown>;
}
/** The handle of a `<Mutation x:Name="m">`: `await this.m.run(args)`. */
export interface MutationHandle<A = unknown, R = unknown> {
    readonly isPending: boolean;
    readonly error: unknown;
    run(args: A): Promise<R>;
}
/**
 * `<Query Key="weather-locations, {Binding city}" Fetch="load_locations"/>`: a React Query query whose
 * function is a code-behind method; its state is the element's handle.
 */
export declare function Query({ queryKey, fetch, enabled, staleTime, __view, __id }: {
    queryKey?: unknown;
    fetch?: () => Promise<unknown>;
    enabled?: boolean;
    staleTime?: number;
} & TrayProps): null;
/** `<Mutation Run="add_location" Invalidates="weather-locations"/>`. */
export declare function Mutation({ run, invalidates, __view, __id }: {
    run?: (args: unknown) => Promise<unknown>;
    invalidates?: string;
} & TrayProps): null;
/** `<ReactHost Component="{Binding editor}" Props="{Binding editorProps}"/>`: any React component. */
export declare function ReactHost({ component, props }: {
    component?: ComponentType<Record<string, unknown>>;
    props?: Record<string, unknown>;
}): ReactNode;
/** Element metadata of a custom control (the web counterpart of `#[derive(Component)]`, EVENTS.md §4.3). */
export interface ControlMeta {
    category?: string;
    icon?: string;
    defaultEvent?: string;
    props?: Record<string, {
        kind: 'Bool' | 'F32' | 'String' | 'object' | {
            Enum: readonly string[];
        };
        default?: unknown;
        bindable?: boolean;
        prop?: string;
    }>;
    events?: Record<string, {
        prop: string;
        args: string;
    }>;
    children?: 'None' | 'SingleWidget' | 'List';
}
export type DefinedControl<P> = ComponentType<P> & {
    readonly kbview: ControlMeta;
};
/** A custom control: the component, with its metadata for the Toolbox, Properties and the compiler. */
export declare function defineControl<P>(component: ComponentType<P>, meta: ControlMeta): DefinedControl<P>;
/** Registers a module's own custom controls under its specifier (for interpreted plans, the designer). */
export declare function registerControls(specifier: string, controls: Record<string, ComponentType<never>>): void;
export type DialogResult = 'OK' | 'Cancel' | 'Yes' | 'No' | 'None';
export type MessageBoxButtons = 'OK' | 'OKCancel' | 'YesNo';
export type MessageBoxIcon = 'None' | 'Information' | 'Warning' | 'Error' | 'Question';
/** `await MessageBox.show(text, caption, buttons, icon)` - rendered with the host's `ConfirmDialog`. */
export declare const MessageBox: {
    show(text: string, caption?: string, buttons?: MessageBoxButtons, icon?: MessageBoxIcon): Promise<DialogResult>;
};
/** `await Dialog.show(SomeDialogView, props, title)`: the view gets `onClose(result)` in its props. */
export declare const Dialog: {
    show<P extends object>(view: ComponentType<P & {
        onClose: (r: DialogResult) => void;
    }>, props: P, title?: string): Promise<DialogResult>;
};
