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
import { type ViewPlan } from './plan';
import { type ViewClass } from './view';
/**
 * The design class of `plan`: a subclass of `codeBehind` (the class the code-behind module exports) with its own
 * cell, or - without a code-behind - a concrete class over the base generated for the plan. Render it with
 * `<KbView view={cls} design …props/>`.
 */
export declare function designClass(plan: ViewPlan, codeBehind?: ViewClass | null): ViewClass;
/** Swaps a new plan into a design class (and its live instances). */
export declare function setDesignPlan(cls: ViewClass, plan: ViewPlan): void;
/** The design data's `dataContext` for the instances of a design class (`undefined` clears it). */
export declare function setDesignDataContext(cls: ViewClass, value: unknown): void;
/** Whether `cls` is a design class (made by `designClass`). */
export declare function isDesignClass(cls: unknown): cls is ViewClass;
