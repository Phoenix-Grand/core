/**
 * `@kubuno/views-compiler` — the build-time side of `.kbview` web views (vskubuno docs/WEB-VIEWS.md, WV-2):
 * the WebAssembly build of the shared `.kbview` grammar and web compiler, the Vite plugin, and `kbview-tsc`.
 * A devDependency: nothing here ships to the browser except through `./browser` (the design surface).
 */
export { kbview, formatDiagnostic, TSCONFIG_HINT, type KbviewPluginOptions } from './vite.js';
export { emitViewModule, specifierFor, isAllowedImport, ICON_ALIASES, type EmitOptions, type EmitResult } from './emit.js';
export { CompilerWasm, ViewCompiler, type CompilerVersion } from './compiler.js';
export { ViewProject, loadNodeCompiler, loadNodeKbres, scanViews, userControlsOf, codeBehindOf, viewOfCodeBehind, generatedPaths, generatedRelPath, writeGenerated, removeStaleGenerated, findHostRegistry, projectRegistryJson, GENERATED_DIR, EXTERNAL_DIR, VIEW_EXTENSIONS, type ProjectConfig, type ProjectOptions, } from './project.js';
export { DESIGN_PATH, DEFAULT_DESIGN_ENTRY, DESIGN_SERVER_FILE, designEntryUrl, designPageHtml, designProjectInfo, designPageEntryUrl, designSetupUrls, designThemesDir, themeFile, type DesignConfig, type DesignServerInfo, type DesignProjectInfo, } from './design-server.js';
export { HOST_RUNTIME_PACKAGE, HOST_RUNTIME_MANIFEST, findHostRuntime, parseHostRuntimeManifest, usesHostRuntime, prebundleExternals, CJS_FACADE_PREFIX, resolveShared, dropShared, devServerUrl, type HostRuntime, type HostRuntimeManifest, type PrebundlePlugin, } from './host-runtime.js';
export { runKbviewTsc, remapTscOutput, mapCheckPosition, loadRemapContext, type KbviewTscResult } from './tsc.js';
export { encodeMappings, decodeMappings, type SourceMapV3, type Segment } from './sourcemap.js';
export { extractUserControlProps, propsTypeOf } from './uc-props.js';
export type * from './types.js';
export { KbresCodec, kbresName, kbresSet, nestStrings, flattenBundle, compileKbresSet, bundlesToKbres, kbresModule, DEFAULT_NEUTRAL_CULTURE, type KbresString, type KbresDocument, type KbresDiagnostic, type I18nBundle, type CompiledKbresSet, } from './kbres.js';
export { readJsonLocales, readI18nModule, loadTypeScript, writeKbresSet, verifyKbresSet, sameBundles, type ConvertedSet } from './i18n-convert.js';
