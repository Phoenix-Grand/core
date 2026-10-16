/**
 * The compiler session over the WebAssembly build of `kubuno-views-web` - the same code in Node (Vite
 * plugin, `kbview-tsc`) and in the browser (the Visual Studio design surface parses unsaved buffers).
 *
 * The `.wasm` exposes a C ABI (no wasm-bindgen): `kb_alloc(len)`, `kb_call(ptr, len) -> (ptr << 32) | len`
 * and `kb_free(ptr, len)`, JSON in, JSON out (`wasm/src/lib.rs`).
 */
import type { CompileOptions, CompileOutput, UserControlRef } from './types.js';
/** The raw request channel to one instance of the compiler. */
export declare class CompilerWasm {
    private readonly ex;
    private constructor();
    /** Instantiates the compiler from the `.wasm` bytes (or an already compiled module). */
    static instantiate(source: BufferSource | WebAssembly.Module): Promise<CompilerWasm>;
    /** Sends one request; returns its `result` (throws on `{ok: false}`). */
    call<T = unknown>(request: Record<string, unknown>): T;
}
/** The compiler's version and the plan ABI it produces. */
export interface CompilerVersion {
    compiler: string;
    abi: number;
}
/**
 * A registry loaded once, then many compiles. Registries: the host's (`kbview-registry.web.json` of
 * `@kubuno/ui`, `host: true`) first, then the project's own control registries (`host: false`).
 */
export declare class ViewCompiler {
    private readonly wasm;
    private readonly session;
    constructor(wasm: CompilerWasm);
    version(): CompilerVersion;
    /** Adds a registry document; returns how many elements the registry has now. */
    addRegistry(json: string, label: string, host: boolean): number;
    /** Replaces the project's user controls (`.kbcontrol` files). */
    setUserControls(controls: readonly UserControlRef[]): void;
    compile(source: string, options: CompileOptions): CompileOutput;
    /** The handle interfaces of every element of the registry (`@kubuno/views`' `handles.generated.ts`). */
    handleTypes(): string;
    dispose(): void;
}
