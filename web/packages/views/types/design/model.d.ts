/**
 * What the design surface knows of the elements: the catalog (host registry + project registries + user
 * controls - read at run time, never a hard-coded list) and the plan being shown (element id → node, literal
 * attribute values). Pure: no DOM.
 */
import type { PlanNode, ViewPlan } from '../plan';
export type ChildrenModel = 'None' | 'List' | 'SingleWidget';
export interface ComponentInfo {
    readonly name: string;
    readonly children: ChildrenModel;
    /** Gated children: when not empty, only these may be children. */
    readonly allowed: readonly string[];
    /** `DockAnchor` (Panel, UserControl), `Flow` (Stack), `Tabs`… or null. */
    readonly layoutKind: string | null;
    /** `design_defaults.size`: the size a Toolbox drop gives the element in an absolute container. */
    readonly dropSize: readonly [number, number] | null;
    readonly nonVisual: boolean;
    readonly userControl: boolean;
    /** The web block's module and export (the renderer's specifier for the element). */
    readonly module: string | null;
    readonly export: string | null;
}
/** The elements of the open project: the host's, the project's own controls, its user controls. */
export declare class Catalog {
    private readonly byName;
    private readonly gated;
    constructor(registries: readonly {
        components?: unknown;
    }[], userControls?: readonly {
        name: string;
        module: string;
    }[]);
    /** Parses registry documents given as JSON text (invalid ones are skipped). */
    static fromTexts(texts: readonly string[], userControls?: readonly {
        name: string;
        module: string;
    }[]): Catalog;
    get(name: string): ComponentInfo | undefined;
    /** Some container lists `name` among its gated children: it may only go into such a container. */
    isGated(name: string): boolean;
    get size(): number;
}
/** One element of the plan shown, with what the surface reads of it. */
export interface NodeInfo {
    readonly id: string;
    readonly el: string;
    readonly node: PlanNode;
    /** The ids of its element children (not slots, not items), in document order. */
    readonly children: readonly string[];
}
/** Every node of a plan by element id (children, slots, adapter items and the tray). */
export declare function indexPlan(plan: ViewPlan | null): Map<string, NodeInfo>;
/** The literal value of an attribute of a node (`undefined` when absent or bound). */
export declare function literal(node: PlanNode | undefined, name: string): unknown;
/** A literal numeric attribute (`X="12"` → 12), else `undefined`. */
export declare function literalNumber(node: PlanNode | undefined, name: string): number | undefined;
/** Every module specifier a plan names, with the exports it uses (`/src/x/AppTileGrid` → `AppTileGrid`). */
export declare function planModules(plan: ViewPlan): Map<string, Set<string>>;
/** How a container lays out its children, as far as the surface's gestures are concerned. */
export type ContainerKind = 'leaf' | 'flow' | 'dock' | 'absolute' | 'single' | 'list';
/** The container kind of an element (an id the plan does not know - a property element - is a `list`). */
export declare function containerKind(nodes: ReadonlyMap<string, NodeInfo>, catalog: Catalog, id: string): ContainerKind;
/** Whether an element is placed by `X` / `Y` (a child of an absolute container). */
export declare function isAbsoluteChild(nodes: ReadonlyMap<string, NodeInfo>, catalog: Catalog, id: string): boolean;
/** `src/a/X.kbcontrol` + `./X` → `/src/a/X` (posix, `.` / `..` resolved). */
export declare function moduleOfCodeBehind(file: string, codeBehind: string): string;
