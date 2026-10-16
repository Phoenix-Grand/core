/**
 * The design API of the runtime - used only by the design surface (`src/views/design/`, vskubuno
 * docs/WEB-VIEWS.md §4.3), never by an application; deliberately NOT exported from `@kubuno/views`'
 * `index.ts`, so production bundles do not carry it.
 *
 * The design surface renders the plan it compiled from the unsaved buffer (with `design: true`), not the plan the
 * Vite plugin compiled from the file on disk. A view with a code-behind still needs its class - its getters,
 * `use()` and `@bind` fields give the bindings their values (handlers never run in design mode). The live class's
 * cell is shared with HMR and with any real instance on the page, so the surface never touches it: it renders a
 * **design class**, a subclass of the code-behind with a cell of its own (`View`'s constructor reads the cell of
 * `new.target`, so the subclass's instances use the design plan while inheriting every member of the code-behind).
 *
 * - `designClass(plan, codeBehind?)`: the design class of a plan (over the code-behind class, or over the generated
 *   base alone when the view has none);
 * - `setDesignPlan(cls, plan)`: a new buffer compiled - the plan is swapped into the class's cell and its live
 *   instances (handles redefined, elements notified: their state, `@bind` values and handles are kept), like the
 *   HMR path of `createViewBase`;
 * - `setDesignDataContext(cls, value)`: the sample `dataContext` of the design data (`<view>.design.json`), given
 *   to the live instances and to the ones created later.
 */
import { VIEWS_ABI, type ViewPlan } from './plan'
import { CELL, KB, createViewBase, handleFor, notify, type Cell, type View, type ViewClass } from './view'

interface DesignState {
  hasDataContext: boolean
  dataContext: unknown
}

const DESIGN: unique symbol = Symbol.for('kubuno.views.design')

type DesignClass = ViewClass & { [DESIGN]?: DesignState }

function checkAbi(plan: ViewPlan): void {
  if (plan.abi !== VIEWS_ABI) {
    throw new Error(`[views] ${plan.file} was compiled for views ABI ${plan.abi}; this host runs ABI ${VIEWS_ABI}`)
  }
}

/** One getter per `x:Name` of the current plan on a view instance (as `view.ts` does). */
function defineHandles(vm: View<object>): void {
  const i = vm[KB]
  for (const [name, id] of Object.entries(i.cell.plan.names)) {
    Object.defineProperty(vm, name, { configurable: true, enumerable: false, get: () => handleFor(i, id) })
  }
}

/**
 * The design class of `plan`: a subclass of `codeBehind` (the class the code-behind module exports) with its own
 * cell, or - without a code-behind - a concrete class over the base generated for the plan. Render it with
 * `<KbView view={cls} design …props/>`.
 */
export function designClass(plan: ViewPlan, codeBehind?: ViewClass | null): ViewClass {
  checkAbi(plan)
  const base = (codeBehind ?? createViewBase(plan)) as unknown as new () => View<object>
  const cell: Cell = { plan, instances: new Set() }
  const state: DesignState = { hasDataContext: false, dataContext: undefined }
  class DesignView extends base {
    static readonly [CELL] = cell
    static readonly [DESIGN] = state
    constructor() {
      super()
      if (state.hasDataContext) this.dataContext = state.dataContext
    }
  }
  Object.defineProperty(DesignView, 'name', { value: (codeBehind?.name || 'View') + '$Design' })
  const cls = DesignView as unknown as ViewClass
  cell.base = cls
  return cls
}

/** Swaps a new plan into a design class (and its live instances). */
export function setDesignPlan(cls: ViewClass, plan: ViewPlan): void {
  checkAbi(plan)
  const cell = cls[CELL]
  if (!cell || !(cls as DesignClass)[DESIGN]) throw new Error('[views] setDesignPlan: not a design class')
  if (cell.plan === plan) return
  cell.plan = plan
  for (const i of cell.instances) {
    defineHandles(i.vm)
    notify(i)
  }
}

/** The design data's `dataContext` for the instances of a design class (`undefined` clears it). */
export function setDesignDataContext(cls: ViewClass, value: unknown): void {
  const state = (cls as DesignClass)[DESIGN]
  const cell = cls[CELL]
  if (!state || !cell) throw new Error('[views] setDesignDataContext: not a design class')
  state.hasDataContext = value !== undefined
  state.dataContext = value
  for (const i of cell.instances) {
    ;(i.vm as { dataContext: unknown }).dataContext = value
    notify(i)
  }
}

/** Whether `cls` is a design class (made by `designClass`). */
export function isDesignClass(cls: unknown): cls is ViewClass {
  return typeof cls === 'function' && !!(cls as DesignClass)[DESIGN]
}
