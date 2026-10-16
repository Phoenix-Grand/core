import type { CompilerWasm } from './compiler.js';
/** One `String` entry. */
export interface KbresString {
    name: string;
    value: string;
    comment?: string;
}
/** A positioned problem of a `.kbres` file. */
export interface KbresDiagnostic {
    severity: 'error' | 'warning';
    line: number;
    column: number;
    message: string;
}
/** The strings of one `.kbres` file (its other entries - images, colours… - are not i18n strings). */
export interface KbresDocument {
    /** `Culture` of a neutral file: the language of its strings. */
    culture?: string;
    strings: KbresString[];
    /** How many non-`String` entries the file has. */
    others: number;
    diagnostics: KbresDiagnostic[];
}
/** An i18next bundle: nested objects of strings. */
export interface I18nBundle {
    [key: string]: string | I18nBundle;
}
/** The language of a neutral file without a `Culture` attribute. */
export declare const DEFAULT_NEUTRAL_CULTURE = "en";
/** `.kbres` reading and canonical writing, over the compiler's WebAssembly module. */
export declare class KbresCodec {
    private readonly wasm;
    constructor(wasm: CompilerWasm);
    parse(text: string): KbresDocument;
    /** The canonical text of a file holding `strings` (a neutral file names its `culture`). */
    write(strings: readonly KbresString[], culture?: string): string;
}
/** `strings.fr.kbres` → `{ stem: 'strings', culture: 'fr' }`; a neutral file has no culture. */
export declare function kbresName(file: string): {
    stem: string;
    culture?: string;
};
/** The neutral file and the satellites (`culture → path`, sorted by culture) of the set `file` belongs to. */
export declare function kbresSet(file: string): {
    neutral: string;
    satellites: Map<string, string>;
};
/**
 * A key segment holding a dot (`errors: { "token.invalid": … }`, which i18next finds too) is written `token\.invalid` in
 * the entry name, a backslash `\\`: the name splits on the other dots only, so the nesting round-trips exactly.
 */
export declare function escapeSegment(segment: string): string;
/** An entry name → its key segments (`a.b\.c` → `["a", "b.c"]`). */
export declare function splitName(name: string): string[];
/** Nested i18next bundle of a file's strings; an entry whose name collides with a group is an error. */
export declare function nestStrings(strings: readonly KbresString[]): {
    bundle: I18nBundle;
    problems: string[];
};
/** The strings of an i18next bundle, depth first in key order (the inverse of {@link nestStrings}). */
export declare function flattenBundle(bundle: Readonly<Record<string, unknown>>, where?: string): KbresString[];
/** The i18next bundles of a `.kbres` set, by language. */
export interface CompiledKbresSet {
    bundles: Record<string, I18nBundle>;
    /** Every file read (to watch). */
    files: string[];
    /** `file(line,col): message` lines; errors make the set unusable. */
    errors: string[];
    warnings: string[];
}
/** Reads a set (`file` = its neutral file or one of its satellites) into i18next bundles. */
export declare function compileKbresSet(codec: KbresCodec, file: string, neutralCulture?: string): CompiledKbresSet;
/** The `.kbres` texts of i18next bundles: `neutral` (one of the bundles' languages) and one satellite per other. */
export declare function bundlesToKbres(codec: KbresCodec, bundles: Readonly<Record<string, Readonly<Record<string, unknown>>>>, neutral: string, where?: string): {
    neutral: string;
    satellites: Record<string, string>;
};
/** The ES module of a set for the Vite plugin: `export default { en: {…}, … }`. */
export declare function kbresModule(set: CompiledKbresSet): string;
