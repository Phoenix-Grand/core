/**
 * Pure geometry of the design surface (vskubuno docs/DESIGNER.md §9–§10, transposed to the DOM): rectangles,
 * element ids, the layout map built from `[data-kb-id]`, hit-testing, adorner geometry, move / resize. No DOM
 * access except in `buildLayoutMap` (through injectable measures, so jsdom tests can stub them).
 */
export interface Rect {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}
export declare const rect: (left: number, top: number, right: number, bottom: number) => Rect;
export declare const widthOf: (r: Rect) => number;
export declare const heightOf: (r: Rect) => number;
export declare const isEmptyRect: (r: Rect) => boolean;
export declare function contains(r: Rect, x: number, y: number): boolean;
export declare function intersect(a: Rect, b: Rect): Rect | null;
export declare function inflate(r: Rect, by: number): Rect;
export declare function translate(r: Rect, dx: number, dy: number): Rect;
/** `"0.1"` → `"0"`, `"0"` → `""` (the root), `""` → `null`. */
export declare function parentIdOf(id: string): string | null;
/** Whether `ancestor` is `id` or one of its ancestors (the root is everyone's). */
export declare function isAncestorOrSelf(ancestor: string, id: string): boolean;
/** The element-child ordinal of an id (`"0.3"` → 3); the root → 0. */
export declare function ordinalOf(id: string): number;
/**
 * The ids a group gesture applies to: the root and every element whose ancestor is also selected are dropped
 * (Windows Forms: a control follows its selected container), the order kept.
 */
export declare function topLevelIds(ids: readonly string[]): string[];
export interface LayoutEntry {
    readonly id: string;
    readonly parentId: string | null;
    /** The painted border box, page (viewport) CSS px. */
    readonly bounds: Rect;
    /** What the clipping ancestors (`overflow` ≠ visible) leave visible of the page; `null` = not clipped. */
    readonly clip: Rect | null;
    /** Paint (document) order. */
    readonly order: number;
    /** The element's inline direction is right-to-left. */
    readonly rtl: boolean;
    /** A container painting nothing of its own (no background, border, shadow): drawn with a faint outline. */
    readonly bare: boolean;
}
export interface LayoutMap {
    readonly entries: readonly LayoutEntry[];
    /** Entries of each id (several for the rows of a `Repeater` template), in paint order. */
    readonly byId: ReadonlyMap<string, readonly LayoutEntry[]>;
}
export declare function makeLayoutMap(entries: readonly LayoutEntry[]): LayoutMap;
/** The visible part of an entry (bounds ∩ clip), `null` when nothing of it shows. */
export declare function visibleRect(e: LayoutEntry): Rect | null;
/** The bounds of an element (its first painted instance). */
export declare function boundsOf(map: LayoutMap, id: string): Rect | null;
/** The painted children of an element, in document order (one entry per child, its first instance). */
export declare function childEntries(map: LayoutMap, parentId: string): LayoutEntry[];
/**
 * The deepest element under a point: entries scanned in REVERSE paint order, the first whose visible part holds
 * the point wins (a container is recorded before its children, so the most nested match comes first; between
 * overlapping siblings the later-painted one wins - `LayoutMap::hit_test`'s rule). Entries with nothing visible
 * are skipped; `skip` excludes ids (e.g. the dragged element).
 */
export declare function hitTest(map: LayoutMap, x: number, y: number, skip?: (id: string) => boolean): LayoutEntry | null;
/** What `buildLayoutMap` measures (injectable for tests). */
export interface Measures {
    rectOf(el: Element): Rect;
    /** The element clips its content (`overflow` other than `visible` on an axis). */
    clips(el: Element): boolean;
    rtl(el: Element): boolean;
    /** The element paints something of its own (background, border, shadow). */
    paints(el: Element): boolean;
}
export declare function domMeasures(win?: Window): Measures;
/**
 * The layout map of every `[data-kb-id]` element under `root` (the whole document by default: portalled
 * elements included), in document order. `isContainer(id)` says which ids are containers (for `bare`).
 */
export declare function buildLayoutMap(root: ParentNode, measures: Measures, isContainer?: (id: string) => boolean, stopAt?: Element | null): LayoutMap;
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export declare const HANDLES: readonly Handle[];
/** The gap between an element and its selection frame. */
export declare const FRAME_GAP = 3;
/** Side of a grab handle. */
export declare const HANDLE_SIZE = 7;
/** A press must move this far before it becomes a drag. */
export declare const DRAG_THRESHOLD = 4;
/** Smallest size a resize leaves. */
export declare const MIN_ELEMENT_SIZE = 8;
/** The selection frame of an element: 3 px outside its bounds. */
export declare function selectionFrame(bounds: Rect): Rect;
/** The centre of each grab handle on a frame. */
export declare function handlePoint(frame: Rect, h: Handle): [number, number];
export declare function handleRects(frame: Rect, size?: number): {
    handle: Handle;
    rect: Rect;
}[];
/** The handle under a point (with a little slack), if any. */
export declare function handleAt(frame: Rect, x: number, y: number, size?: number): Handle | null;
/** The edges a handle moves. */
export declare function handleEdges(h: Handle): {
    left: boolean;
    right: boolean;
    top: boolean;
    bottom: boolean;
};
/** A rectangle resized by dragging handle `h` by `(dx, dy)`; the opposite edges never move; never below `min`. */
export declare function resizeRect(r: Rect, h: Handle, dx: number, dy: number, min?: number): Rect;
/** Points to the axis a flow lays its children along, from how their centres spread (`flow_axis`). */
export declare function flowAxisOf(siblings: readonly Rect[]): 'horizontal' | 'vertical';
