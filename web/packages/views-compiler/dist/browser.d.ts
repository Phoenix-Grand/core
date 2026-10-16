/**
 * `@kubuno/views-compiler/browser` - the compiler in a browser page (the Visual Studio design surface
 * parses the unsaved `.kbview` buffer with the same grammar as the build, WEB-VIEWS §2.1).
 *
 * The `.wasm` is fetched from `wasmUrl` (default: next to this file in the package,
 * `../wasm/kubuno-views-web.wasm`, which a bundler rewrites to an asset URL).
 */
import { ViewCompiler } from './compiler.js';
export { CompilerWasm, ViewCompiler } from './compiler.js';
export type * from './types.js';
/** Loads (once) and instantiates the compiler, then opens a session. */
export declare function loadBrowserCompiler(wasmUrl?: string | URL): Promise<ViewCompiler>;
