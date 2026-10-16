# Kubuno - Mobile foundation

The libraries every Kubuno mobile app shares: the API client, the device accounts, the UI component library, the
in-app viewers and the conformance-vector runner. The apps themselves live in their module's repository, under
`<module>/mobile/` (Drive in `kubuno/drive`, Mail in `kubuno/mail`, and so on), and consume these libraries as
published Maven artifacts.

This folder used to be the separate `kubuno/mobile` repository; it moved here in October 2026 with its history
(each app moved to its module's repository the same way).

## Layout

```
mobile/
  settings.gradle.kts, build.gradle.kts, gradle/   the Gradle root (one multi-project build)
  Cargo.toml                                        the Rust client workspace (Visual Studio; see below)
  common/    the code shared by Android and iOS (Kotlin libs, and the Rust renderer kubuno-mobile-render)
  android/   the Android libraries (Kotlin), and the Rust shell kubuno-mobile-shell-android
  ios/       what iOS does differently (phase 2)
```

The rule is the one of the whole repository: `common/` carries everything that can be shared, the OS folders only
override. The Kotlin/JVM libraries all sit in `android/` today (the conversion to Kotlin Multiplatform moves them into
`common/`, plan below). The Rust client (next section) follows the same rule in its own Cargo workspace.

## Rust engine and shells (Visual Studio)

Alongside the Kotlin libraries, `mobile/` hosts the **shared engine of the Rust mobile apps**, built from Visual
Studio exactly like Kubuno Desktop (one Cargo workspace, `.rsproj` per crate, `common/` + per-OS folders) - Path B of
the study `vskubuno/docs/MOBILE-RUST-FEASIBILITY.md`: the UI is a set of `.kbview` screens rendered by a portable Rust
engine, no Java/Kotlin UI, no webview - the same "one view language, native renderers" identity as web and desktop.
It holds **no app**: each module's mobile app lives in that module's repository (`<module>/mobile`, laid out like its
desktop app: `common/`, `android/`, `ios/`) - Drive, Mail, Photos, Maps, Chat, Office Documents.

```
mobile/Cargo.toml                                    the mobile Rust workspace (independent of desktop/, server/)
  common/kubuno-mobile-render         (Kubuno.Mobile.Render.rsproj)          the portable renderer: parses a
                                      .kbview with the shared view grammar (kubuno-desktop-views-syntax, by path from
                                      ../desktop/common), lays it out with taffy (CSS flexbox, like the web design
                                      surface), rasterises it on the CPU with tiny-skia and presents it on a wgpu
                                      surface; no window system
  android/kubuno-mobile-shell-android (Kubuno.Mobile.Shell.Android.rsproj)   the Android shell, a library: a pure-Rust
                                      NativeActivity (window, GPU surface, font, touch gestures, render loop)
  ios/kubuno-mobile-shell-ios         (Kubuno.Mobile.Shell.Ios.rsproj)       the iOS shell, a library: winit + wgpu over
                                      Metal (UIWindow, safe area, font, render loop); built on a Mac
```

**How a module's app plugs in.** Its `common` crate declares an `App { id, label, views, setup }` (the screens, in
order) and, in `setup`, registers what the renderer does not provide itself: its own controls as **host controls**
(`HostControl` + `register_host_control`: the app paints them through a `HostCanvas`, can be a full-bleed background
layer under the floating content, draw an overlay above everything, and receives the shell's pan / pinch gestures -
Maps' interactive map, for instance) and the **images** its screens show (`register_image`). Its `android` crate is
the APK (its `android_main` calls `kubuno_mobile_shell_android::run(app, APP)`, and its Cargo metadata carries the
package id, label and launcher icon); its `ios` crate's `main` calls `kubuno_mobile_shell_ios::run(APP)`.

The shells keep a standalone demo (feature `standalone`, on by default) showing the renderer's sample screen
(`views/home.kbview`), to try the engine without any module. Build it (on a machine with the Android SDK/NDK):

```powershell
$env:CARGO_TARGET_DIR = 'C:\kubuno-build\desktop-target'   # shared with desktop builds
cd mobile/android/kubuno-mobile-shell-android
cargo apk build --target x86_64-linux-android              # emulator; aarch64-linux-android for devices
```

The Kotlin libraries and the Rust engine coexist during the migration: Gradle ignores `Cargo.toml`, Cargo ignores
Gradle's build files.

## The libraries

Coordinates: `com.kubuno.mobile:<name>:<version>`, version = `kubunoMobileVersion` in `gradle.properties`.

| Library | Kind | What it holds |
|---|---|---|
| `core-api` | JVM | HTTP client (OkHttp 5 + Retrofit 3 + kotlinx.serialization), DTOs of the core, the `TokenManager` refresh state machine |
| `core-account` | Android | The shared device accounts: the `com.kubuno` `AccountManager` authenticator, encrypted sessions (Keystore), per-account clients, brokered tokens for sibling apps (Hilt) |
| `core-ui` | Android | The Kubuno Compose component library: design tokens, formatters, the shared shell (top bar, account panel) |
| `core-viewer` | Android | In-app viewers: image, PDF, text, audio/video |
| `core-vectors` | JVM, tests only | Runner for Kubuno's shared conformance vectors, for `testImplementation` |

A library moves here only when a second app needs it; a library used by one module stays with that module (Drive's
offline sync engine, for instance, lives in `drive/mobile/android/sync`).

## How the apps consume the libraries

**Published mode (default).** The libraries are published to the Maven package registry of the Kubuno GitLab
(project `kubuno/core`). A module app declares the group endpoint in its `settings.gradle.kts`:

```
http://gitlab.olinga.lan/api/v4/groups/kubuno/-/packages/maven      (group com.kubuno.mobile only)
```

and pins the version in its own `gradle/libs.versions.toml` (`kubunoMobile = "0.1.0"`). It needs no checkout of the
core. The registry is private: put a token able to read packages (a personal access token with `read_api`, or a
group deploy token with `read_package_registry`) in your **user** Gradle properties, never in a repository:

```properties
# ~/.gradle/gradle.properties (or %USERPROFILE%\.gradle\gradle.properties)
kubunoGitlabToken=<token>
# kubunoGitlabTokenHeader=Deploy-Token   # when the token is a deploy token
```

The environment variable `KUBUNO_GITLAB_TOKEN` works too. This mirrors the rest of Kubuno: modules consume the shared
Rust crates by git tag and the `@kubuno/*` packages from npm, never by linking a local checkout.

**Composite build (local development of the libraries, and the GitHub CI).** To build an app against a core checkout
instead (to try a library change before publishing it, or where the GitLab registry is out of reach), pass the
path of this folder:

```bash
./gradlew assembleDebug -Pkubuno.coreMobile=../../core/mobile     # or KUBUNO_CORE_MOBILE=...
```

Gradle then substitutes every `com.kubuno.mobile:*` dependency with the projects of this build (the version pinned by
the app is ignored). The GitHub workflows of the module repositories use this: they check out `kubuno/core` at the tag
`mobile-v<kubunoMobile>` pinned by the app, so a public build never needs the private registry.

Why both: a Maven repository is the only way for an app to build without the core's sources and with exact,
immutable versions, and the GitLab registry needs no new service (GitLab is the source of truth already, and access
is by token). GitHub runners cannot reach the GitLab on the local network, and GitHub Packages asks for a token even
to read public packages, so the public CI pins the same version through a tagged source checkout instead.

## Build and test

Requirements: JDK 17+ (21 recommended) and the Android SDK (platform 36, build-tools 35), with `ANDROID_HOME` set.

```bash
cd mobile
./gradlew build                 # compile + unit tests of every library
./gradlew test                  # unit tests only
./gradlew publishToMavenLocal   # try the libraries from ~/.m2 (add mavenLocal() to the app)
```

## Releasing the libraries

1. Record the changes in `../CHANGELOG.md` (`[Unreleased]`) and bump `kubunoMobileVersion` in `gradle.properties`.
2. Tag the core `mobile-v<version>` and push the tag to GitLab.
3. Publish from a machine with the Android SDK and a token allowed to write packages: `./gradlew publish`
   (target: `kubunoMavenPublishUrl`, default the `kubuno/core` project registry).
4. Bump `kubunoMobile` in the `gradle/libs.versions.toml` of the apps that need the new version.

A published version is immutable: never republish over an existing version, bump instead. The GitHub workflow
`.github/workflows/mobile.yml` builds and tests the libraries on every change under `mobile/` and on a `mobile-v*`
tag.

## Phase 2 - Kotlin Multiplatform and iOS

Phase 1 (done) was structural: the libraries moved here and each app moved to its module, with their history, and
everything still builds as Android Kotlin. Phase 2 makes `common/` real.

1. **Toolchain.** Add the Kotlin Multiplatform and Compose Multiplatform plugins to the version catalog (aligned on
   the Kotlin version already in use) and enable the `iosArm64` / `iosSimulatorArm64` targets. iOS binaries are built
   and signed on the Mac (Xcode, simulator; "Pair to Mac" from Windows); Android keeps building anywhere.
2. **`core-api` first** (no Android dependency): move it to `common/core-api` as a KMP module, replacing OkHttp and
   Retrofit with Ktor (OkHttp engine on Android, Darwin engine on iOS) behind the same `KubunoClient` surface. The
   `TokenManager` state machine and its tests move unchanged (`commonTest`). `core-vectors` follows.
3. **`core-ui` next**: Compose Multiplatform carries the components almost as they are; resources move to Compose
   resources; Material icons come from the multiplatform artifact. The Kubuno design tokens stay a single source.
4. **`core-account`**: the account model, the session store interface and the per-account client cache go to
   `common/`; the `AccountManager` authenticator and the Keystore stay in `android/`, the Keychain implementation
   goes to `ios/`. Hilt stays on Android; shared code takes plain constructor injection (or Koin) so it runs on iOS.
5. **`core-viewer`**: shared viewer chrome in `common/`; the players and renderers stay platform-specific
   (`media3` on Android, AVKit/PDFKit on iOS).
6. **The apps**, module by module, with Drive as the pilot: each `<module>/mobile/common` becomes the complete app
   (screens, view models, repositories), with Room replaced by a multiplatform store (Room KMP or SQLDelight);
   `<module>/mobile/android` shrinks to the `Application`/`Activity` entry point, WorkManager and the Android
   permissions; `<module>/mobile/ios` gets an Xcode project hosting the shared Compose UI.
7. **Releases**: the same `mobile-v*` tag builds the APK on Linux and the iOS build on a macOS runner.

The order keeps every step shippable: each library is converted behind an unchanged API, so the apps keep building
against the published artifacts while the conversion goes on.
