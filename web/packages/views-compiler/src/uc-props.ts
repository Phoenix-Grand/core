/**
 * WV-7: the typed surface of a user control (`.kbcontrol`) — the members of the `x:Props` type named by its
 * root, read from the code-behind so another view can use the control as a native, typed element.
 *
 * Each non-function field becomes a bindable property (so an object binding type-checks), each function field
 * an event (so a handler can be wired). The field names and their broad categories are handed to the Rust
 * compiler (`UserControlRef.props`), which builds the element's `properties`/`events`/`prop_map`/`event_map`.
 *
 * This reads types with the TypeScript compiler API (`typescript`, already a peer dependency of the tooling);
 * it never needs the project's full type graph: unresolved imports fall back to `object` (an `__any` binding),
 * which is correct, just less precise. Any failure returns `undefined` — the control stays a pass-through, as
 * before WV-7, so a broken or unusual code-behind can never break a build.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'

import type { UserControlProp } from './types.js'

// `typescript` is CommonJS; required synchronously so {@link userControlsOf} stays synchronous. Loaded once,
// lazily, and never fatal: a missing or unexpected `typescript` just disables the typed surface.
type Ts = typeof import('typescript')
let tsModule: Ts | null | undefined
function loadTs(): Ts | null {
  if (tsModule !== undefined) return tsModule
  try {
    const require = createRequire(import.meta.url)
    tsModule = require('typescript') as Ts
  } catch {
    tsModule = null
  }
  return tsModule
}

/** The `x:Props` type named by a `.kbcontrol`'s root element, if any. */
export function propsTypeOf(kbcontrolFile: string): string | null {
  let text: string
  try {
    text = readFileSync(kbcontrolFile, 'utf8')
  } catch {
    return null
  }
  const m = /\bx:Props\s*=\s*"([A-Za-z_$][\w$]*)"/.exec(text)
  return m ? m[1] : null
}

/**
 * The members of a user control's `x:Props` type, or `undefined` when it has none (or cannot be read): the
 * control then keeps the earlier pass-through behaviour.
 */
export function extractUserControlProps(kbcontrolFile: string, codeBehindFile: string | null): UserControlProp[] | undefined {
  if (!codeBehindFile || !existsSync(codeBehindFile)) return undefined
  const typeName = propsTypeOf(kbcontrolFile)
  if (!typeName) return undefined
  const ts = loadTs()
  if (!ts) return undefined
  try {
    // One file, no lib, no module resolution: fast, and enough for the type's own shape. Unresolved imports
    // become `any`, which we treat as an object (an `__any` binding) — the safe default.
    const options: import('typescript').CompilerOptions = {
      noLib: true,
      noResolve: true,
      allowJs: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    }
    const program = ts.createProgram([codeBehindFile], options)
    const checker = program.getTypeChecker()
    const source = program.getSourceFile(codeBehindFile)
    if (!source) return undefined
    let decl: import('typescript').Declaration | undefined
    source.forEachChild((node) => {
      if (decl) return
      if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name.text === typeName) {
        decl = node
      }
    })
    if (!decl) return undefined
    const type = checker.getTypeAtLocation(decl)
    const out: UserControlProp[] = []
    for (const sym of checker.getPropertiesOfType(type)) {
      const name = sym.getName()
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue
      const propType = checker.getTypeOfSymbolAtLocation(sym, decl)
      out.push(classify(ts, checker, name, propType))
    }
    return out
  } catch {
    return undefined
  }
}

/** A property field → `{ event, kind }`; a function field → `{ event: true, args }`. */
function classify(
  ts: Ts,
  checker: import('typescript').TypeChecker,
  name: string,
  type: import('typescript').Type,
): UserControlProp {
  const nn = checker.getNonNullableType(type)
  const signatures = nn.getCallSignatures()
  if (signatures.length > 0) {
    // A function field is an event only when it is a callback — it returns nothing (`(v) => void`). A function
    // that returns a value (`format: (n) => string`, a comparator, a cell renderer) is a value transformer, not
    // an event: it becomes an ordinary bindable property, and the view binds a getter that returns the function,
    // which is passed straight through as the React prop. Unresolved / inferred return types default to event
    // (the common case), so an async `() => void` handler is unaffected.
    const ret = checker.getNonNullableType(signatures[0].getReturnType())
    const returnsValue = !(ret.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never))
      && !(ret.flags & ts.TypeFlags.Any)
      && ret.getCallSignatures().length === 0 // conservative: only clearly non-void, non-callback returns
      && (ret.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) !== 0
    if (!returnsValue) {
      const params = signatures[0].getParameters().length
      return { name, event: true, args: params >= 1 ? 'value' : 'none' }
    }
    return { name, event: false, kind: 'object' }
  }
  const f = nn.flags
  let kind: UserControlProp['kind'] = 'object'
  if (f & ts.TypeFlags.StringLike) kind = 'string'
  else if (f & ts.TypeFlags.NumberLike) kind = 'number'
  else if (f & ts.TypeFlags.BooleanLike) kind = 'boolean'
  else if (isArrayLike(checker, nn)) kind = 'array'
  return { name, event: false, kind }
}

/** Best-effort array / tuple detection (without the standard library loaded). */
function isArrayLike(checker: import('typescript').TypeChecker, type: import('typescript').Type): boolean {
  const withArray = checker as import('typescript').TypeChecker & { isArrayType?: (t: unknown) => boolean; isTupleType?: (t: unknown) => boolean }
  if (withArray.isArrayType?.(type) || withArray.isTupleType?.(type)) return true
  const symbolName = type.getSymbol()?.getName()
  if (symbolName === 'Array' || symbolName === 'ReadonlyArray') return true
  // A type reference to `T[]` keeps a numeric index and no string index even with no lib loaded.
  return !!type.getNumberIndexType() && !type.getStringIndexType()
}
