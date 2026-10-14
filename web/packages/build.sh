#!/usr/bin/env bash
# Regenerate the publishable @kubuno/* npm packages from the host frontend source.
#
#   @kubuno/ui    — real ESM library (dist/index.js) + types
#   @kubuno/sdk   — type surface (sdk/ + core/ .d.ts) + runtime stub
#   @kubuno/drive — type surface (drive/ .d.ts) + runtime stub
#   @kubuno/views — type surface (views/ .d.ts) + runtime stub (the .kbview runtime)
#   @kubuno/views-compiler — real Node library (Vite plugin, kbview-tsc) + the committed .wasm
#   @kubuno/views-migrate  — real Node library (the kbview-migrate codemod)
#   @kubuno/host-runtime   — the Visual Studio design page: static site (bundled mode) + the project-mode
#                            entry of module projects and the host shared modules (dist/project/)
#
# At runtime these specifiers are provided by the host via its import map; module
# bundles mark them `external`. The packages exist so modules can build & typecheck
# standalone (npm), without a kubuno/core checkout next to them.
set -euo pipefail
cd "$(dirname "$0")/.."                     # → web/ (the host app)
FE="$(pwd)"
PKG="$FE/packages"

echo "==> 1/4  Building @kubuno/views-compiler (TypeScript; the committed .wasm is rebuilt by npm run build:wasm)"
# First: kbview-tsc (below) runs from this package's dist/.
# `--force`: an incremental build rewrites only the outputs whose sources changed, and publish_all.sh refuses a
# dist/ holding any file older than the newest source.
node_modules/.bin/tsc -b --force packages/views-compiler
# The codemod (kbview-migrate), a Node library of its own.
node_modules/.bin/tsc -b --force packages/views-migrate

echo "==> 2/4  Emitting declarations (kbview-tsc -p tsconfig.emit.json)"
# kbview-tsc, not plain tsc: it first generates the types of the .kbview / .kbcontrol views
# (.kubuno/views, gitignored) that the code-behinds import, then runs tsc with the same arguments.
rm -rf "$FE/dist-types"
node packages/views-compiler/bin/kbview-tsc.js -p tsconfig.emit.json

echo "==> 2b   Assembling type trees"
# @ui : autonomous, ships ui/ only
rm -rf "$PKG/ui/types";    mkdir -p "$PKG/ui/types";        cp -r "$FE"/dist-types/ui/*    "$PKG/ui/types/"
# @kubuno/sdk : sdk/ + core/ (sdk imports ../core). The package is CO-LOCATED with its sources (web/src/sdk):
# package.json/index.js/README/CHANGELOG live there, and the type tree is regenerated here (gitignored, never
# committed — see .gitignore). The npm identity (@kubuno/sdk) and the published layout (types/, exports) are unchanged.
SDKPKG="$FE/src/sdk"
rm -rf "$SDKPKG/types";   mkdir -p "$SDKPKG/types/sdk" "$SDKPKG/types/core"
cp -r "$FE"/dist-types/sdk/*  "$SDKPKG/types/sdk/"
cp -r "$FE"/dist-types/core/* "$SDKPKG/types/core/"
# The core's user controls (X.kbcontrol + X.ts code-behind): the emitted code-behind declarations import
# './X.kbcontrol', whose declaration kbview-tsc generated under .kubuno/views — ship it next to them.
( cd "$FE/.kubuno/views/src" && find core -name '*.kbcontrol.d.ts' -o -name '*.kbview.d.ts' ) | while read -r f; do
  mkdir -p "$SDKPKG/types/$(dirname "$f")"; cp "$FE/.kubuno/views/src/$f" "$SDKPKG/types/$f"
done
# @kubuno/drive : drive/ only. CO-LOCATED with its sources (web/src/drive): type tree regenerated there,
# gitignored (never committed). npm identity (@kubuno/drive) and published layout unchanged.
rm -rf "$FE/src/drive/types"; mkdir -p "$FE/src/drive/types/drive"; cp -r "$FE"/dist-types/drive/* "$FE/src/drive/types/drive/"
# @kubuno/views : views/ only (the .kbview runtime; self-contained, imports react only)
rm -rf "$PKG/views/types"; mkdir -p "$PKG/views/types";     cp -r "$FE"/dist-types/views/* "$PKG/views/types/"

echo "==> 3/4  Building @kubuno/ui ESM bundle"
# ⚠️ The `cd` is load-bearing, not stylistic. Vite resolves `outDir` against the
# CURRENT WORKING DIRECTORY, not against the config file. Run from web/ as
#     npx vite build --config packages/ui/vite.config.ts
# and the library lands in `web/dist/` — where `emptyOutDir` first WIPES the
# host application build. Always build a package from inside the package.
( cd "$PKG/ui" && "$FE/node_modules/.bin/vite" build )

echo "==> 4/4  Building @kubuno/host-runtime (bundled page, then the project-mode page + shared modules)"
# vite.design-host.config.ts writes to an absolute outDir (packages/host-runtime/dist): safe from web/.
node_modules/.bin/vite build --config vite.design-host.config.ts
node_modules/.bin/vite build --config vite.design-host.config.ts --mode project

rm -rf "$FE/dist-types"
echo "==> done. Never publish by hand: use  bash _tools/publish_all.sh  (regenerates,"
echo "    runs the blocking consistency check, then publishes)."
