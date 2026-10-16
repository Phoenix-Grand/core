import { type MigrationResult } from './migrate.js';
export declare function main(argv?: readonly string[]): Promise<number>;
type Default = MigrationResult['defaults'][number];
/**
 * Writes the `defaultValue`s of `t('k', { defaultValue })` whose key no bundle has (the TSX showed the default in
 * every language) where the project's strings are loaded from, in the fallback language every language falls back to -
 * so the view shows the same text:
 *  1. `src/**\/locales/<lang>/<ns>.json` (the core's bundles);
 *  2. else a module's catalogue `src/i18n.data.json` (`{ <lang>: { … } }`) when its `src/i18n.ts` registers `ns`
 *     (`registerModuleTranslations('<ns>', …)`); `i18n.ts` is generated from it, so its generator
 *     (`src/gen_i18n.mjs`) runs again - without one, the log says to regenerate it;
 *  3. else `src/views-defaults.json`, which nothing loads: the log says so, to move by hand.
 */
export declare function storeDefaults(root: string, defaults: readonly Default[], lang?: string): {
    files: string[];
    left: Default[];
    log: string[];
};
export declare function summary(root: string, results: MigrationResult[]): {
    converted: number;
    partial: number;
    skipped: number;
    elements: number;
    elementsMapped: number;
    parts: number;
    classAttributes: number;
    files: {
        file: string;
        component: string | undefined;
        status: import("./migrate.js").Status;
        reasons: string[];
        stats: import("./migrate.js").MigrationStats;
        outputs: string[];
        defaults: number;
    }[];
};
export {};
