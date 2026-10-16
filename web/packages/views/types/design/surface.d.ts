import { type UserControlInfo } from './protocol';
import './surface.css';
/** `GET /__kubuno_design__/project.json` (dev-server mode). */
export interface ProjectInfo {
    root: string;
    hostRegistry: string;
    registries: {
        path: string;
        text: string;
    }[];
    userControls: UserControlInfo[];
    viewsAbi: number;
    compiler: string;
    themes?: string[];
    /** Project modules imported before the first render (`design.setup`: the project's stylesheet, translations). */
    setup?: string[];
}
export interface SurfaceConfig {
    readonly mode: 'project' | 'bundled';
    /** `@kubuno/ui`'s version (the host's elements). */
    readonly uiVersion: string;
    /** `@kubuno/host-runtime`'s version when the page is that package's build. */
    readonly hostRuntime: string | null;
    readonly wasmUrl: string;
    /** Where `<id>/theme.json` of the Kubuno themes are served. */
    readonly themesBase: string;
    /** The device form factor the host is editing for (`mobile`: the viewport shows a device frame, not a web page,
     *  and the responsive-width presets are hidden). Set from the `?ff=` query of the bundled host URL. */
    readonly formFactor?: 'mobile' | null;
    /** Dev-server mode: the project description. */
    readonly loadProject?: () => Promise<ProjectInfo>;
    /** Bundled mode: the host registry's text. */
    readonly hostRegistry?: string;
    /** Dev-server mode: imports a project module through the dev server. */
    readonly importModule?: (specifier: string) => Promise<Record<string, unknown>>;
}
export declare class DesignSurface {
    private readonly config;
    private readonly channel;
    private ready;
    private readonly queue;
    private readonly toolbar;
    private readonly canvas;
    private readonly stage;
    private readonly zoomBox;
    private readonly frame;
    private readonly overlay;
    private readonly root;
    private readonly queryClient;
    private compiler;
    private registryTexts;
    private projectComponents;
    private projectUserControls;
    private projectLoaded;
    private catalog;
    private readonly loadedModules;
    private doc;
    private text;
    private plan;
    private nodes;
    /** Element id → `x:Name`, from the plan (its `names` is the reverse map). */
    private names;
    private stale;
    private generation;
    private codeBehind;
    private designCls;
    private designBase;
    private viewKey;
    private designOn;
    private selection;
    private hover;
    private map;
    private containerOutlines;
    private zoomPref;
    private zoomExplicit;
    private prefs;
    private langChosen;
    private drag;
    private dropFeedback;
    private hostDrag;
    private dragDetected;
    private previews;
    private previewTimer;
    private mapScheduled;
    private editing;
    constructor(config: SurfaceConfig);
    start(): Promise<void>;
    /** Imports the project's setup modules in order; one that fails is logged and the others still load. */
    private importSetup;
    private userControls;
    /** (Re)opens a compiler session over the current registries and user controls. */
    private openCompiler;
    private handle;
    private post;
    private log;
    private update;
    /** Registers every project module the plan names (imported, or a placeholder). */
    private loadModules;
    private elementName;
    /** Dev-server mode: the code-behind class of the document (its latest version after an HMR update). */
    private loadCodeBehind;
    /** The modules of the document changed on disk (Vite HMR): pick up the latest code-behind / controls. */
    modulesUpdated(paths: readonly string[]): Promise<void>;
    private dataContextFor;
    private show;
    private renderView;
    private showMessage;
    private designSize;
    /** The device frame's size (oriented), or null when the view is shown as a responsive page. */
    private deviceSize;
    private frameWidth;
    private zoom;
    private applyFrameSize;
    private setWidth;
    private setDevice;
    private rotateDevice;
    private setTheme;
    private applyLanguage;
    private setLanguage;
    private setDesignMode;
    private currentLang;
    private viewportChanged;
    private refreshToolbar;
    private layoutOverlay;
    private scheduleMap;
    private rebuildMap;
    private placement;
    private isRtl;
    private absolute;
    /** The part of an element its clipping ancestors leave visible (adorners are drawn around it), `null` when none. */
    private shown;
    private resizable;
    /** The identity shown on a control's corner tag: its element type and `x:Name` (the root is named for its kind). */
    private labelFor;
    private redraw;
    private postSelection;
    /** The element under a page point: the deepest `[data-kb-id]`, the view itself (`""`) over the canvas. */
    private elementAt;
    private select;
    private dropContext;
    private dropTargetAt;
    private wireTarget;
    private showDrop;
    private dropNew;
    private endToolboxDrag;
    private wireDom;
    private onPointerDown;
    private onPointerMove;
    private onPointerUp;
    private cancelDrag;
    /** Live preview of a move: the elements themselves follow the pointer (a CSS `translate`, view px). */
    private previewMove;
    private redrawShifted;
    private holdPreviews;
    private clearPreviews;
    private onWheel;
    private onKeyDown;
    /** State for tests and diagnostics (`window.__kbDesignState()`). */
    debugState(): Record<string, unknown>;
}
/** Starts the surface (both entries). */
export declare function startSurface(config: SurfaceConfig): DesignSurface;
