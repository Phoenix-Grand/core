// The labels of the navigation (sidebar entries, breadcrumbs), in the `nav` namespace.
//
// The strings are `.kbres` resource files - `nav.kbres` (English, the fallback) and one `nav.<lang>.kbres` per other
// language - compiled to i18next bundles by the views compiler's Vite plugin (vskubuno docs/WEB-VIEWS.md, WV-6). They
// were converted from this file's former inline dictionaries by `kbres-convert`, every key and value of the 13
// languages checked identical.
import { registerModuleTranslations } from './index'
import nav from './nav.kbres'

registerModuleTranslations('nav', nav)
