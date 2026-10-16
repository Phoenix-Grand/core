/**
 * `.kbres` string resources on the web (vskubuno docs/WEB-VIEWS.md §1.2 and lot WV-6).
 *
 * A `.kbres` set is a neutral file (`strings.kbres`, its language named by `<Resources Culture="en">`, English when
 * absent) and its satellites in the same folder (`strings.fr.kbres`, `strings.ar.kbres`…), the desktop's format
 * (`kubuno-desktop-resources-model`, read and written here through the same Rust code compiled to WebAssembly -
 * one grammar, never a second parser). On the web a set becomes **i18next bundles**: one object per language, the
 * entries' names split on `.` into nested keys (`header.settings` → `{ header: { settings } }`), plural forms kept as
 * i18next names them (`files_one`, `files_other`). `import strings from './strings.kbres'` gives
 * `{ en: {…}, fr: {…}, … }`, ready for `registerModuleTranslations(ns, strings)`; `{Res key}` reads them through
 * i18next.
 *
 * The other direction (`bundlesToKbres`) turns i18next bundles back into a set: what the `kbres-convert` tool does
 * with a module's `i18n.ts` / `locales/<lang>/<ns>.json`. Both directions are lossless for i18next string bundles:
 * the same keys, the same values, the same key order (`i18n-convert.test.ts` proves it on the core's own bundles in
 * the 13 languages).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
/** The language of a neutral file without a `Culture` attribute. */
export const DEFAULT_NEUTRAL_CULTURE = 'en';
/** `.kbres` reading and canonical writing, over the compiler's WebAssembly module. */
export class KbresCodec {
    wasm;
    constructor(wasm) {
        this.wasm = wasm;
    }
    parse(text) {
        return this.wasm.call({ op: 'kbres_parse', text });
    }
    /** The canonical text of a file holding `strings` (a neutral file names its `culture`). */
    write(strings, culture) {
        return this.wasm.call({ op: 'kbres_write', strings, culture }).text;
    }
}
const CULTURE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
/** `strings.fr.kbres` → `{ stem: 'strings', culture: 'fr' }`; a neutral file has no culture. */
export function kbresName(file) {
    const name = basename(file).replace(/\.kbres$/i, '');
    const dot = name.lastIndexOf('.');
    if (dot > 0 && CULTURE.test(name.slice(dot + 1)))
        return { stem: name.slice(0, dot), culture: name.slice(dot + 1) };
    return { stem: name };
}
/** The neutral file and the satellites (`culture → path`, sorted by culture) of the set `file` belongs to. */
export function kbresSet(file) {
    const dir = dirname(file);
    const { stem } = kbresName(file);
    const neutral = join(dir, `${stem}.kbres`);
    const satellites = new Map();
    let names = [];
    try {
        names = readdirSync(dir).sort();
    }
    catch {
        // A missing folder: the neutral file alone (reported when it is read).
    }
    for (const name of names) {
        if (!name.toLowerCase().endsWith('.kbres'))
            continue;
        const n = kbresName(name);
        if (n.stem === stem && n.culture)
            satellites.set(n.culture, join(dir, name));
    }
    return { neutral, satellites };
}
/**
 * A key segment holding a dot (`errors: { "token.invalid": … }`, which i18next finds too) is written `token\.invalid` in
 * the entry name, a backslash `\\`: the name splits on the other dots only, so the nesting round-trips exactly.
 */
export function escapeSegment(segment) {
    return segment.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
}
/** An entry name → its key segments (`a.b\.c` → `["a", "b.c"]`). */
export function splitName(name) {
    const out = [];
    let cur = '';
    for (let i = 0; i < name.length; i++) {
        const c = name[i];
        if (c === '\\' && i + 1 < name.length)
            cur += name[++i];
        else if (c === '.') {
            out.push(cur);
            cur = '';
        }
        else
            cur += c;
    }
    out.push(cur);
    return out;
}
/** Nested i18next bundle of a file's strings; an entry whose name collides with a group is an error. */
export function nestStrings(strings) {
    const bundle = {};
    const problems = [];
    for (const s of strings) {
        const path = splitName(s.name);
        let at = bundle;
        let ok = true;
        for (let i = 0; i < path.length - 1; i++) {
            const seg = path[i];
            const next = at[seg];
            if (next === undefined)
                at = at[seg] = {};
            else if (typeof next === 'object')
                at = next;
            else {
                problems.push(`\`${s.name}\`: \`${path.slice(0, i + 1).join('.')}\` is a string, not a group`);
                ok = false;
                break;
            }
        }
        if (!ok)
            continue;
        const leaf = path[path.length - 1];
        if (typeof at[leaf] === 'object')
            problems.push(`\`${s.name}\` is also a group of keys`);
        else
            at[leaf] = s.value;
    }
    return { bundle, problems };
}
/** The strings of an i18next bundle, depth first in key order (the inverse of {@link nestStrings}). */
export function flattenBundle(bundle, where = 'bundle') {
    const out = [];
    const walk = (o, prefix) => {
        for (const [k, v] of Object.entries(o)) {
            if (k === '')
                throw new Error(`${where}: an empty key under \`${prefix}\` cannot be a .kbres name`);
            const name = prefix + escapeSegment(k);
            if (typeof v === 'string')
                out.push({ name, value: v });
            else if (v && typeof v === 'object' && !Array.isArray(v))
                walk(v, name + '.');
            else
                throw new Error(`${where}: \`${name}\` is ${Array.isArray(v) ? 'an array' : typeof v}, not a string (only string bundles convert to .kbres)`);
        }
    };
    walk(bundle, '');
    return out;
}
/** Reads a set (`file` = its neutral file or one of its satellites) into i18next bundles. */
export function compileKbresSet(codec, file, neutralCulture = DEFAULT_NEUTRAL_CULTURE) {
    const { neutral, satellites } = kbresSet(file);
    const result = { bundles: {}, files: [], errors: [], warnings: [] };
    const read = (path, culture) => {
        result.files.push(path);
        if (!existsSync(path)) {
            result.errors.push(`${path}: the set's neutral file is missing`);
            return;
        }
        const doc = codec.parse(readFileSync(path, 'utf8'));
        for (const d of doc.diagnostics)
            (d.severity === 'error' ? result.errors : result.warnings).push(`${path}(${d.line},${d.column}): ${d.message}`);
        const lang = culture ?? doc.culture ?? neutralCulture;
        if (culture && doc.culture && doc.culture !== culture) {
            result.warnings.push(`${path}: Culture="${doc.culture}" differs from the file name's culture (${culture}); the file name wins`);
        }
        const { bundle, problems } = nestStrings(doc.strings);
        for (const p of problems)
            result.errors.push(`${path}: ${p}`);
        if (result.bundles[lang])
            result.errors.push(`${path}: a second file for the language ${lang}`);
        else
            result.bundles[lang] = bundle;
    };
    read(neutral, undefined);
    for (const [culture, path] of satellites)
        read(path, culture);
    return result;
}
/** The `.kbres` texts of i18next bundles: `neutral` (one of the bundles' languages) and one satellite per other. */
export function bundlesToKbres(codec, bundles, neutral, where = 'bundles') {
    if (!bundles[neutral])
        throw new Error(`${where}: no bundle for the neutral language ${neutral}`);
    const satellites = {};
    for (const [lang, bundle] of Object.entries(bundles)) {
        if (lang === neutral)
            continue;
        satellites[lang] = codec.write(flattenBundle(bundle, `${where} (${lang})`));
    }
    return { neutral: codec.write(flattenBundle(bundles[neutral], `${where} (${neutral})`), neutral), satellites };
}
/** The ES module of a set for the Vite plugin: `export default { en: {…}, … }`. */
export function kbresModule(set) {
    return `export default ${JSON.stringify(set.bundles)}\n`;
}
