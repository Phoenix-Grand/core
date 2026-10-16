/**
 * The design page in **bundled** mode: the static build published as `@kubuno/host-runtime` (`npm run
 * build:design-host`), served from any origin or folder (relative URLs) - Visual Studio maps it to
 * `https://kubuno-design.invalid/` when the project has no dev server. It carries the host runtime (React,
 * `@ui`, the sdk, `@kubuno/views`, the compiler's WebAssembly, the host registry, the host CSS with the
 * production fonts, the core's translations, the light and dark Kubuno themes); the project's own controls are
 * shown as placeholders, their registry entries arriving with `projectComponents`.
 */
import './bootstrap'
import uiPackage from '../../ui/package.json'
import hostRuntimePackage from '../../../packages/host-runtime/package.json'
import hostRegistry from '../../ui/kbview-registry.web.json?raw'
import wasmUrl from '../../../packages/views-compiler/wasm/kubuno-views-web.wasm?url'
import { startSurface } from './surface'

// The host (Visual Studio) states the device form factor through the page URL (`?ff=mobile` for a mobile view),
// since the bundled page is a static build with no other channel before it starts.
const formFactor = new URLSearchParams(location.search).get('ff') === 'mobile' ? 'mobile' : null

startSurface({
  mode: 'bundled',
  uiVersion: uiPackage.version,
  hostRuntime: hostRuntimePackage.version,
  wasmUrl,
  themesBase: './themes',
  hostRegistry,
  formFactor,
})
