/**
 * Where a drop lands (a Toolbox item, or an element dragged to another place), per container kind - pure
 * (vskubuno docs/DESIGNER.md §4, §10 "Toolbox drop", transposed to the web containers):
 *
 * - routing: the element under the pointer when it takes children, else its parent (a leaf → before / after it
 *   in its parent, by the pointer's half). A `SingleWidget` container (`ScrollArea`, `Card`) delegates to its
 *   child when that child is a container, and is a valid target only while empty;
 * - `Stack` (`Flow`): an insertion line between children, perpendicular to `Direction` (reversed by
 *   `RightToLeft` / `BottomUp`, and by a right-to-left page for a row);
 * - `Panel` / `UserControl` (dock): a line between children in document order (the axis read from how the
 *   children spread, `flow_axis`); when the dragged element has `Dock`, the band it would take is reported too;
 * - `Panel Layout="Absolute"`: free X / Y (whole CSS px of the view, inline-start based: from the right edge in
 *   right-to-left), the marker a ghost of the element at the pointer;
 * - not a valid child (gated children, a filled `SingleWidget`, a leaf), or the dragged element itself / inside it:
 *   `valid: false`, drawn as "not allowed".
 */
import { type LayoutMap, type Rect } from './geometry';
import { type Catalog, type ContainerKind, type NodeInfo } from './model';
export interface DropContext {
    readonly map: LayoutMap;
    readonly nodes: ReadonlyMap<string, NodeInfo>;
    readonly catalog: Catalog;
    /** View CSS px per page px is `1 / zoom`. */
    readonly zoom: number;
    /** The view's frame (page px): a point inside it over no element targets the view's root. */
    readonly frame?: Rect | null;
}
/** What is dragged: a new element (its name; `null` while unknown, the HTML5 fallback before the drop) or an element. */
export type DragSubject = {
    readonly kind: 'new';
    readonly component: string | null;
} | {
    readonly kind: 'move';
    readonly id: string;
};
export interface DropTarget {
    readonly valid: boolean;
    readonly parentId: string;
    readonly index: number;
    /** Page px: an insertion line, the container's box, or a ghost of the new element. */
    readonly marker: Rect;
    readonly markerKind: 'line' | 'box' | 'ghost';
    /** Absolute containers: the element's new `X` / `Y` (view CSS px, whole). */
    readonly xy?: readonly [number, number];
    /** A docked element being moved: the band it would take in the target container. */
    readonly band?: Rect;
    readonly container: ContainerKind;
}
/** Thickness of an insertion line. */
export declare const MARKER_THICKNESS = 3;
/** The size a new element is dropped at in an absolute container (`design_defaults.size`, else the desktop's rule). */
export declare function dropSize(catalog: Catalog, component: string | null): [number, number];
/** Whether `component` may be a child of `containerId` (registry rules), given the children it has. */
export declare function canHold(ctx: DropContext, containerId: string, component: string | null, existing: number): boolean;
/** The insertion slot among painted siblings along an axis: the position in `siblings` and the line. */
export declare function flowSlot(siblings: readonly Rect[], container: Rect, axis: 'horizontal' | 'vertical', reversed: boolean, x: number, y: number, thickness?: number): {
    position: number;
    marker: Rect;
};
/**
 * The index an insertion slot is, in `edit::insert_child` / `move_element` terms (Vec semantics, the moved
 * element taken out first): before the sibling at `position` → its element-child ordinal; after the last → the
 * last's ordinal + 1 (or the container's child count when nothing is painted).
 */
export declare function slotIndex(ctx: DropContext, parentId: string, siblingIds: readonly string[], position: number, moved: string | null): number;
/** The band a docked element takes along its edge of a container (inline edges follow the direction). */
export declare function dockBand(container: Rect, dock: string, size: Rect, rtl: boolean): Rect | null;
/** Where a drop at `(x, y)` lands, or `null` when the point is over no element of the view. */
export declare function computeDropTarget(ctx: DropContext, subject: DragSubject, x: number, y: number): DropTarget | null;
/** Whether a move's target leaves the element where it is (a reorder onto its own slot). */
export declare function isNoOpMove(moved: string, target: DropTarget): boolean;
