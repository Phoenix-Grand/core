/**
 * The layout containers of `.kbview` web views (VIEWS-SPEC §5, lot WV-5a): `UserControl` (the root of a
 * `.kbcontrol`), `Panel` (dock bands, or absolute placement with `Layout="Absolute"`), `Stack` (flow along a
 * direction) and `ScrollArea` (one scrolling child).
 *
 * They live in the runtime, not in `@ui`, because a dock container reads its children's attached layout
 * values (`Dock`, `X`, `Y`…) from the plan: the renderer gives every element of `@kubuno/views` its view
 * (`__view`) and element id (`__id`).
 *
 * Web rendering of a clickable container: `AccessibleRole="PushButton"` renders a native `<button>` and a
 * web-only `Href` renders a link (`<a href>`); either keeps the keyboard and screen-reader behaviour of the
 * native element. A plain left click on a link stays in the app (the view's `OnClick` decides where to go);
 * a modified or middle click opens the address like any link.
 */
import { type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { Internals } from './view';
/** The theme surfaces a container may paint (VIEWS-SPEC §4.1: tokens only). */
export type Surface = 'None' | 'Layer' | 'Card' | 'Raised' | 'Well';
/** What every container receives besides its own properties. */
interface ContainerBase {
    children?: ReactNode;
    className?: string;
    style?: CSSProperties;
    /** `Enabled="false"`: a native button is disabled, another container made inert. */
    disabled?: boolean;
    tabIndex?: number;
    'aria-label'?: string;
    role?: string;
    href?: string;
    onClick?: (e: ReactMouseEvent<HTMLElement>) => void;
    surface?: Surface;
    /** `CornerRadius` (px): the container's corners, its children clipped to them. */
    cornerRadius?: number;
    /** Web `DividerColor`: a line between two children (under each one but the last), in this colour. */
    dividerColor?: string;
    /** Web `HtmlTag`: the HTML element of the container (a `section`, a `form`, a list…); `div` by default. */
    as?: string;
    /** Web `AccessibleModal`: `aria-modal` (a dialog that keeps the reader inside it). */
    'aria-modal'?: boolean;
    /** `AutoSize`: sized to its content (a push-button container like a native button) instead of filling its line. */
    autoSize?: boolean;
    /** Web `DataAttributes`: `data-*` attributes of the element (`app-chrome; panel=right`), read by styles and scripts. */
    dataAttributes?: string;
    /** @internal - given by the renderer to every element of `@kubuno/views`. */
    __view?: Internals;
    /** @internal */
    __id?: string;
}
/**
 * `DataAttributes="app-chrome; panel=right"` → `{ 'data-app-chrome': '', 'data-panel': 'right' }`: entries separated by
 * `;`, each a name (an empty attribute) or `name=value`; a name that is not a valid attribute name is ignored.
 */
export declare function dataAttributesOf(spec: string | undefined): Record<string, string>;
export type DockValue = 'None' | 'Top' | 'Bottom' | 'Left' | 'Right' | 'Fill';
/** Where a docked child goes in the dock grid: `[rowStart, rowEnd, colStart, colEnd]` (1-based lines). */
export interface DockPlacement {
    readonly row: readonly [number, number];
    readonly col: readonly [number, number];
}
export interface DockGrid {
    /** `grid-template-rows` / `-columns`. */
    readonly rows: string;
    readonly columns: string;
    readonly placements: readonly DockPlacement[];
}
/**
 * The CSS grid of a dock layout (WinForms semantics: each docked child, in document order, takes a band
 * along one edge of the room the previous ones left; `Fill` and undocked children share the rest). Columns
 * follow the inline direction, so `Left` is the inline start: a view mirrors correctly in `ar`/`he`.
 */
export declare function dockGrid(docks: readonly DockValue[]): DockGrid;
interface PanelProps extends ContainerBase {
    /** `Dock` (default) or `Absolute`. */
    layout?: 'Dock' | 'Absolute';
}
/** The edges of an `Anchor` value (`"Top, Right"`); empty or unreadable = `Top, Left`. */
export interface AnchorEdges {
    readonly top: boolean;
    readonly bottom: boolean;
    readonly left: boolean;
    readonly right: boolean;
}
export declare function parseAnchor(value: unknown): AnchorEdges;
/**
 * Where an undocked child of an absolute `Panel` goes (WinForms anchor semantics, as the desktop's
 * `panel_child_rects`): `X`/`Y`/`Width`/`Height` are authored against the panel's design size; an anchored edge
 * keeps its distance to the panel's edge when the panel is larger or smaller, both edges of an axis stretch the
 * child, neither edge keeps its size and moves by half the change. `X` counts from the inline start (it
 * mirrors in `ar`/`he`), so `Right` is the inline end. Without a design size the child stays where `X`/`Y` say.
 */
export declare function anchoredStyle(anchor: AnchorEdges, at: {
    x: number;
    y: number;
    width?: number;
    height?: number;
}, design: {
    width: number;
    height: number;
} | undefined): CSSProperties;
/**
 * `<Panel>`: children docked as bands (`Dock`); with `Layout="Absolute"` the undocked children are placed by
 * `X`/`Y`/`Width`/`Height` and kept at their `Anchor` edges, the docked ones still taking their bands.
 */
export declare const Panel: import("react").ForwardRefExoticComponent<PanelProps & import("react").RefAttributes<HTMLElement>>;
/**
 * `<UserControl>`: the root of a `.kbcontrol` - a dock container that fills the room its host gives it
 * (it shrinks with a capped host, so a `Dock="Fill"` child can scroll).
 */
export declare const UserControl: import("react").ForwardRefExoticComponent<PanelProps & import("react").RefAttributes<HTMLElement>>;
interface StackProps extends ContainerBase {
    direction?: string;
    gap?: number;
    crossAlign?: string;
    justify?: string;
    wrap?: boolean;
}
/** `<Stack>`: children along `Direction`, `Gap` px apart; a child with `Stack.Fill="true"` takes the rest. */
export declare const Stack: import("react").ForwardRefExoticComponent<StackProps & import("react").RefAttributes<HTMLElement>>;
/** One `ColumnStyles` / `RowStyles` entry → a CSS track (`Absolute 120`, `Percent 50`, `AutoSize`). */
export declare function trackOf(style: string | undefined, fallback: string): string;
/** The grid tracks of a table: `count` tracks, each from its `;`-separated style or the fallback. */
export declare function tableTracks(styles: string | undefined, count: number, fallback: string): string;
interface TableLayoutPanelProps extends ContainerBase {
    columnCount?: number;
    rowCount?: number;
    columnStyles?: string;
    rowStyles?: string;
    growStyle?: 'AddRows' | 'AddColumns' | 'FixedSize';
    cellBorderStyle?: 'None' | 'Single';
    cellSpacing?: number;
}
/**
 * `<TableLayoutPanel>`: `ColumnCount` × `RowCount` cells sized by `ColumnStyles` / `RowStyles` (a column without a
 * style gets an equal share, a row without one sizes to its content), the children placed in reading order or at
 * their `TableLayoutPanel.Row` / `.Column`, spanning `RowSpan` / `ColumnSpan`; more children than cells add rows
 * (`GrowStyle="AddRows"`) or columns (`AddColumns`). Columns follow the reading direction.
 */
export declare const TableLayoutPanel: import("react").ForwardRefExoticComponent<TableLayoutPanelProps & import("react").RefAttributes<HTMLElement>>;
interface ScrollAreaProps extends ContainerBase {
    /** `Corner`: radius of the scrolling viewport, px. */
    corner?: number;
    /** Web: `scrollbar-gutter`. */
    gutter?: 'Auto' | 'Stable' | 'StableBothEdges';
    /** Web: which axes scroll. */
    scrollBars?: 'Vertical' | 'Horizontal' | 'Both';
    /** Web `ScrollBarStyle`: `Inset` = the thin bar inset from the rounded corners (the host's `kb-inset-scroll`). */
    scrollBarStyle?: 'Default' | 'Inset';
}
/** `<ScrollArea>`: its single child scrolls inside it (it shrinks with its container: `min-height: 0`). */
export declare const ScrollArea: import("react").ForwardRefExoticComponent<ScrollAreaProps & import("react").RefAttributes<HTMLElement>>;
export {};
