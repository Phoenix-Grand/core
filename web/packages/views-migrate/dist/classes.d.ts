/**
 * Tailwind classes → `.kbview` properties, **only where the result renders the same pixels** (WEB-VIEWS.md §6.2
 * "Tailwind classes → properties/roles where mapped"); every other class stays in the web-only `Class` attribute and
 * is counted. The host's scales are the core's (`theme.css` / `index.css`): spacing steps of 4 px, `text-xs` /
 * `text-sm` re-pointed at 11.5 / 13.5 px - the `Label` roles `Meta` / `Body` render exactly those classes.
 */
export declare function splitClasses(className: string): string[];
export interface ClassMapping {
    /** `.kbview` properties replacing some classes (property → value). */
    props: Record<string, string>;
    /** The classes kept in `Class`. */
    rest: string[];
}
/** Classes of a text element (`Label`): role, weight, style, alignment, overflow, colours. */
export declare function mapLabelClasses(className: string): ClassMapping & {
    hasSize: boolean;
};
/**
 * Classes of a `div` that is a plain flex box: `Stack` (`Direction`, `Gap`, `CrossAlign`, `Justify`, `WrapContents`)
 * when nothing else redefines the flex layout (a responsive or state variant of it). `undefined` when not a Stack.
 */
export declare function mapStackClasses(className: string): ClassMapping | undefined;
/** Classes of any other container: only the colours. */
export declare function mapContainerClasses(className: string): ClassMapping;
/** Static `style={{…}}` entries → properties or Tailwind arbitrary properties (`[background:#202124]`). */
export declare function mapStaticStyle(style: Record<string, string | number>): {
    props: Record<string, string>;
    classes: string[];
} | undefined;
