/**
 * Gestures → edit intents (vskubuno docs/DESIGNER.md §3: "designer = gesture → intent; language server = intent →
 * text"): the page never writes text, it posts `EditOp`s the host applies to the buffer. Pure functions:
 * move / resize / nudge ops, deletions, the Toolbox skeleton markup, and the keyboard map.
 *
 * Every value is a whole CSS px of the view (page px divided by the zoom, rounded - a pointer delta at a zoom or a
 * fractional scale is fractional). `X` is inline-start based (`insetInlineStart`): in a right-to-left container a
 * move to the right decreases it.
 */
import { type Handle, type Rect } from './geometry';
import type { BatchOp, PageMessage } from './protocol';
/** The current literal placement values of an element (`undefined` = absent / bound). */
export interface Placement {
    readonly X?: number;
    readonly Y?: number;
    readonly Width?: number;
    readonly Height?: number;
}
/** The ops of a move by a page delta: one `setAttribute` per axis whose rounded value changes. */
export declare function moveOps(id: string, at: Placement, dx: number, dy: number, zoom: number, rtl: boolean): BatchOp[];
/**
 * The ops of a resize from `before` to `after` (page px) through handle `h`: `Width` / `Height` for the edges
 * it moved, and `X` / `Y` when the start / top edge moved and the element is placed by them (`absolute`).
 * A size without a literal value starts from the painted one.
 */
export declare function resizeOps(id: string, at: Placement, before: Rect, after: Rect, h: Handle, zoom: number, rtl: boolean, absolute: boolean): BatchOp[];
/**
 * Which grab handles resize an element: every one for a child of an absolute container; otherwise only the
 * end / bottom edges that hold an explicit size (`Width` → the inline-end edge, `Height` → the bottom edge, and
 * the corner between them when both).
 */
export declare function resizableHandles(absolute: boolean, at: Placement, rtl: boolean): Set<Handle>;
/** The arrow-key nudge of the selected absolute children (1 px, Shift: 8): `null` when nothing moves. */
export declare function nudgeMessage(items: readonly {
    id: string;
    at: Placement;
    rtl: boolean;
}[], key: string, shift: boolean): PageMessage | null;
/** Delete of a selection: one `removeElement` for one element, a `delete` batch for several; the root never. */
export declare function deleteMessage(ids: readonly string[]): PageMessage | null;
/** An `editRequest` inserting `xml` into `parentId` at `index`. */
export declare function insertMessage(parentId: string, index: number, xml: string): PageMessage;
/**
 * The markup a Toolbox drop inserts (the desktop's `skeleton_xml`): `<Name/>` in a flow or other container;
 * `<Name X="…" Y="…" Width="…" Height="…" Anchor="Top, Left"/>` in an absolute one (placed at the drop point
 * with its default size and Windows Forms' default anchoring). A non-visual element never gets a place.
 */
export declare function skeletonXml(component: string, xy: readonly [number, number] | null | undefined, size: readonly [number, number], nonVisual?: boolean): string;
/** The element a Toolbox text names: `kubuno-toolbox:Button`, or markup `<Button …/>`; `null` otherwise. */
export declare function toolboxComponentOf(text: string): string | null;
export interface KeyInput {
    readonly key: string;
    readonly ctrl: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
}
export interface KeyContext {
    /** The selection, primary first. */
    readonly selection: readonly string[];
    /** The selected elements placed by X / Y, with their literal placement and direction. */
    readonly absolute: readonly {
        id: string;
        at: Placement;
        rtl: boolean;
    }[];
    readonly parentOf: (id: string) => string | null;
    /** The painted siblings of an element (Ctrl+A: select them all). */
    readonly siblingsOf: (id: string) => readonly string[];
}
export interface KeyResult {
    /** Messages to post (the selection change, if any, is posted by the caller with fresh bounds). */
    readonly messages: PageMessage[];
    /** A new selection (primary first). */
    readonly select?: readonly string[];
    /** The page used the key (prevent its default). */
    readonly handled: boolean;
}
/** What a key does on the design surface. Keys it does not use go to the host (`unhandledKey`). */
export declare function keyMessages(k: KeyInput, ctx: KeyContext): KeyResult;
