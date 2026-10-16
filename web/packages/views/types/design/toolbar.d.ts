/**
 * The viewport toolbar of the design page (WEB-VIEWS §4.3, web-specific): the view's width (its design width,
 * phone / tablet / desktop presets, or fitted to the pane), the Kubuno theme (light / dark), the design-time
 * language (fr / en / ar, right-to-left for ar), Design / Run, and indicators (sample data, zoom, the runtime in
 * use). Plain DOM in Visual Studio's colours (`--vs-*`), outside the view's React tree.
 */
import type { KubunoThemeMode } from './bootstrap';
export type WidthChoice = 'design' | 'fit' | number;
/** A device frame, or none (the responsive page). */
export type DeviceChoice = 'phone' | 'tablet' | null;
/**
 * Device frames in logical (CSS) pixels - the scale the shared controls are sized in (their typographic roles, paddings
 * and gaps are theme values at this scale, like the web). The view is shown at this fixed size - scaled to fit the pane -
 * with phone/tablet proportions and a bezel, rather than as a responsive web page. Rotating swaps width and height.
 */
export declare const DEVICE_FRAMES: Record<Exclude<DeviceChoice, null>, {
    w: number;
    h: number;
    label: string;
}>;
export interface ToolbarState {
    readonly width: WidthChoice;
    readonly designWidth: number;
    readonly theme: KubunoThemeMode;
    readonly lang: string;
    readonly design: boolean;
    readonly device: DeviceChoice;
    readonly landscape: boolean;
    readonly sample: boolean;
    readonly sampleTitle: string;
    readonly zoom: number;
    readonly note: string | null;
}
export interface ToolbarHandlers {
    width(w: WidthChoice): void;
    theme(t: KubunoThemeMode): void;
    lang(l: string): void;
    design(on: boolean): void;
    device(d: DeviceChoice): void;
    rotate(): void;
}
export declare const WIDTH_PRESETS: readonly [390, 768, 1280, 1440];
export declare function createToolbar(doc: Document, languages: readonly string[], handlers: ToolbarHandlers, options?: {
    mobile?: boolean;
}): {
    el: HTMLElement;
    update(s: ToolbarState): void;
};
