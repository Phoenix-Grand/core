<!--
  SPDX-FileCopyrightText: 2026 Kubuno contributors
  SPDX-License-Identifier: AGPL-3.0-or-later
-->

# @kubuno/views

[![npm](https://img.shields.io/npm/v/@kubuno/views.svg)](https://www.npmjs.com/package/@kubuno/views)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://github.com/kubuno/core/blob/main/LICENSE)

**The runtime of `.kbview` views in the [Kubuno](https://github.com/kubuno/core) web UI.**

`.kbview` views are compiled by [`@kubuno/views-compiler`](../views-compiler) into a render plan; this
runtime renders that plan with React, binds it to the view's code-behind and raises its events. The real
implementation is provided by the Kubuno host **at runtime** through its import map (one instance for the
host and every module: one binding engine, one live-view registry). This package ships the **type
surface** so a module can build and type-check on its own; its JS entry is a stub that throws if it is
ever bundled.

## What it provides

- **The code-behind model** - `View` (base of every generated `ViewBase`), the `@bind` accessor decorator,
  `use()` for React hooks, `t()` for resources, `invalidate()`, `X.component()` to get a React component.
- **Element handles** - one typed handle per `x:Name` (`this.save.text = 'Saved'`, `this.save.enabled`,
  `focus()`, `element`), with an interface per element (`Button`, `TextField`, `CheckBox`…).
- **Event args** - `EventArgs`, `MouseEventArgs`, `KeyEventArgs`, `CancelEventArgs`,
  `ValueChangedEventArgs`, `ItemEventArgs`… (`e.handled` stops propagation, `e.cancel` prevents the default).
- **Bindings** - one-way, two-way, one-time and one-way-to-source; `UpdateSourceTrigger=LostFocus`;
  converters (`Not`, `IsEmpty`, `ToUpper`, `Equals`, `BoolToText`, `Count`… and `registerConverter`);
  .NET-style `StringFormat` (`N2`, `C`, `dd/MM/yyyy`, `'{0} items'`); `FallbackValue` and `TargetNullValue`.
- **Runtime elements** - `Repeater` (an item template per row), `Timer`, `Query` / `Mutation` (React Query,
  with `QueryHandle` / `MutationHandle`), `ReactHost`, `defineControl` for custom controls, `KbView`.
- **Dialogs** - `MessageBox.show(…)` and `Dialog.show(…)`, on the host's `ConfirmDialog` and
  `FloatingWindow` (never browser dialogs).
- **Compatibility** - `VIEWS_ABI`: a module exports `viewsAbi` next to `sdkVersion`; the host refuses a
  module whose views were compiled for another plan ABI.

## Install

```bash
npm install -D @kubuno/views @kubuno/views-compiler
```

Mark `@kubuno/views` as `external` in your module build, like `@ui` and `@kubuno/sdk`.

| `@kubuno/views` | Kubuno core | `VIEWS_ABI` | React |
| --- | --- | --- | --- |
| `0.1.x` | `0.1.x` | `1` | `19` |

## License

[AGPL-3.0-or-later](https://github.com/kubuno/core/blob/main/LICENSE) © Kubuno contributors.
