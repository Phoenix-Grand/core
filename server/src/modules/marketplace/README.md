# Marketplace display localization

## Module-owned descriptions (optional)

Existing modules and `.kbpkg` files require no changes. To take ownership of a
listing's text, append this optional section to the existing `module.toml`:

```toml
[marketplace]
summary = "Email with support for multiple IMAP and SMTP accounts."

[marketplace.localizations.fr]
summary = "Messagerie prenant en charge plusieurs comptes IMAP et SMTP."
```

The baseline text is English. `description` is optional and falls back to
`[module].description`; `summary` falls back to that description when omitted.
Per-locale `description` is optional too: existing
`[module.translations.<locale>].description` values are reused, with explicit
Marketplace translations taking precedence. No names, categories, badges,
versions, download URLs, checksums or signatures are imported from this section.
The existing packager already includes `module.toml`, so neither a build-script
change nor a new archive format is needed. Do not modify already-published
packages in place: their recorded hashes must continue to identify their bytes.

Absence of `[marketplace]` means **no opt-in**: retain the catalog listing exactly
as it is. Metadata is parsed separately from the runtime module manifest.
Malformed optional metadata is a publication error, not a reason to stop an
installed module. Older Core manifest readers ignore the new section.

### Reusable publisher importer

The Core CLI can export the text or merge it into an existing catalog document:

```sh
kubuno marketplace:metadata /checkout/mail/module.toml
kubuno marketplace:metadata /checkout/mail/module.toml --catalog catalog.json > catalog.next.json
```

It needs no database, running Core instance, credentials or network access. Only
JSON goes to stdout; errors go to stderr with a nonzero exit code. The input can
be a catalog array, one module object, or either wrapped in `{"data": ...}`.
Other entries, unknown fields, pagination, categories, installation data and
editorial fields are preserved. The module ID and **exact released version** must
match before any text changes. A legacy manifest produces `null` when exported
alone, or leaves the supplied catalog unchanged. Publish the output atomically
only after a successful command; never redirect output onto the input file.

Opted-in summaries/descriptions replace old translations of those same fields,
preventing stale catalog translations from masking updated publisher wording.
Name/category translations remain catalog-owned. Missing languages use Core's
locale/parent/English/original fallback; no machine translation is performed.
An explicitly empty translated string remains empty.

A catalog operator can run this after a reviewed metadata commit or release,
using a webhook or scheduled repository checkout. Metadata-only corrections for
the currently listed version need no binary rebuild or reinstall. A future
version cannot overwrite the current release's listing. This command provides
the importer, not repository credentials, a scheduler, or a catalog hosting
service. The operator controls which repository may publish each module ID.

### Self-hosted preview or local metadata mirror

For an administrator-maintained local source, set
`KUBUNO_MARKETPLACE_METADATA_DIR=/data/marketplace-metadata` and place manifests at
`<directory>/<module-id>/module.toml`. Core reads these bounded (256 KiB maximum)
files on catalog list/detail refresh. ID/version checks and the same importer
apply. Missing files and modules without opt-in retain their catalog text;
invalid files are logged and the remote catalog entry is returned unchanged.
Keep the directory read-only to the service. Updating a valid file then refreshing
Marketplace updates its text without reinstalling a module or restarting Core.

This option defaults to off. It applies only to the configured catalog and does
not add catalog entries, fetch Git repositories, change install decisions, or
read installed manifests automatically. It still needs that catalog to load.
For a fully independent deployment, point `KUBUNO_MARKETPLACE_URL` and
`KUBUNO_MARKETPLACE_KEY` at your own catalog and signing key, and host the package
downloads there as well. A disconnected full catalog cache is not implemented
by this text-metadata change. Installed modules continue to use their existing
runtime manifest and description independently of this option.

The public `api.kubuno.com` service must adopt this importer (or the same contract)
before module commits automatically update its listings. This Core change does
not publish to or modify that service.

## Catalog localization

Core accepts optional fields on each catalog module (both list and detail):

```json
{
  "id": "drive",
  "name": "Drive",
  "version": "1.0.0",
  "category_id": "office",
  "category": "Bureautique",
  "summary": "Stockage de fichiers",
  "localizations": {
    "en": { "summary": "File storage and sharing.", "category": "Office" },
    "fr": { "summary": "Stockage et partage de fichiers.", "category": "Bureautique" }
  }
}
```

Each locale can supply `name`, `summary`, `description`, and `category` (display
label). Locale tags are matched case-insensitively, accepting `_` or `-`.
Each field independently falls back from the selected locale through its parent
locales, then English, then the original field. Missing/null values fall through;
empty translated names/descriptions/summaries are preserved. Category headings
always retain a readable label when a translated label is empty.

Publishers may own description translations through the optional contract above;
the catalog distributes them. Core does not machine-translate publisher
content or replace custom module descriptions. A legacy catalog with only French
summaries will continue to show those summaries until translations are published.

Core preserves the complete localization map in `/api/v1/admin/marketplace`.
The browser caches raw metadata and resolves display fields on each language
change, so no language-dependent cache key or new request is necessary.

`category_id` is stable across languages. Core supplies English/French labels for
`office`, `communication`, `creation`, `development`, `productivity`, `storage`,
and `other`. Publishers may supply localized category labels as above. Unknown
IDs/labels remain readable. Legacy French/English labels for the built-in
categories map to those IDs for grouping and related-module matching. An absent
category displays “Other”, but does not make unrelated uncategorized modules
companions. Module IDs, versions, tags, links, and installation decisions are
never translated.

Installation status retains `phase`, `message`, `report`, and `error` for older
clients. Optional `params.dependency` names the dependency in a `dependencies`
phase. Failed statuses also include a stable `error_code`; raw diagnostic text
remains in `error`. Core renders translated phase/error labels and keeps raw
diagnostics in an expandable details section. Unknown phases use a translated
generic installing status. Status and notification state stores codes/data,
allowing language changes to update already-visible messages.

External follow-up: the service at `https://api.kubuno.com/v1/modules` and its
publishing/content pipeline must supply these fields and reviewed translations.
The Core change is backwards compatible with catalogs that do not yet do so.
