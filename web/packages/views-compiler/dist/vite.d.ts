import type { Plugin } from 'vite';
import { type ProjectOptions } from './project.js';
import type { Diagnostic } from './types.js';
export interface KbviewPluginOptions extends ProjectOptions {
    /** Write `.kubuno/views/**` (declarations, check files). Default `true`. */
    generateTypes?: boolean;
    /** Specifier of the views runtime (default `@kubuno/views`). */
    runtime?: string;
    /** Keep design-time values in the plans (the design surface's dev server). Default `false`. */
    design?: boolean;
    /**
     * Serve the Visual Studio design surface at `/__kubuno_design__/` in `vite serve` and announce it in
     * `.kubuno/design-server.json` (see `design-server.ts`). Default `true`.
     */
    designServer?: boolean;
    /** Language of a neutral `.kbres` file without a `Culture` attribute. Default `en`. */
    neutralCulture?: string;
}
/** `file(line,col): severity code: message` - the format tsc, MSBuild and VS use. */
export declare function formatDiagnostic(file: string, d: Diagnostic): string;
/** The plugin. Add it to `plugins` (before `@vitejs/plugin-react`). */
export declare function kbview(options?: KbviewPluginOptions): Plugin;
/** The `tsconfig.json` settings a project using views needs (documented in the package README). */
export declare const TSCONFIG_HINT: {
    readonly compilerOptions: {
        readonly rootDirs: readonly [".", ".kubuno/views"];
    };
    readonly include: readonly ["src", ".kubuno/views"];
};
/** Whether `root` looks set up for generated view types (used by `kbview-tsc` for a friendly hint). */
export declare function hasGeneratedTypesSetup(root: string): boolean;
