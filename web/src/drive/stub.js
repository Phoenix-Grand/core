// @kubuno/drive is provided by the Kubuno host at RUNTIME via its ESM import map.
// Module bundles MUST mark "@kubuno/drive" as `external` (the host resolves it to
// its singleton instances). This stub exists only so the package is installable
// and so accidental bundling fails loudly instead of silently shipping a copy.
//
// NOT named index.js on purpose: the package is co-located with its real sources
// (index.ts) in web/src/drive. A sibling index.js would win directory-index
// resolution over index.ts and pull the host bundle through this stub, so the
// published entry is this `stub.js` (package.json `exports`) and the host build
// keeps resolving "@kubuno/drive" to index.ts through its Vite alias.
throw new Error(
  '@kubuno/drive must be provided by the Kubuno host at runtime; mark it as `external` in your module build.'
)
