/**
 * Plan → ES module: the production/dev form of a compiled view (WEB-VIEWS §2.1, option (c)).
 *
 * The module exports `plan` (the compiler's plan with the components and Lucide icons imported, every
 * binding given a precompiled getter `g` / setter `s`, every event a dispatcher `f`) and `ViewBase` (the
 * generated base class of the code-behind), plus a default component when the view has no code-behind.
 * Every accessor and dispatcher carries a source-map segment to its attribute in the `.kbview`.
 *
 * Imports are limited to the host singletons (`@kubuno/views`, `@ui`, `@kubuno/sdk`, `@kubuno/drive`),
 * `lucide-react` (icons, bundled as today) and the project's own files - the module isolation rule.
 */
import { posix } from 'node:path';
import { encodeMappings } from './sourcemap.js';
/** Lower-case aliases of the Kubuno icon set (ICONS.md). */
export const ICON_ALIASES = { trash: 'Trash2', close: 'X' };
const HOST = new Set(['@ui', '@kubuno/sdk', '@kubuno/drive', '@kubuno/views']);
class Writer {
    lines = [''];
    segments = [[]];
    write(text, at) {
        if (at)
            this.mark(at);
        const parts = text.split('\n');
        this.lines[this.lines.length - 1] += parts[0];
        for (const p of parts.slice(1)) {
            this.lines.push(p);
            this.segments.push([]);
        }
    }
    /** Maps the current generated position to `at` (1-based line / column of the `.kbview`). */
    mark(at) {
        const col = this.lines[this.lines.length - 1].length;
        this.segments[this.segments.length - 1].push({ col, srcLine: at[0] - 1, srcCol: Math.max(0, at[1] - 1) });
    }
    newline() {
        this.lines.push('');
        this.segments.push([]);
    }
}
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** A JS property key. */
function key(k) {
    return IDENT.test(k) ? k : JSON.stringify(k);
}
/** The import specifier of a plan module, as seen from the view's folder. */
export function specifierFor(module, viewFile) {
    if (!module.startsWith('/'))
        return module;
    const from = posix.dirname(viewFile);
    let rel = posix.relative(from, module.slice(1));
    if (!rel.startsWith('.'))
        rel = './' + rel;
    return rel;
}
/** Emits the module of a compiled view. */
export function emitViewModule(plan, options) {
    const runtime = options.runtime ?? '@kubuno/views';
    const named = new Map(); // module → export → local
    const defaults = new Map(); // module → local
    const assets = new Map(); // url specifier → local
    let counter = 0;
    const component = (module, exp) => {
        const spec = specifierFor(module, options.file);
        if (exp === 'default') {
            let local = defaults.get(spec);
            if (!local)
                defaults.set(spec, (local = `__c${counter++}`));
            return local;
        }
        let m = named.get(spec);
        if (!m)
            named.set(spec, (m = new Map()));
        let local = m.get(exp);
        if (!local)
            m.set(exp, (local = `__c${counter++}`));
        return local;
    };
    const icon = (name) => component('lucide-react', ICON_ALIASES[name] ?? name);
    const asset = (path) => {
        const spec = (path.startsWith('.') || path.startsWith('/') ? path : './' + path) + '?url';
        let local = assets.get(spec);
        if (!local)
            assets.set(spec, (local = `__a${counter++}`));
        return local;
    };
    const body = new Writer();
    const json = (v) => JSON.stringify(v);
    const accessor = (b) => {
        const segs = b.path.split('.');
        const get = 'o' + segs.map((s, i) => (i === 0 ? `.${s}` : `?.${s}`)).join('');
        const set = 'o.' + segs.join('.');
        body.write(', g: ');
        body.write(`(o) => ${get}`, b.at);
        body.write(', s: ');
        body.write(`(o, v) => { ${set} = v }`, b.at);
    };
    /** `, b: { …the binding's fields, g, s }`. */
    const binding = (b) => {
        body.write(`, b: { ${Object.entries(b).map(([k, v]) => `${key(k)}: ${json(v)}`).join(', ')}`);
        accessor(b);
        body.write(' }');
    };
    const iconValue = (p) => {
        const conv = p.to.convert;
        if ((conv !== 'icon-node' && conv !== 'icon-component') || typeof p.v !== 'string' || p.v === '')
            return false;
        const v = p.v;
        if (/^[A-Za-z][A-Za-z0-9]*$/.test(v)) {
            body.write(`, v: { $icon: ${json(v)}, get c() { return ${icon(v)} } }`);
            return true;
        }
        if (/[./]/.test(v) && !v.startsWith('{')) {
            body.write(`, v: { $img: ${asset(v)} }`);
            return true;
        }
        return false;
    };
    const prop = (p) => {
        body.write('{ ', p.at);
        body.write(`n: ${json(p.n)}, to: ${json(p.to)}, kind: ${json(p.kind)}, at: ${json(p.at)}`);
        if (p.v !== undefined && !iconValue(p))
            body.write(`, v: ${json(p.v)}`);
        if (p.res) {
            const { args, ...res } = p.res;
            if (!args?.length)
                body.write(`, res: ${json(p.res)}`);
            else {
                // `{Res key, Count={Binding n}}`: each bound argument gets its accessor, like a property's binding.
                body.write(`, res: { ${Object.entries(res).map(([k, v]) => `${key(k)}: ${json(v)}`).join(', ')}, args: [`);
                args.forEach((a, i) => {
                    if (i)
                        body.write(', ');
                    body.write(`{ n: ${json(a.n)}`);
                    if (a.v !== undefined)
                        body.write(`, v: ${json(a.v)}`);
                    if (a.b)
                        binding(a.b);
                    body.write(' }');
                });
                body.write('] }');
            }
        }
        if (p.b)
            binding(p.b);
        body.write(' }');
    };
    const event = (e) => {
        body.write('{ ', e.at);
        body.write(`n: ${json(e.n)}, h: ${json(e.h)}, from: ${json(e.from)}, args_type: ${json(e.args_type)}, at: ${json(e.at)}, f: `);
        body.write(`(vm, s, e) => vm.${e.h}(s, e)`, e.at);
        body.write(' }');
    };
    const list = (items, each, indent) => {
        body.write('[');
        items.forEach((item, i) => {
            body.newline();
            body.write(indent + '  ');
            each(item);
            if (i < items.length - 1)
                body.write(',');
        });
        if (items.length) {
            body.newline();
            body.write(indent);
        }
        body.write(']');
    };
    const node = (n, indent) => {
        body.write('{ ', n.at);
        const fields = [];
        for (const [k, v] of Object.entries(n)) {
            if (['props', 'events', 'children', 'slots', 'items', 'sc', 'design'].includes(k))
                continue;
            fields.push(`${key(k)}: ${json(v)}`);
        }
        body.write(fields.join(', '));
        // A getter, read when the element renders: a view inside an import cycle (the core's own views: `@ui` →
        // the core's stores → the shell → the view) is evaluated before the components it imports are.
        if (n.m && n.x)
            body.write(`, get c() { return ${component(n.m, n.x)} }`);
        const inner = indent + '  ';
        if (n.props?.length) {
            body.write(', props: ');
            list(n.props, prop, inner);
        }
        if (n.design?.length) {
            body.write(', design: ');
            list(n.design, prop, inner);
        }
        if (n.sc && Object.keys(n.sc).length) {
            body.write(', sc: {');
            for (const [cls, props] of Object.entries(n.sc)) {
                body.write(` ${key(cls)}: `);
                list(props, prop, inner);
                body.write(',');
            }
            body.write(' }');
        }
        if (n.events?.length) {
            body.write(', events: ');
            list(n.events, event, inner);
        }
        if (n.children?.length) {
            body.write(', children: ');
            list(n.children, (c) => node(c, inner + '  '), inner);
        }
        if (n.slots && Object.keys(n.slots).length) {
            body.write(', slots: {');
            for (const [slot, nodes] of Object.entries(n.slots)) {
                body.write(` ${key(slot)}: `);
                list(nodes, (c) => node(c, inner + '  '), inner);
                body.write(',');
            }
            body.write(' }');
        }
        if (n.items) {
            const { list: items, ...rest } = n.items;
            body.write(`, items: { ${Object.entries(rest).map(([k, v]) => `${key(k)}: ${json(v)}`).join(', ')}, list: `);
            list(items, (c) => node(c, inner + '  '), inner);
            body.write(' }');
        }
        body.write(' }');
    };
    body.write('export const plan = { ');
    const top = [];
    for (const [k, v] of Object.entries(plan)) {
        if (k === 'root' || k === 'tray')
            continue;
        top.push(`${key(k)}: ${json(v)}`);
    }
    body.write(top.join(', '));
    body.write(', root: ');
    node(plan.root, '');
    if (plan.tray?.length) {
        body.write(', tray: ');
        list(plan.tray, (c) => node(c, '  '), '');
    }
    body.write(' }');
    body.newline();
    // In dev, the module URL keys the live views of this file: a re-evaluated module swaps its plan into them.
    body.write(options.hmr ? 'export const ViewBase = __kb_view(plan, import.meta.hot && import.meta.url)' : 'export const ViewBase = __kb_view(plan)');
    body.newline();
    if (options.defaultExport) {
        body.write('export default ViewBase.component()');
        body.newline();
    }
    if (options.hmr) {
        // A `.kbview` edit re-evaluates only this module; the runtime swaps the plan into the live views
        // (state and handles kept), so the update never propagates to the importers.
        body.write('if (import.meta.hot) import.meta.hot.accept()');
        body.newline();
    }
    // Header: imports (one line each, mapped to the view's first line).
    const header = new Writer();
    const imports = [runtime];
    header.write(`import { createViewBase as __kb_view } from ${json(runtime)}`);
    for (const [spec, map] of named) {
        header.newline();
        header.write(`import { ${[...map].map(([exp, local]) => `${exp} as ${local}`).join(', ')} } from ${json(spec)}`);
        imports.push(spec);
    }
    for (const [spec, local] of defaults) {
        header.newline();
        header.write(`import ${local} from ${json(spec)}`);
        imports.push(spec);
    }
    for (const [spec, local] of assets) {
        header.newline();
        header.write(`import ${local} from ${json(spec)}`);
        imports.push(spec);
    }
    header.newline();
    const lines = [...header.lines.slice(0, -1), ...body.lines];
    const segments = [...header.segments.slice(0, -1), ...body.segments];
    // Every line without its own segment maps to the root element, so a stack frame anywhere in the
    // module still lands in the view.
    for (const segs of segments) {
        if (segs.length === 0 || segs[0].col > 0)
            segs.unshift({ col: 0, srcLine: plan.root.at[0] - 1, srcCol: Math.max(0, plan.root.at[1] - 1) });
    }
    const file = options.file.split('/').pop() ?? options.file;
    const map = {
        version: 3,
        file: file + '.js',
        sources: [file],
        sourcesContent: [options.source],
        names: [],
        mappings: encodeMappings(segments),
    };
    return { code: lines.join('\n'), map, imports };
}
/** Whether a specifier respects the module isolation rule (host singleton, Lucide, or project-local). */
export function isAllowedImport(spec) {
    return HOST.has(spec) || spec === 'lucide-react' || spec.startsWith('./') || spec.startsWith('../');
}
