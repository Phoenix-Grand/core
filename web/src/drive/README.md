<!--
  SPDX-FileCopyrightText: 2026 Kubuno contributors
  SPDX-License-Identifier: AGPL-3.0-or-later
-->

# @kubuno/drive

[![npm](https://img.shields.io/npm/v/@kubuno/drive.svg)](https://www.npmjs.com/package/@kubuno/drive)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://github.com/kubuno/core/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-kubuno%2Fcore-4D38DB.svg)](https://github.com/kubuno/core)

**The drive client surface for [Kubuno](https://github.com/kubuno/core) — reuse the file browser and storage UI in any file-backed module.**

File-backed Kubuno modules (office, notes, flow, paintsharp…) don't reimplement a file picker: they reuse the drive module's client components — the generic file browser, storage explorer, and the standard file dialogs. `@kubuno/drive` exposes that surface. As with the rest of the SDK, the implementation is provided by the host at runtime; this package ships the **type surface**.

## Overview

- **Browsing** — `ModuleFileBrowser`, `ModuleStartPage`, `StorageExplorer`, `FolderGlyph`, `fileView`.
- **Dialogs** — `MoveModal`, `RenameModal`, `BatchRenameModal`, `NewFolderModal`, `ShareModal`, `FileInfoModal`, `VersionHistoryModal`.
- **Viewers, stores & helpers** — `FilesTextViewer`, `UploadPanel`, `useMarqueeSelection`, `storageSource`, the drive `api` and dialog/media stores.

## Compatibility

| `@kubuno/drive` | Kubuno core | `@kubuno/sdk` | React |
| --- | --- | --- | --- |
| `0.1.x` | `0.1.x` | `0.1.x` | `19` |

## Install

```bash
npm install @kubuno/drive
```

Peer dependencies: `@kubuno/sdk`, `@kubuno/ui`, `react`, `react-dom`, `zustand` (provided by the host at runtime).

## Usage

```tsx
import { ModuleFileBrowser } from '@kubuno/drive'

function PickFile() {
  return <ModuleFileBrowser moduleId="office" onOpen={(file) => console.log(file)} />
}
```

> **Runtime note:** mark `@kubuno/drive` as `external` in your module build — the host
> serves a single shared instance via its import map. This package is build-time types only
> (its JS entry is a stub that throws if ever executed).

## License

[AGPL-3.0-or-later](https://github.com/kubuno/core/blob/main/LICENSE) © Kubuno contributors.
