/**
 * The renderer: one renderer for compiled plans (production, dev server) and interpreted plans (the
 * designer) - the only difference is whether a binding has a precompiled getter (WEB-VIEWS §2.1).
 *
 * Granularity: every element subscribes to its view's store and recomputes the values it reads; it
 * re-renders only when one of them changed (elements are memoised, a parent's render does not re-render
 * them). The view root re-renders on every change, to run the code-behind's `use()`. The one exception is
 * `ReactHost`: the React component it hosts renders again with its view root, as it did as a child of the TSX
 * screen the view replaces (it may read state nothing notifies the view of - a registry a module fills later).
 */
import { type ComponentType, type ReactNode } from 'react';
import { type Scope } from './binding';
import type { PlanNode } from './plan';
import { type Cell, type ViewClass } from './view';
import { tokenColor } from './style';
export { tokenColor };
interface NodeProps {
    node: PlanNode;
    scope: Scope;
}
/** One element of a view. */
export declare const KbNode: import("react").MemoExoticComponent<({ node, scope }: NodeProps) => ReactNode>;
/** The size class of a width (VIEWS-SPEC §5.3). */
export declare function sizeClassOf(width: number): string;
interface ViewRootProps {
    cell: Cell;
    cls: ViewClass;
    props: object;
    design?: boolean;
}
/** Renders one view instance (the component returned by `X.component()`). */
export declare function ViewRoot({ cell, cls, props, design }: ViewRootProps): ReactNode;
/** Renders a view class or component with props (`<KbView view={NotesSettingsPage} …/>`). */
export declare function KbView({ view, design, ...props }: {
    view: ViewClass | ComponentType<object>;
    design?: boolean;
} & Record<string, unknown>): ReactNode;
