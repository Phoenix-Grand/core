<!--
  SPDX-FileCopyrightText: 2026 Kubuno contributors
  SPDX-License-Identifier: AGPL-3.0-or-later
-->

# @kubuno/sdk

[![npm](https://img.shields.io/npm/v/@kubuno/sdk.svg)](https://www.npmjs.com/package/@kubuno/sdk)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://github.com/kubuno/core/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-kubuno%2Fcore-4D38DB.svg)](https://github.com/kubuno/core)

**The module SDK for [Kubuno](https://github.com/kubuno/core) — the stable surface that runtime-loaded modules build against.**

Kubuno modules are independent processes whose frontend is an ESM bundle loaded by the host **at runtime** via an import map. `@kubuno/sdk` is the contract between the host and those modules: registries, stores, hooks, i18n and widgets. The real implementation (the host's singletons) is provided at runtime — this package ships the **type surface** so a module can build and type-check on its own.

## Overview

The SDK re-exports the host's stable extension points, including:

- **Registries** — `RouteRegistry`, `SlotRegistry`, `WaffleAppRegistry`, `FaviconRegistry`, `FileTypeRegistry`, `WidgetRegistry`, `ExtensionRegistry`, `ModuleServiceRegistry`.
- **Stores (Zustand)** — `useAuthStore`, `useModulesStore`, `useSidebarStore`, `useToolbarStore`, `useSearchStore`, `useNotificationStore`, `useWsStore`, …
- **Hooks & helpers** — `useConfirm`, `usePrompt`, `useAutosave`, `useDraggable`, i18n (`t`, `getDateLocale`), the `api` client, `DashboardWidget`, `WorkspaceShell`.

## Compatibility

| `@kubuno/sdk` | Kubuno core | `SDK_VERSION` | React |
| --- | --- | --- | --- |
| `0.1.x` | `0.1.x` | `1` | `19` |

A module declares the `sdkVersion` it was built against; the host rejects an incompatible module at load time.

## Install

```bash
npm install @kubuno/sdk
```

Peer dependencies (`@kubuno/ui`, `react`, `react-dom`, `react-router-dom`, `@tanstack/react-query`, `zustand`, `i18next`, `react-i18next`, `date-fns`, `lucide-react`) are provided by the host at runtime.

## Usage

A module's entry point registers itself against the SDK registries:

```ts
import { lazy } from 'react'
import { RouteRegistry, WaffleAppRegistry } from '@kubuno/sdk'

export const sdkVersion = 1

export function register() {
  WaffleAppRegistry.add({ id: 'calendar', label: 'Calendar', path: '/calendar' })
  RouteRegistry.add({ path: '/calendar/*', element: lazy(() => import('./CalendarApp')) })
}
```

### Authenticated URLs the browser loads by itself

An `<img>`, a `<video>`, a download link, an `EventSource` or a `WebSocket` cannot send the
`Authorization` header, and the host no longer keeps the access token in a cookie. Such URLs
carry a short-lived **signed ticket** instead, minted by the core for one session, one app,
one exact path and one method (see the core's `AUTH.md`):

```ts
import { useSignedUrl, signedUrl, downloadSignedUrl, openSignedUrl, signedSocketUrl } from '@kubuno/sdk'

const src = useSignedUrl(`/api/v1/drive/${id}/thumbnail`)          // undefined while loading
<video src={useSignedUrl(url, { purpose: 'stream' })} />            // Range requests, hours
img.src = await signedUrl(storedUrl)                                // new Image(), canvas
await downloadSignedUrl(`/api/v1/drive/${id}/download`, name)       // one-time ticket
const es = new EventSource(await signedUrl(url, { purpose: 'stream' }))
const ws = new WebSocket(await signedSocketUrl('/api/v1/chat/ws'))  // fresh on each reconnect
```

Never store a signed URL (in a document, a setting…): store the bare URL and sign it when it
is loaded. Other origins, `blob:`/`data:` URLs and public core routes are returned unchanged.
These helpers need a core with `POST /api/v1/auth/tickets`.

> **Runtime note:** mark `@kubuno/sdk` as `external` in your module build. The host
> resolves it to its singleton instances through the import map; bundling a copy would
> break shared state (stores, registries). This package exists for build-time types only
> (its JS entry is a stub that throws if ever executed).

## License

[AGPL-3.0-or-later](https://github.com/kubuno/core/blob/main/LICENSE) © Kubuno contributors.
