import { ViewCompiler } from './compiler.js';
import { KbresCodec } from './kbres.js';
import type { CompileOutput, UserControlRef } from './types.js';
/** View file extensions (VIEWS-SPEC §1.1). */
export declare const VIEW_EXTENSIONS: readonly [".kbview", ".kbcontrol"];
/** Where generated declarations and check files go, under the project root (git-ignored). */
export declare const GENERATED_DIR = ".kubuno/views";
export declare function isViewFile(file: string): boolean;
/** `a\b` → `a/b`. */
export declare function toPosix(p: string): string;
/** The project-root-relative, `/`-separated path of `file`. */
export declare function projectPath(root: string, file: string): string;
/** The same-stem code-behind of a view (`X.ts`, else `X.tsx`), if any. */
export declare function codeBehindOf(viewFile: string): string | null;
/** The view a code-behind belongs to (`X.ts` → `X.kbview` / `X.kbcontrol`), if any. */
export declare function viewOfCodeBehind(file: string): string | null;
/** The stem of a view file (`NotesSettingsPage`). */
export declare function viewStem(file: string): string;
/** Every view under `dirs` (relative to `root`), sorted. */
export declare function scanViews(root: string, dirs?: readonly string[]): string[];
/**
 * The user controls of the project: one per `.kbcontrol`, rendered by its code-behind (else itself). When the
 * control names an `x:Props` type, its members are read from the code-behind (WV-7) so another view can use it
 * as a native, typed element (`props`); a control without `x:Props` keeps the earlier pass-through behaviour.
 */
export declare function userControlsOf(root: string, views: readonly string[]): UserControlRef[];
/** Folder (under {@link GENERATED_DIR}) of the generated files of views outside the project root. */
export declare const EXTERNAL_DIR = "_external";
/**
 * The path of a view's generated files relative to {@link GENERATED_DIR}, `/`-separated — always inside it.
 *
 * A view under the project root keeps its root-relative path (`src/A.kbview`). A view outside it (a sibling
 * folder, another drive) goes under `_external/` followed by its absolute path's segments: a leading `\\?\`
 * removed, empty and `.` segments dropped, `:` removed (`C:` → `C`), `..` → `_up` — so neither `..` nor a drive
 * letter can lead out of the folder. The language server (`kubuno-views-ls`, `web/project.rs`) applies the same
 * rule, byte for byte.
 */
export declare function generatedRelPath(root: string, viewFile: string): string;
/** The generated files of a view (always under `<root>/.kubuno/views`, see {@link generatedRelPath}). */
export declare function generatedPaths(root: string, viewFile: string): {
    dts: string;
    check: string;
    map: string;
};
/** Writes `text` unless the file already holds it (keeps tsc's incremental state and watchers quiet). */
export declare function writeIfChanged(file: string, text: string): boolean;
/** Writes the declarations and the check file (+ its span map) of one compiled view. */
export declare function writeGenerated(root: string, viewFile: string, out: CompileOutput): void;
/** `kubuno.views.json` (VIEWS-SPEC §1): target, extra registries, view folders, `Class` budget. */
export interface ProjectConfig {
    target?: 'web' | 'desktop';
    /** Project registries (custom controls), relative to the project root. */
    registries?: string[];
    /** Folders scanned for views (default `["src"]`). */
    sources?: string[];
    classBudget?: number;
    /** The host registry file (default: `@kubuno/ui/kbview-registry.web.json` from node_modules). */
    hostRegistry?: string;
    /**
     * The Visual Studio design surface served by the dev server (`/__kubuno_design__/`): its entry module (a
     * project-root-relative file; default `@kubuno/host-runtime/entry`), a folder of Kubuno themes it can apply
     * (default: the host runtime's), and the project modules the page imports before it renders (`setup`: the
     * project's stylesheet, its translations).
     */
    design?: {
        entry?: string;
        themes?: string;
        setup?: string[];
    };
}
export declare function readProjectConfig(root: string): ProjectConfig;
/** The host registry: `node_modules/@kubuno/ui/kbview-registry.web.json`, searched upwards from `root`. */
export declare function findHostRegistry(root: string): string | null;
/**
 * A project registry with its project-local modules rewritten to project-root-relative specifiers
 * (`./controls` next to `src/kbview-controls.json` → `/src/controls`), what the compiler expects.
 */
export declare function projectRegistryJson(root: string, file: string): string;
/** The `.wasm` shipped in the package (`wasm/kubuno-views-web.wasm`, next to `src/` and `dist/`). */
export declare function wasmPath(): string;
/** A compiler instance over the shipped `.wasm` (compiled once per process). */
export declare function loadNodeCompiler(): Promise<ViewCompiler>;
/** The `.kbres` reader / writer over the same `.wasm` (one instance per call). */
export declare function loadNodeKbres(): Promise<KbresCodec>;
export interface ProjectOptions {
    /** Host registry file; default: from `kubuno.views.json`, else `@kubuno/ui` in node_modules. */
    hostRegistry?: string;
    /** Extra project registries (relative to the root). */
    registries?: string[];
    /** Folders scanned for views. */
    sources?: string[];
}
/** A project: its root, its views, and a compiler loaded with its registries and user controls. */
export declare class ViewProject {
    readonly root: string;
    readonly compiler: ViewCompiler;
    views: string[];
    readonly hostRegistry: string;
    /** The project registries loaded after the host's (absolute paths, in loading order). */
    readonly registries: string[];
    readonly sources: string[];
    private constructor();
    static open(root: string, options?: ProjectOptions): Promise<ViewProject>;
    /** Re-lists the views and the user controls. */
    rescan(): void;
    /** Compiles one view file (read from disk unless `source` is given). */
    compile(viewFile: string, source?: string, design?: boolean): CompileOutput;
    /** Compiles every view and writes its generated files; returns the outputs by file. */
    generateAll(): Map<string, CompileOutput>;
}
/**
 * Deletes the generated files of views that no longer exist (a view renamed, moved or turned back into TSX): left
 * behind, their check files would still be type-checked and fail against a code-behind that is gone.
 */
export declare function removeStaleGenerated(dir: string, keep: ReadonlySet<string>): number;
