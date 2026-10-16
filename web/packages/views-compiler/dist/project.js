/**
 * A web project that uses `.kbview` views, seen from Node: where its views, user controls, registries and
 * generated files are, and a compiler loaded with its registries. Shared by the Vite plugin and
 * `kbview-tsc`. Paths are handled with `node:path` and normalised to `/` in everything the compiler sees,
 * so the same project builds identically on Linux, Windows and macOS.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompilerWasm, ViewCompiler } from './compiler.js';
import { KbresCodec } from './kbres.js';
import { extractUserControlProps } from './uc-props.js';
/** View file extensions (VIEWS-SPEC §1.1). */
export const VIEW_EXTENSIONS = ['.kbview', '.kbcontrol'];
/** Where generated declarations and check files go, under the project root (git-ignored). */
export const GENERATED_DIR = '.kubuno/views';
/** Folders never scanned for views. */
const SKIP_DIRS = new Set(['node_modules', '.kubuno', '.git', 'dist', 'obj', 'bin', 'target', 'coverage']);
export function isViewFile(file) {
    const lower = file.toLowerCase();
    return VIEW_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
/** `a\b` → `a/b`. */
export function toPosix(p) {
    return p.split(sep).join('/');
}
/** `p` with its links resolved (a junction, a symbolic link); for a file not written yet, its folder's. */
function realOf(p) {
    try {
        return realpathSync.native(p);
    }
    catch {
        const parent = dirname(p);
        return parent === p ? p : join(realOf(parent), p.slice(parent.length).replace(/^[\\/]+/, ''));
    }
}
/**
 * `file` relative to `root` (native separators). When `file` seems outside `root` but is inside it through a link
 * (Vite hands out real paths: a root reached through a junction, `C:\x` → `E:\x`, gives file ids on the other
 * drive), the path relative to the root's real path.
 */
function relativeToRoot(root, file) {
    const rel = relative(resolve(root), resolve(file));
    if (rel && !isAbsolute(rel) && !rel.split(/[\\/]/).includes('..'))
        return rel;
    const real = relative(realOf(resolve(root)), realOf(resolve(file)));
    return real && !isAbsolute(real) && !real.split(/[\\/]/).includes('..') ? real : rel;
}
/** The project-root-relative, `/`-separated path of `file`. */
export function projectPath(root, file) {
    return toPosix(relativeToRoot(root, file));
}
/** The same-stem code-behind of a view (`X.ts`, else `X.tsx`), if any. */
export function codeBehindOf(viewFile) {
    const base = viewFile.replace(/\.(kbview|kbcontrol)$/i, '');
    for (const ext of ['.ts', '.tsx']) {
        if (existsSync(base + ext))
            return base + ext;
    }
    return null;
}
/** The view a code-behind belongs to (`X.ts` → `X.kbview` / `X.kbcontrol`), if any. */
export function viewOfCodeBehind(file) {
    const m = /^(.*)\.(ts|tsx)$/.exec(file);
    if (!m || /\.d\.ts$/.test(file))
        return null;
    for (const ext of VIEW_EXTENSIONS) {
        if (existsSync(m[1] + ext))
            return m[1] + ext;
    }
    return null;
}
/** The stem of a view file (`NotesSettingsPage`). */
export function viewStem(file) {
    const name = file.split(/[\\/]/).pop() ?? file;
    return name.replace(/\.(kbview|kbcontrol)$/i, '');
}
/** Every view under `dirs` (relative to `root`), sorted. */
export function scanViews(root, dirs = ['src']) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of entries) {
            if (SKIP_DIRS.has(name))
                continue;
            const full = join(dir, name);
            let st;
            try {
                st = statSync(full);
            }
            catch {
                continue;
            }
            if (st.isDirectory())
                walk(full);
            else if (isViewFile(name))
                out.push(full);
        }
    };
    for (const d of dirs)
        walk(resolve(root, d));
    return out.sort();
}
/**
 * The user controls of the project: one per `.kbcontrol`, rendered by its code-behind (else itself). When the
 * control names an `x:Props` type, its members are read from the code-behind (WV-7) so another view can use it
 * as a native, typed element (`props`); a control without `x:Props` keeps the earlier pass-through behaviour.
 *
 * A `.kbview` that declares an `x:Props` is *also* exposed as a native, typed element: an `x:Props` makes the view
 * a parametrized component (same `ViewBase` + `.component()` shape as a control), so a container view can place it
 * as `<ThatView .../>` instead of wrapping it in a React host. A `.kbview` with no `x:Props` is a plain screen and
 * is not exposed (its name would only pollute the element namespace).
 */
export function userControlsOf(root, views) {
    const out = [];
    for (const v of views) {
        const lower = v.toLowerCase();
        const isControl = lower.endsWith('.kbcontrol');
        const isView = lower.endsWith('.kbview');
        if (!isControl && !isView)
            continue;
        const cb = codeBehindOf(v);
        const props = extractUserControlProps(v, cb);
        // A control is always exposed (pass-through when it has no x:Props, as before). A view is exposed only when it
        // declares an x:Props - that is the signal that it is meant to be used as a typed component, not just a screen.
        if (isView && !(props && props.length > 0))
            continue;
        const module = cb ? cb.replace(/\.(ts|tsx)$/, '') : v;
        const ref = { name: viewStem(v), module: '/' + projectPath(root, module) };
        if (props && props.length > 0)
            ref.props = props;
        out.push(ref);
    }
    return out;
}
/** Folder (under {@link GENERATED_DIR}) of the generated files of views outside the project root. */
export const EXTERNAL_DIR = '_external';
/**
 * The path of a view's generated files relative to {@link GENERATED_DIR}, `/`-separated - always inside it.
 *
 * A view under the project root keeps its root-relative path (`src/A.kbview`). A view outside it (a sibling
 * folder, another drive) goes under `_external/` followed by its absolute path's segments: a leading `\\?\`
 * removed, empty and `.` segments dropped, `:` removed (`C:` → `C`), `..` → `_up` - so neither `..` nor a drive
 * letter can lead out of the folder. The language server (`kubuno-views-ls`, `web/project.rs`) applies the same
 * rule, byte for byte.
 */
export function generatedRelPath(root, viewFile) {
    const rel = relativeToRoot(root, viewFile);
    const segments = rel.split(/[\\/]/);
    if (rel && !isAbsolute(rel) && !segments.includes('..'))
        return segments.filter((s) => s && s !== '.').join('/');
    const external = resolve(viewFile)
        .replace(/^\\\\\?\\/, '')
        .split(/[\\/]/)
        .filter((s) => s && s !== '.')
        .map((s) => (s === '..' ? '_up' : s.replace(/:/g, '')))
        .filter((s) => s);
    return [EXTERNAL_DIR, ...external].join('/');
}
/** The generated files of a view (always under `<root>/.kubuno/views`, see {@link generatedRelPath}). */
export function generatedPaths(root, viewFile) {
    const base = join(root, GENERATED_DIR, ...generatedRelPath(root, viewFile).split('/'));
    return { dts: base + '.d.ts', check: base + '.check.ts', map: base + '.check.json' };
}
/** Writes `text` unless the file already holds it (keeps tsc's incremental state and watchers quiet). */
export function writeIfChanged(file, text) {
    try {
        if (readFileSync(file, 'utf8') === text)
            return false;
    }
    catch {
        // Missing: written below.
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return true;
}
/** Writes the declarations and the check file (+ its span map) of one compiled view. */
export function writeGenerated(root, viewFile, out) {
    const paths = generatedPaths(root, viewFile);
    writeIfChanged(paths.dts, out.dts);
    writeIfChanged(paths.check, out.check);
    const map = {
        view: projectPath(root, viewFile),
        class_name: out.class_name,
        spans: out.check_map,
        handlers: out.handlers,
    };
    writeIfChanged(paths.map, JSON.stringify(map) + '\n');
}
export function readProjectConfig(root) {
    const file = join(root, 'kubuno.views.json');
    if (!existsSync(file))
        return {};
    return JSON.parse(readFileSync(file, 'utf8'));
}
/** The host registry: `node_modules/@kubuno/ui/kbview-registry.web.json`, searched upwards from `root`. */
export function findHostRegistry(root) {
    let dir = resolve(root);
    for (;;) {
        const candidate = join(dir, 'node_modules', '@kubuno', 'ui', 'kbview-registry.web.json');
        if (existsSync(candidate))
            return candidate;
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/**
 * A project registry with its project-local modules rewritten to project-root-relative specifiers
 * (`./controls` next to `src/kbview-controls.json` → `/src/controls`), what the compiler expects.
 */
export function projectRegistryJson(root, file) {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const dir = projectPath(root, dirname(file));
    const rewrite = (m) => {
        if (!m || !(m.startsWith('./') || m.startsWith('../')))
            return m;
        return '/' + posix.normalize(posix.join(dir, m));
    };
    for (const c of doc.components ?? []) {
        if (!c.web)
            continue;
        c.web.module = rewrite(c.web.module);
        for (const a of c.web.alternates ?? [])
            a.module = rewrite(a.module);
    }
    return JSON.stringify(doc);
}
/** The `.wasm` shipped in the package (`wasm/kubuno-views-web.wasm`, next to `src/` and `dist/`). */
export function wasmPath() {
    // `KBVIEW_WASM` overrides (environments whose import.meta.url is not a file URL, e.g. jsdom tests).
    if (process.env.KBVIEW_WASM)
        return process.env.KBVIEW_WASM;
    return fileURLToPath(new URL('../wasm/kubuno-views-web.wasm', import.meta.url));
}
let wasmModule = null;
/** A compiler instance over the shipped `.wasm` (compiled once per process). */
export async function loadNodeCompiler() {
    wasmModule ??= WebAssembly.compile(readFileSync(wasmPath()));
    return new ViewCompiler(await CompilerWasm.instantiate(await wasmModule));
}
/** The `.kbres` reader / writer over the same `.wasm` (one instance per call). */
export async function loadNodeKbres() {
    wasmModule ??= WebAssembly.compile(readFileSync(wasmPath()));
    return new KbresCodec(await CompilerWasm.instantiate(await wasmModule));
}
/** A project: its root, its views, and a compiler loaded with its registries and user controls. */
export class ViewProject {
    root;
    compiler;
    views = [];
    hostRegistry;
    /** The project registries loaded after the host's (absolute paths, in loading order). */
    registries;
    sources;
    constructor(root, compiler, hostRegistry, registries, sources) {
        this.root = root;
        this.compiler = compiler;
        this.hostRegistry = hostRegistry;
        this.registries = registries;
        this.sources = sources;
    }
    static async open(root, options = {}) {
        const config = readProjectConfig(root);
        const hostOption = options.hostRegistry ?? config.hostRegistry;
        const host = hostOption ? (isAbsolute(hostOption) ? hostOption : resolve(root, hostOption)) : findHostRegistry(root);
        if (!host || !existsSync(host)) {
            throw new Error(`@kubuno/views-compiler: no element registry found (expected node_modules/@kubuno/ui/kbview-registry.web.json, or set "hostRegistry" in kubuno.views.json / the plugin options)`);
        }
        const compiler = await loadNodeCompiler();
        compiler.addRegistry(readFileSync(host, 'utf8'), projectPath(root, host) || host, true);
        const registries = [...(config.registries ?? []), ...(options.registries ?? [])].map((reg) => resolve(root, reg));
        for (const file of registries) {
            compiler.addRegistry(projectRegistryJson(root, file), projectPath(root, file), false);
        }
        const project = new ViewProject(root, compiler, host, registries, options.sources ?? config.sources ?? ['src']);
        project.rescan();
        return project;
    }
    /** Re-lists the views and the user controls. */
    rescan() {
        this.views = scanViews(this.root, this.sources);
        this.compiler.setUserControls(userControlsOf(this.root, this.views));
    }
    /** Compiles one view file (read from disk unless `source` is given). */
    compile(viewFile, source, design = false) {
        const text = (source ?? readFileSync(viewFile, 'utf8')).replace(/^﻿/, '');
        const cb = codeBehindOf(viewFile);
        return this.compiler.compile(text, {
            file: projectPath(this.root, viewFile),
            code_behind: cb ? './' + (cb.split(/[\\/]/).pop() ?? '').replace(/\.(ts|tsx)$/, '') : null,
            design,
        });
    }
    /** Compiles every view and writes its generated files; returns the outputs by file. */
    generateAll() {
        const out = new Map();
        const keep = new Set();
        for (const v of this.views) {
            const result = this.compile(v);
            writeGenerated(this.root, v, result);
            out.set(v, result);
            for (const p of Object.values(generatedPaths(this.root, v)))
                keep.add(resolve(p));
        }
        removeStaleGenerated(join(this.root, GENERATED_DIR), keep);
        return out;
    }
}
/**
 * Deletes the generated files of views that no longer exist (a view renamed, moved or turned back into TSX): left
 * behind, their check files would still be type-checked and fail against a code-behind that is gone.
 */
export function removeStaleGenerated(dir, keep) {
    let removed = 0;
    const walk = (d) => {
        let entries;
        try {
            entries = readdirSync(d);
        }
        catch {
            return;
        }
        for (const name of entries) {
            const full = join(d, name);
            let st;
            try {
                st = statSync(full);
            }
            catch {
                continue;
            }
            if (st.isDirectory())
                walk(full);
            else if (/\.(kbview|kbcontrol)\.(d\.ts|check\.ts|check\.json)$/.test(name) && !keep.has(resolve(full))) {
                rmSync(full, { force: true });
                removed++;
            }
        }
    };
    walk(dir);
    return removed;
}
