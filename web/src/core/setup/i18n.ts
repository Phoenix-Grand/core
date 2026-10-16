// Translations for the installation wizard, in their own `setup` namespace.
//
// They live here rather than in `core.json` because they are read exactly once
// in the life of an instance and by one person - the operator installing it -
// and there is no reason for every user's bundle to carry them afterwards.
//
// All thirteen languages the product ships are written out: an installer that
// offers a language and then answers in another one is worse than one that
// offers none.
import { registerModuleTranslations } from '../i18n'
import en from './locales/en'
import fr from './locales/fr'
import es from './locales/es'
import pt from './locales/pt'
import it from './locales/it'
import de from './locales/de'
import el from './locales/el'
import ru from './locales/ru'
import ar from './locales/ar'
import he from './locales/he'
import hi from './locales/hi'
import zh from './locales/zh'
import ja from './locales/ja'

export const SETUP_NS = 'setup'

/** Registers the namespace.
 *
 * Through `registerModuleTranslations`, never `addResourceBundle` directly:
 * `i18n.init()` is asynchronous and REBUILDS the resource store when it
 * completes, wiping every bundle added during boot. That is what once made the
 * language selector look inert - the translations were there, then silently
 * gone. The helper remembers the bundle and re-applies it after init. */
export function registerSetupI18n() {
  registerModuleTranslations(SETUP_NS, { en, fr, es, pt, it, de, el, ru, ar, he, hi, zh, ja })
}
