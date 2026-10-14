<!--
  SPDX-FileCopyrightText: 2026 Kubuno contributors
  SPDX-License-Identifier: AGPL-3.0-or-later
-->

# @kubuno/ui

[![npm](https://img.shields.io/npm/v/@kubuno/ui.svg)](https://www.npmjs.com/package/@kubuno/ui)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://github.com/kubuno/core/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-kubuno%2Fcore-4D38DB.svg)](https://github.com/kubuno/core)

**Shared UI primitives for [Kubuno](https://github.com/kubuno/core) apps and modules — the `@ui` design layer.**

A set of pure, framework-level React components (no Kubuno business logic) used by the host shell and by every module: buttons, inputs, dialogs, pickers, popovers, menus, date pickers and more. Styling is utility-class based (Tailwind CSS v4), so components inherit the consuming app's theme.

## Overview

This package provides three kinds of building blocks:

- **Form & input controls** — `Button`, `Input`, `NumberInput`, `Textarea`, `Checkbox`, `Radio`, `Toggle`, `FloatCheckbox`.
- **Overlays & navigation** — `MenuDropdown`, `Dropdown`, `AnchoredPopover`, `FloatingWindow`, `ConfirmDialog`, `PromptDialog`, `Tabs`, `Separator`, `ResizeHandle`.
- **Pickers & misc** — `ColorPicker`, `ColorField`, `GradientPicker`, `DatePicker`, `Spinner`, `Badge`, `RichText`, `StartPage`, `KubunoLogo`.

## Compatibility

| `@kubuno/ui` | Kubuno core | React |
| --- | --- | --- |
| `0.1.x` | `0.1.x` | `19` |

## Install

```bash
npm install @kubuno/ui
```

`react`, `react-dom`, `lucide-react`, `clsx`, `tailwind-merge`, `date-fns`, `i18next`, `react-i18next` and `zustand` are peer dependencies — provide them in your app (Kubuno modules get them from the host at runtime).

## Usage

```tsx
import { Button, ConfirmDialog } from '@kubuno/ui'

function Toolbar() {
  return (
    <Button variant="primary" size="sm" onClick={() => console.log('clicked')}>
      New event
    </Button>
  )
}
```

> **Runtime note (Kubuno modules):** inside a module bundle, mark `@ui` as `external`.
> The Kubuno host serves a single shared instance of these components through its
> ESM import map, so modules never bundle their own copy. This package supplies the
> build-time types and a standalone ESM build for non-host consumers.

## License

[AGPL-3.0-or-later](https://github.com/kubuno/core/blob/main/LICENSE) © Kubuno contributors.
