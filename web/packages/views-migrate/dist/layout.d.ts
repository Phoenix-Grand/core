import { ts } from 'ts-morph';
export type Role = 'view' | 'control';
/** What a view or a user control is, more precisely: the folder it goes to follows from it. */
export type Kind = 
/** A view a route renders (or a registry the router reads, `ADMIN_SECTIONS`). */
'page'
/** A view shown above the page: a full-screen viewer, a floating window. */
 | 'window'
/** A dialog or a wizard. */
 | 'dialog'
/** A user control placed by one component only (a page's pane, a list's row). */
 | 'part'
/** A user control placed by several components. */
 | 'shared';
/** How a file uses a component. */
export type UsageHow = 
/** Rendered by a route (`<Route element>`, `RouteRegistry.register`, a `routes` / `sections` table). */
'route'
/** Placed as a JSX element, or rendered by a view's `<ReactHost>`. */
 | 'jsx'
/** Handed to a host as a value (a slot, an extension point, a registry): the host places it. */
 | 'host'
/** Re-exported: whoever imports it from there places it. */
 | 'reexport';
export interface Usage {
    /** The file using the component. */
    file: string;
    how: UsageHow;
    /** 1-based line of the use. */
    line: number;
}
/** The files of one component, by stem: the view, its code-behind and parts, or a React component's `.tsx`. */
export interface Unit {
    /** The component's name (the file stem). */
    stem: string;
    dir: string;
    /** The `.kbview` / `.kbcontrol`, when the component is a view. */
    view?: string;
    /** The module importers import: the code-behind (`X.ts` / `X.tsx`) or the React component's `.tsx`. */
    module: string;
    /** Every file of the unit (view, code-behind, parts, design data, tests, resources). */
    files: string[];
}
export interface Classified extends Unit {
    role: Role;
    kind: Kind;
    /** Why, in a few words (the report shows it). */
    reason: string;
    usages: Usage[];
    /** The distinct components placing it (code-behind, parts and view of one view count as one). */
    hosts: string[];
}
/** The role folders (VIEWS-SPEC §1.2): reserved names at an app root and in a folder split by role. */
export declare const ROLE_FOLDERS: readonly ["views", "dialogs", "pages", "controls"];
/** The folder of each kind. */
export declare const FOLDER_OF: Readonly<Record<Kind, (typeof ROLE_FOLDERS)[number]>>;
/** Every file under `dir` (absolute, `/`-separated), the build and generated folders left out. */
export declare function listFiles(dir: string): string[];
export declare function slash(p: string): string;
/** The stem a file belongs to (`X.parts.tsx`, `X.kbview.design.json`, `X.test.tsx`, `X.fr.kbres` → `X`). */
export declare function stemOf(file: string): string;
/**
 * The units of the project under `dirs`: every view (with its code-behind and parts), and - with `components` -
 * every React component file (`X.tsx`, PascalCase, rendering JSX) that is no view's code-behind or parts.
 */
export declare function unitsOf(files: readonly string[], opts?: {
    components?: boolean;
    exclude?: readonly string[];
}): Unit[];
/** The file a relative specifier names, among `exists`, or undefined (a package, an alias, a missing file). */
export declare function resolveSpecifier(from: string, spec: string, exists: (p: string) => boolean): string | undefined;
/** The source of the project: path → text (the code files read from disk, plus any pending outputs). */
export type Sources = Map<string, string>;
/** Reads the TypeScript files of `files` (`.ts`, `.tsx`, not `.d.ts`). */
export declare function readSources(files: readonly string[]): Sources;
/** How the identifier `id` (a use of an imported component) uses it. */
export declare function usageOf(id: ts.Node, sf: ts.SourceFile): UsageHow;
/** Window or dialog, from a view's markup: its root element, a full-screen overlay, a modal surface. */
export declare function surfaceOfView(xml: string, stem: string): 'window' | 'dialog' | undefined;
/** Window or dialog, from a React component's source: the element its body returns first. */
export declare function surfaceOfComponent(text: string, stem: string): 'window' | 'dialog' | undefined;
/**
 * The role of every unit (VIEWS-SPEC §1.1), from how `sources` use it:
 * 1. a view whose root is already `<UserControl>` stays a user control;
 * 2. a window or a dialog (its root element, a full-screen overlay, its name) is a view;
 * 3. a component a route renders (alone: not next to other elements), or the application's root component renders
 *    in place of the routes, is a view (a page);
 * 4. a component other components place (JSX, a `<ReactHost>`, a host's slot) is a user control - `shared` when
 *    several components place it;
 * 5. a component nothing uses is a view when named like one (`…Page`, `…Screen`), else a user control.
 */
export declare function classify(units: readonly Unit[], sources: Sources, extraFiles?: readonly string[], opts?: {
    appComponents?: readonly string[];
}): Classified[];
export interface LayoutOptions {
    /** The app roots: their own components go to role folders (`src` of a module, `src/core` of the core). */
    roots: readonly string[];
    /** A folder holding more than this many views directly is split by role too (default 12). */
    split?: number;
    /** Folders left as they are (a gallery of samples). */
    exclude?: readonly string[];
    /** Units placed by hand (a feature folder): the unit's view or module → its folder. */
    place?: ReadonlyMap<string, string>;
    /** Units renamed (a user control whose name another one, or a host element, already has): view or module → stem. */
    rename?: ReadonlyMap<string, string>;
    /** The application's root component, which stays where it is (default `App`). */
    appComponents?: readonly string[];
}
export interface Move {
    from: string;
    to: string;
}
/**
 * Where each unit goes (VIEWS-SPEC §1.2): at an app root, and in a folder past `split` views, the role folders -
 * `views/` (pages, windows), `dialogs/`, `pages/` (user controls one component places: panes, sections, rows) and
 * `controls/` (user controls several components place). A feature folder below keeps its views and user controls
 * side by side. A view changing kind changes extension (`.kbview` ↔ `.kbcontrol`), its design data with it.
 */
export declare function planLayout(units: readonly Classified[], opts: LayoutOptions): Move[];
export interface Relocation {
    /** The files to write at their new place (moved files, with their imports rewritten). */
    moved: Map<string, string>;
    /** The files rewritten in place (their imports name moved files). */
    edited: Map<string, string>;
}
/**
 * Applies `moves` to `sources` (code files, path → text): every relative specifier naming a moved file - or written
 * in a moved file - is rewritten, and the code-behind / parts headers follow a view's new extension. Files other than
 * code (views, design data, resources) are moved by the caller (`git mv`); `exists` tells which files there are.
 */
export declare function relocate(sources: Sources, moves: readonly Move[], exists: (p: string) => boolean): Relocation;
/**
 * A view's markup as a user control's: the root element goes inside a `<UserControl>`, which takes the file's own
 * attributes (`x:Props`, `DesignWidth`, `DesignHeight`, namespaces). The runtime gives such a root (nothing of its own
 * but the file's attributes, one element) no box of its own: the control renders exactly as the view did.
 */
export declare function toControlText(xml: string): string;
/**
 * A user control's markup as a view's: a `<UserControl>` root holding one element and nothing of its own gives its
 * attributes back to that element. Any other user control is left as it is (`undefined`): a view whose root docks
 * its children is written by hand.
 */
export declare function toViewText(xml: string): string | undefined;
/**
 * The user controls whose element name is taken (VIEWS-SPEC §1.1: a user control is an element named after its
 * file, unique in the project and distinct from the host's elements): name → the files claiming it.
 */
export declare function nameCollisions(units: readonly Classified[], hostNames: ReadonlySet<string>, rename?: ReadonlyMap<string, string>): Map<string, string[]>;
/** Whether a file exists among `files` or on disk. */
export declare function existsIn(files: Iterable<string>): (p: string) => boolean;
