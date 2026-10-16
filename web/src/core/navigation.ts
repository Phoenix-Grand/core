/**
 * SPA navigation for code that runs OUTSIDE React.
 *
 * Menus are data now (`MenuItem[]` built by a plain function), background workers
 * and registries likewise - none of them can call React Router's `useNavigate`.
 * Every module had therefore copy-pasted the same `pushState` + synthetic
 * `popstate` helper; this is that helper, once, in the core.
 *
 * The shell hands it the router's real `navigate` (see `Shell.tsx`), so links go
 * through React Router proper. Before that (or outside the router - a module
 * bundle registering at boot), it falls back to History API + a synthetic
 * `popstate`, which the router listens to.
 */

type RouterNavigate = (to: string, opts?: { replace?: boolean }) => void

let routerNavigate: RouterNavigate | null = null

/** Called by the shell once the router is mounted. Not part of the module API. */
export function setRouterNavigate(fn: RouterNavigate | null): void {
  routerNavigate = fn
}

/**
 * Navigates to an in-app path (e.g. `/drive/folders/42`), like a link click.
 * Safe to call from anywhere: menu item handlers, stores, registries, timers.
 */
export function navigate(to: string, opts?: { replace?: boolean }): void {
  if (routerNavigate) { routerNavigate(to, opts); return }
  // No router yet: drive the History API and tell the router to re-read the URL.
  window.history[opts?.replace ? 'replaceState' : 'pushState']({}, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
