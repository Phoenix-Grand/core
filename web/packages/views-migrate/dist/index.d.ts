/**
 * `@kubuno/views-migrate` - the codemod from React/TSX screens to `.kbview` views (vskubuno docs/WEB-VIEWS.md §6.2,
 * WV-11). A devDependency; `kbview-migrate` is its command line.
 */
export { migrateFile, componentsOf, type MigrateConfig, type MigrationResult, type MigrationStats, type Status } from './migrate.js';
export { openProject } from './project.js';
export { Registry, type ElementInfo } from './registry.js';
export { mapLabelClasses, mapStackClasses, mapContainerClasses, mapStaticStyle, splitClasses } from './classes.js';
export { cleanJsxText, decodeEntities } from './jsxtext.js';
export { writeXml, type XNode, type Attr } from './xml.js';
export { main, summary, storeDefaults } from './cli.js';
export { classify, planLayout, relocate, toControlText, toViewText, nameCollisions, unitsOf, ROLE_FOLDERS, type Role, type Kind, type Classified, type Unit, type Move, type LayoutOptions, } from './layout.js';
export { planRelayout, applyRelayout, relayoutReport, type RelayoutOptions, type RelayoutPlan } from './relayout.js';
