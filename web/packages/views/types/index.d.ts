/**
 * `@kubuno/views` - the runtime of `.kbview` web views (vskubuno docs/WEB-VIEWS.md, lot WV-3).
 *
 * Provided by the host through its import map (one instance: one binding engine, one live-view registry);
 * modules keep `@kubuno/views` external. The npm package ships the types only.
 */
export { View, bind, createViewBase, invalidateViews, type ElementHandle, type ViewClass } from './view';
export { KbView, KbNode, ViewRoot, sizeClassOf, tokenColor } from './render';
export { Repeater, Timer, Query, Mutation, ReactHost, defineControl, registerControls, MessageBox, Dialog, type QueryHandle, type MutationHandle, type ControlMeta, type DefinedControl, type DialogResult, type MessageBoxButtons, type MessageBoxIcon, } from './controls';
export { Panel, UserControl, Stack, ScrollArea, TableLayoutPanel, dockGrid, parseAnchor, anchoredStyle, tableTracks, type DockGrid, type DockPlacement, type DockValue, type Surface, type AnchorEdges, } from './layout';
export { ensureViewStyles } from './style';
export { registerConverter, format, formatValue, type ValueConverter, type Scope } from './binding';
export { registerElements, resolveComponent, setIconResolver, setResourceResolver, setTranslator, interpolationOptions, type ResourceArgs, type Translator, invalidateResources, } from './resolve';
export type { EventArgs, MouseEventArgs, MouseButton, KeyEventArgs, KeyPressEventArgs, CancelEventArgs, DragEventArgs, ValueChangedEventArgs, ItemEventArgs, ItemActivateEventArgs, PaintEventArgs, ItemCheckEventArgs, } from './events';
export { VIEWS_ABI, type ViewPlan, type PlanNode, type PlanProp, type PlanEvent, type PlanBinding, type PlanRes, type PlanResArg } from './plan';
export type * from './handles.generated';
