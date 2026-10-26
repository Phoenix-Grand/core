# Marketplace display localization

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

The catalog owns the translations. Core does not machine-translate publisher
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
