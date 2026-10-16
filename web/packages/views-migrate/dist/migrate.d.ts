import { Node, type Project, type SourceFile } from 'ts-morph';
import type { Registry } from './registry.js';
import { type Role } from './layout.js';
export type Status = 'converted' | 'partial' | 'skipped';
export interface MigrateConfig {
    project: Project;
    registry: Registry;
    /** The project root (`core/web`), for relative paths in the report. */
    root: string;
    /** i18next default namespace of the project (`core`). */
    defaultNs: string;
    /** Whether `key` exists in namespace `ns`'s fallback-language bundle (a `{Res}` without it needs its default). */
    hasKey: (ns: string, key: string) => boolean;
}
export interface MigrationStats {
    elements: number;
    mapped: number;
    classAttributes: number;
    parts: number;
    getters: number;
    handlers: number;
    bindings: number;
    resources: number;
}
export interface MigrationResult {
    file: string;
    component?: string;
    status: Status;
    reasons: string[];
    stats: MigrationStats;
    /** Files to write (path → text). */
    outputs: Record<string, string>;
    /** Files to delete (the `.tsx`). */
    deletes: string[];
    /** Other files of the project rewritten (importers switched to the default export). */
    edits: Record<string, string>;
    /** `{Res}` keys missing from the fallback bundle, with the `defaultValue` the TSX gave them. */
    defaults: Array<{
        ns: string;
        key: string;
        value: string;
    }>;
}
type FnLike = Node & {
    getBody(): Node | undefined;
    getParameters(): Node[];
};
declare function pascal(s: string): string;
interface FoundComponent {
    name: string;
    fn: FnLike;
    exported: 'named' | 'default' | 'both';
}
/** Every PascalCase function component of the file, the exported ones flagged. */
export declare function componentsOf(sf: SourceFile): Array<FoundComponent & {
    exportedAt: boolean;
}>;
/**
 * Converts one TSX screen. `opts.role` is what the screen is (VIEWS-SPEC §1.1, `classify` in `layout.ts`): a view
 * (`X.kbview`, the default) or a user control (`X.kbcontrol`, its markup inside a `<UserControl>` carrying `x:Props`).
 */
export declare function migrateFile(cfg: MigrateConfig, sf: SourceFile, wanted?: string, opts?: {
    role?: Role;
}): MigrationResult;
/**
 * Indents every line of `code` but the lines inside a template literal (their spaces belong to the string: the text
 * of a `<pre>` would change).
 */
export declare function indentCode(code: string, pad: string): string;
/** The component a file's conversion targets (the exported one named like the file, or the only exported one). */
export declare function targetComponent(sf: SourceFile, wanted?: string): string | undefined;
/**
 * Switches the importers of the components about to be converted to the default export (the view's component; the
 * named export becomes the code-behind class). Run once for the whole batch BEFORE converting: a file converted in
 * the same batch then already imports its converted neighbours by default. Returns the other files changed (path →
 * text); the files of the batch are left out (they are replaced by their views).
 */
export declare function rewriteImporters(cfg: MigrateConfig, targets: ReadonlyArray<{
    sf: SourceFile;
    component: string;
}>): Record<string, string>;
export { pascal };
