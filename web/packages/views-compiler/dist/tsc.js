/**
 * `kbview-tsc` - `tsc` for projects with `.kbview` views (WEB-VIEWS §2.1, Vue's `vue-tsc` approach).
 *
 *   kbview-tsc -b            # instead of `tsc -b`
 *   kbview-tsc --noEmit -p . # any tsc arguments are passed through
 *
 * 1. Compiles every view of the project (`src/**` by default, `kubuno.views.json` → `sources`) with the WASM
 *    compiler, prints the view diagnostics, and writes `.kubuno/views/**` (declarations + check files).
 * 2. Runs the project's own TypeScript (`node_modules/typescript`) with the given arguments.
 * 3. Rewrites every error located in a generated check file to the `.kbview` line/column of the binding
 *    it checks, and every "class does not implement abstract member 'h'" error to the attributes naming
 *    handler `h`. Output lines keep tsc's `file(line,col): error TSxxxx: message` format (VS Error List).
 *
 * Exit code: tsc's, or 2 when a view has compile errors.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { GENERATED_DIR, ViewProject, generatedPaths, toPosix } from './project.js';
import { formatDiagnostic, hasGeneratedTypesSetup } from './vite.js';
const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;
/** Maps one generated check-file position back to the view. */
export function mapCheckPosition(spans, line, column) {
    const span = spans.find((s) => s.line === line && column >= s.start && column < s.end) ?? spans.find((s) => s.line === line);
    if (!span)
        return null;
    if (span.exact)
        return [span.src[0], span.src[1] + (column - span.start)];
    return [span.src[0], span.src[1]];
}
/** Rewrites tsc output lines (exported for tests). */
export function remapTscOutput(output, ctx) {
    const out = [];
    for (const line of output.split(/\r?\n/)) {
        const m = TSC_LINE.exec(line);
        if (!m) {
            out.push(line);
            continue;
        }
        const [, file, l, c, severity, code, message] = m;
        const abs = resolve(ctx.cwd, file);
        const check = ctx.checks.get(abs);
        if (check) {
            const pos = mapCheckPosition(check.spans, Number(l), Number(c));
            const viewFile = relative(ctx.cwd, join(ctx.root, check.view)) || check.view;
            if (pos) {
                out.push(`${toPosix(viewFile)}(${pos[0]},${pos[1]}): ${severity} ${code}: ${message}`);
                continue;
            }
        }
        const view = ctx.codeBehinds.get(abs);
        const missing = /does not implement inherited abstract member '?([A-Za-z_$][\w$]*)'?/.exec(message);
        if (view && missing && code === 'TS2515') {
            const uses = view.handlers.filter((h) => h.name === missing[1]);
            if (uses.length > 0) {
                const viewFile = toPosix(relative(ctx.cwd, join(ctx.root, view.view)) || view.view);
                for (const u of uses) {
                    out.push(`${viewFile}(${u.at[0]},${u.at[1]}): ${severity} ${code}: handler '${u.name}' of ${u.element}.${u.event} is missing from the code-behind: ${message}`);
                }
                continue;
            }
        }
        out.push(line);
    }
    return out.join('\n');
}
/** Loads the check maps written under `.kubuno/views` for the project's views. */
export function loadRemapContext(project, cwd) {
    const checks = new Map();
    const codeBehinds = new Map();
    for (const v of project.views) {
        const paths = generatedPaths(project.root, v);
        if (!existsSync(paths.map))
            continue;
        const map = JSON.parse(readFileSync(paths.map, 'utf8'));
        checks.set(resolve(paths.check), map);
        for (const ext of ['.ts', '.tsx']) {
            const cb = v.replace(/\.(kbview|kbcontrol)$/i, ext);
            if (existsSync(cb))
                codeBehinds.set(resolve(cb), map);
        }
    }
    return { root: project.root, cwd, checks, codeBehinds };
}
/** Runs kbview-tsc in `cwd` with tsc arguments `args`; returns the exit code and the remapped output. */
export async function runKbviewTsc(args, cwd = process.cwd()) {
    const pIndex = args.findIndex((a) => a === '-p' || a === '--project');
    const projectArg = pIndex >= 0 ? args[pIndex + 1] : undefined;
    let root = cwd;
    if (projectArg) {
        const target = isAbsolute(projectArg) ? projectArg : resolve(cwd, projectArg);
        root = target.endsWith('.json') ? resolve(target, '..') : target;
    }
    const lines = [];
    const project = await ViewProject.open(root);
    const outputs = project.generateAll();
    let viewErrors = 0;
    for (const [file, out] of outputs) {
        const rel = toPosix(relative(cwd, file));
        for (const d of out.diagnostics) {
            if (d.severity === 'error')
                viewErrors++;
            lines.push(formatDiagnostic(rel, d));
        }
    }
    if (outputs.size > 0 && !hasGeneratedTypesSetup(root)) {
        lines.push(`kbview-tsc: tsconfig.json does not include ${GENERATED_DIR}: add "rootDirs": [".", "${GENERATED_DIR}"] and "${GENERATED_DIR}" to "include" (see the @kubuno/views-compiler README)`);
    }
    const require = createRequire(join(root, 'package.json'));
    let tscBin;
    try {
        tscBin = require.resolve('typescript/bin/tsc');
    }
    catch {
        lines.push('kbview-tsc: TypeScript is not installed in this project (npm i -D typescript)');
        return { exitCode: 2, output: lines.join('\n') };
    }
    const tscArgs = [...args];
    if (!tscArgs.includes('--pretty'))
        tscArgs.push('--pretty', 'false');
    const result = spawnSync(process.execPath, [tscBin, ...tscArgs], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const ctx = loadRemapContext(project, cwd);
    const tscOut = remapTscOutput(`${result.stdout ?? ''}${result.stderr ?? ''}`, ctx).trimEnd();
    if (tscOut)
        lines.push(tscOut);
    project.compiler.dispose();
    const exitCode = viewErrors > 0 ? 2 : (result.status ?? 1);
    return { exitCode, output: lines.join('\n') };
}
/** CLI entry (`bin/kbview-tsc.js`). */
export async function main(argv = process.argv.slice(2)) {
    try {
        const { exitCode, output } = await runKbviewTsc(argv);
        if (output)
            process.stdout.write(output + '\n');
        process.exitCode = exitCode;
    }
    catch (e) {
        process.stderr.write(`kbview-tsc: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 2;
    }
}
