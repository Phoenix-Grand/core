/**
 * `@kubuno/views-compiler/browser` - the compiler in a browser page (the Visual Studio design surface
 * parses the unsaved `.kbview` buffer with the same grammar as the build, WEB-VIEWS §2.1).
 *
 * The `.wasm` is fetched from `wasmUrl` (default: next to this file in the package,
 * `../wasm/kubuno-views-web.wasm`, which a bundler rewrites to an asset URL).
 */
import { CompilerWasm, ViewCompiler } from './compiler.js';
export { CompilerWasm, ViewCompiler } from './compiler.js';
let module = null;
/** Loads (once) and instantiates the compiler, then opens a session. */
export async function loadBrowserCompiler(wasmUrl) {
    module ??= (async () => {
        const url = wasmUrl ?? new URL('../wasm/kubuno-views-web.wasm', import.meta.url);
        const response = await fetch(url);
        if (!response.ok)
            throw new Error(`@kubuno/views-compiler: cannot fetch ${String(url)} (${response.status})`);
        return WebAssembly.compile(await response.arrayBuffer());
    })();
    return new ViewCompiler(await CompilerWasm.instantiate(await module));
}
