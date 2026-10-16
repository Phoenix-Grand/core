// Modules register the route prefixes whose apps should auto-collapse the left
// sidebar on open (to maximise horizontal workspace). The Shell reads this - core
// never hardcodes module paths, so module independence is preserved.
const _prefixes: string[] = []

export const CollapseSidebarRegistry = {
  /** Declare a route prefix (e.g. '/paintsharp') whose pages collapse the sidebar. */
  add(prefix: string): void {
    if (!_prefixes.includes(prefix)) _prefixes.push(prefix)
  },
  /** True if the given pathname falls under any registered prefix. */
  matches(pathname: string): boolean {
    return _prefixes.some(p => pathname === p || pathname.startsWith(p + '/'))
  },
}
