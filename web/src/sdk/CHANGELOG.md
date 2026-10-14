# Changelog — @kubuno/sdk

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are
added under `[Unreleased]` **as the change is made**; on npm publish, the section is stamped
under the published version number.

## [Unreleased]

## [0.1.13] - 2026-10-06

### Changed

- **Type surface of the migrated core.** The declarations follow the core screens now written as `.kbview` views
  (administration, settings, shell, sign-in): their code-behinds and generated view declarations replace the TSX
  components' types that 0.1.12 still described.

### Added

- `useSlotRegistryVersion()`: renders the calling component again whenever a slot, an override, a module admin
  section, a settings route or a notification group is registered or removed. `<Slot>`, `useHasSlot()` and
  `useModuleAdminSections()` use it.

### Fixed

- **`<Slot>` shows what a module contributes after the first render** (it read the registry without subscribing to
  it). It also keys each contribution by module and rank, so a module contributing several components to one slot
  (drive: six app dialogs) no longer gives React duplicate keys.

## [0.1.12] - 2026-10-05

### Changed

- Type surface updated: the declarations of the WaffleMenu and AccountMenu handles and of panelChrome changed since 0.1.11.

## [0.1.11] - 2026-10-05

### Fixed

- **The type surface is complete again.** The declarations of the shell's account panel and app launcher
  (now `.kbcontrol` user controls) imported a `./X.kbcontrol` module that was not shipped; its generated
  declaration is now included next to them.

### Added

- **Signed URLs for requests the browser makes by itself:** `useSignedUrl()`, `signedUrl()`,
  `signedUrls()`, `downloadSignedUrl()`, `openSignedUrl()` and `signedSocketUrl()`, with the
  `TicketPurpose` and `SignedUrlOptions` types. They turn an authenticated `/api/v1/...` URL
  into one carrying a short-lived signed ticket, for `<img>`, `<video>`/`<audio>`, downloads,
  `EventSource` and `WebSocket`. Requests are batched and cached; URLs that need no ticket are
  returned unchanged. Requires a core that issues tickets (`POST /api/v1/auth/tickets`).

### Security

- The host no longer writes the access token into a cookie readable by page scripts. Module
  code that relied on that cookie for `<img>`/`<video>`/download URLs must use the helpers
  above.

## [0.1.10] - 2026-09-07

### Fixed

- **`getDateLocale()` is back, as a deprecated bridge.** Its removal broke every
  module bundle built against an earlier SDK at import time. It now returns a
  date-fns compatible `Locale` derived from `Intl` (typed `DateFnsLocale`), so
  older bundles load; new code should use `formatDate` and friends instead.



### Added

- **The date helpers now cover years and minutes.** `startOfYear`, `endOfYear`,
  `addYears`, `subYears`, `addMinutes`, and `isTomorrow` (the mirror of the
  existing `isToday` / `isYesterday`). They complete the arithmetic surface so a
  module doing calendar maths never has to reach back to a date library.

- **Four more date intents, and the ISO week number.** `weekdayNarrow` (the
  single-letter column heads of a calendar grid), `weekdayShort`, `weekdayTime`
  and `hour` (a day's time axis), plus `isoWeek` / `isoWeekYear`. Week 1 is the
  one holding the year's first Thursday, not the first block of seven days — a
  rule that only shows up once a year, in the days around New Year, on the
  screens nobody re-checks. Verified against the 2024→2027 boundaries.

### Added

- **Dates and times, formatted by the platform.** A small module built on `Intl`
  replaces `date-fns`, which seventeen repositories depended on and which needed
  thirteen locale bundles loaded just to write month names in the reader's
  language. Callers now say what a date is FOR — `formatDate(d, 'date')` — and
  the platform decides how to write it, which is what a product shipped in
  thirteen languages needs: a hard-coded `dd/MM/yyyy` prints 03/09/2026 to a
  reader expecting 2026年9月3日. Machine formats (`toISODate`, `toISOMonth`,
  `toISODateTimeLocal`) are kept separate and built from local calendar fields,
  since `toISOString()` shifts the day near midnight.
## [0.1.8] - undated

- Published to npm before this changelog was introduced.
