/**
 * Entrée de build UNIQUEMENT (pas importée par le code applicatif).
 *
 * Sert à matérialiser un chunk ESM stable `shared/kubuno-shared.js` qui contient
 * à la fois la surface `@kubuno/sdk` et `@ui`. L'import map du host pointe
 * `@kubuno/sdk` ET `@ui` vers ce même fichier → host et modules partagent une
 * seule instance évaluée (un seul tableau de routes, un seul i18next, etc.).
 */
export * from './index'
export * from '../ui/index'
