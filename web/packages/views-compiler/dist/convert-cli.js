/**
 * `kbres-convert` - i18next dictionaries → `.kbres` sets, verified by reading them back (see `i18n-convert.ts`).
 *
 *   kbres-convert --json <locales dir> --ns <namespace> --out <set.kbres> [--neutral en]
 *       <locales dir>/<lang>/<namespace>.json → set.kbres (the neutral language) + set.<lang>.kbres
 *   kbres-convert --module <i18n.ts> --out-dir <dir> [--neutral en]
 *       every registerModuleTranslations(ns, …) of the module → <dir>/<ns>.kbres + satellites
 *   --check: compare only (an existing set against the source), write nothing; exit 1 on a difference.
 *
 * Exit codes: 0 done, 1 a set does not round-trip (or differs, with --check), 2 usage or a source that cannot be
 * read statically.
 */
import { join, resolve } from 'node:path';
import { loadNodeKbres } from './project.js';
import { loadTypeScript, readI18nModule, readJsonLocales, verifyKbresSet, writeKbresSet } from './i18n-convert.js';
function usage(message) {
    if (message)
        console.error(`kbres-convert: ${message}`);
    console.error('usage: kbres-convert --json <locales dir> --ns <namespace> --out <set.kbres> [--neutral en] [--check]');
    console.error('       kbres-convert --module <i18n.ts> --out-dir <dir> [--neutral en] [--check]');
    process.exit(2);
}
export async function main(argv = process.argv.slice(2)) {
    const flag = (name) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const check = argv.includes('--check');
    const neutral = flag('--neutral') ?? 'en';
    const codec = await loadNodeKbres();
    const sets = [];
    try {
        const json = flag('--json');
        const module = flag('--module');
        if (json) {
            const ns = flag('--ns') ?? usage('--json needs --ns');
            const out = flag('--out') ?? usage('--json needs --out');
            sets.push({ out: resolve(out), bundles: readJsonLocales(resolve(json), ns), source: `${json}/<lang>/${ns}.json` });
        }
        else if (module) {
            const outDir = flag('--out-dir') ?? usage('--module needs --out-dir');
            const ts = loadTypeScript(process.cwd());
            for (const r of readI18nModule(ts, resolve(module)))
                sets.push({ out: resolve(join(outDir, `${r.ns}.kbres`)), bundles: r.bundles, source: `${module} (${r.ns})` });
            if (!sets.length)
                usage(`${module} registers no translations (no registerModuleTranslations call)`);
        }
        else
            usage();
    }
    catch (e) {
        console.error(`kbres-convert: ${e.message}`);
        return 2;
    }
    let failed = 0;
    for (const s of sets) {
        const langs = Object.keys(s.bundles);
        const keys = Object.values(s.bundles).reduce((n, b) => n + JSON.stringify(b).split('":').length - 1, 0);
        try {
            if (check)
                verifyKbresSet(codec, s.bundles, s.out);
            else
                writeKbresSet(codec, s.bundles, s.out, neutral);
            console.log(`${check ? 'identical' : 'converted'}: ${s.source} → ${s.out} (${langs.length} languages: ${langs.join(' ')}; ~${keys} entries)`);
        }
        catch (e) {
            failed++;
            console.error(`kbres-convert: ${e.message}`);
        }
    }
    return failed ? 1 : 0;
}
