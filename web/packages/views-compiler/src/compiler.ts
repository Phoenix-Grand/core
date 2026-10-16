/**
 * The compiler session over the WebAssembly build of `kubuno-views-web` - the same code in Node (Vite
 * plugin, `kbview-tsc`) and in the browser (the Visual Studio design surface parses unsaved buffers).
 *
 * The `.wasm` exposes a C ABI (no wasm-bindgen): `kb_alloc(len)`, `kb_call(ptr, len) -> (ptr << 32) | len`
 * and `kb_free(ptr, len)`, JSON in, JSON out (`wasm/src/lib.rs`).
 */
import type { CompileOptions, CompileOutput, UserControlRef } from './types.js'

interface Exports {
  memory: WebAssembly.Memory
  kb_alloc(len: number): number
  kb_free(ptr: number, len: number): void
  kb_call(ptr: number, len: number): bigint
}

interface Response {
  ok: boolean
  error?: string
  result?: unknown
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The raw request channel to one instance of the compiler. */
export class CompilerWasm {
  private constructor(private readonly ex: Exports) {}

  /** Instantiates the compiler from the `.wasm` bytes (or an already compiled module). */
  static async instantiate(source: BufferSource | WebAssembly.Module): Promise<CompilerWasm> {
    const instance =
      source instanceof WebAssembly.Module
        ? await WebAssembly.instantiate(source, {})
        : (await WebAssembly.instantiate(source, {})).instance
    return new CompilerWasm(instance.exports as unknown as Exports)
  }

  /** Sends one request; returns its `result` (throws on `{ok: false}`). */
  call<T = unknown>(request: Record<string, unknown>): T {
    const bytes = encoder.encode(JSON.stringify(request))
    const ptr = this.ex.kb_alloc(bytes.length)
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes)
    const packed = this.ex.kb_call(ptr, bytes.length)
    const outPtr = Number(packed >> 32n)
    const outLen = Number(packed & 0xffffffffn)
    // Copy before freeing: the memory may grow (and detach views) on the next call.
    const text = decoder.decode(new Uint8Array(this.ex.memory.buffer, outPtr, outLen).slice())
    this.ex.kb_free(outPtr, outLen)
    const response = JSON.parse(text) as Response
    if (!response.ok) throw new Error(`@kubuno/views-compiler: ${response.error ?? 'unknown error'}`)
    return response.result as T
  }
}

/** The compiler's version and the plan ABI it produces. */
export interface CompilerVersion {
  compiler: string
  abi: number
}

/**
 * A registry loaded once, then many compiles. Registries: the host's (`kbview-registry.web.json` of
 * `@kubuno/ui`, `host: true`) first, then the project's own control registries (`host: false`).
 */
export class ViewCompiler {
  private readonly session: number

  constructor(private readonly wasm: CompilerWasm) {
    this.session = wasm.call<{ session: number }>({ op: 'session_new' }).session
  }

  version(): CompilerVersion {
    const v = this.wasm.call<CompilerVersion>({ op: 'version' })
    return { compiler: v.compiler, abi: v.abi }
  }

  /** Adds a registry document; returns how many elements the registry has now. */
  addRegistry(json: string, label: string, host: boolean): number {
    return this.wasm.call<{ elements: number }>({ op: 'add_registry', session: this.session, json, label, host }).elements
  }

  /** Replaces the project's user controls (`.kbcontrol` files). */
  setUserControls(controls: readonly UserControlRef[]): void {
    this.wasm.call({ op: 'set_user_controls', session: this.session, controls })
  }

  compile(source: string, options: CompileOptions): CompileOutput {
    const out = this.wasm.call<CompileOutput>({ op: 'compile', session: this.session, source, options })
    return out as CompileOutput
  }

  /** The handle interfaces of every element of the registry (`@kubuno/views`' `handles.generated.ts`). */
  handleTypes(): string {
    return this.wasm.call<{ text: string }>({ op: 'handle_types', session: this.session }).text
  }

  dispose(): void {
    this.wasm.call({ op: 'session_free', session: this.session })
  }
}
