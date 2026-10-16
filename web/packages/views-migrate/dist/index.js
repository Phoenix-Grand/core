/**
 * `@kubuno/views-migrate` - the codemod from React/TSX screens to `.kbview` views (vskubuno docs/WEB-VIEWS.md §6.2,
 * WV-11). A devDependency; `kbview-migrate` is its command line.
 */
export { migrateFile, componentsOf } from './migrate.js';
export { openProject } from './project.js';
export { Registry } from './registry.js';
export { mapLabelClasses, mapStackClasses, mapContainerClasses, mapStaticStyle, splitClasses } from './classes.js';
export { cleanJsxText, decodeEntities } from './jsxtext.js';
export { writeXml } from './xml.js';
export { main, summary, storeDefaults } from './cli.js';
export { classify, planLayout, relocate, toControlText, toViewText, nameCollisions, unitsOf, ROLE_FOLDERS, } from './layout.js';
export { planRelayout, applyRelayout, relayoutReport } from './relayout.js';
