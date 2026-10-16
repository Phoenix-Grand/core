# Packaging du serveur Kubuno Core

Le core se distribue en paquets natifs par plateforme. Tous installent le même
serveur (`kubuno-core`), le frontend host, les migrations SQL et l'enregistrent
comme **service géré** (systemd / service Windows / launchd).

| Plateforme | Format | Script | Service | Testé |
|---|---|---|---|---|
| Debian / Ubuntu | `.deb` | `build_deb.sh` | systemd | ✅ |
| Fedora / RHEL / openSUSE | `.rpm` | `build_rpm.sh` | systemd | ✅ (build + structure) |
| Windows 10/11 / Server | `.exe` (NSIS) | `build_windows.sh` | service WinSW | ✅ (cross-build) |
| macOS (Apple Silicon) | `.pkg` | `build_macos.sh` | launchd | ⏳ (CI / Mac requis) |

La version provient de `Cargo.toml` (`0.1.x`). Pré-requis commun à l'exécution :
un **PostgreSQL 16** accessible (non embarqué dans les paquets).

---

## RPM - `build_rpm.sh`

```bash
bash build_rpm.sh             # → dist/kubuno-core-<ver>-1.<arch>.rpm
bash build_rpm.sh --install   # build + dnf/zypper/rpm install
```

- Layout FHS identique au `.deb` : `/usr/bin`, `/usr/share/kubuno/{frontend,migrations}`,
  `/etc/kubuno/`, unit `/usr/lib/systemd/system/kubuno.service`.
- Compte de service `kubuno` créé dans `%pre` ; données dans `/var/lib/kubuno`,
  logs dans `/var/log/kubuno`.
- `config.toml` géré en `%config(noreplace)` + `%ghost` (jamais écrasé, jamais
  effacé à la désinstallation). `config.toml.example` toujours fourni.
- Scriptlets systemd explicites (`%post`/`%preun`/`%postun`) → **constructible
  sur Debian/Ubuntu** (pas besoin de `systemd-rpm-macros` au build).
- Dépendances runtime auto-détectées par rpm : `openssl-libs`, `libssl.so.3`,
  `systemd`, `ca-certificates` ; recommande `postgresql-server >= 16`.

> Sur Debian/Ubuntu, installer l'outil de build : `sudo apt-get install rpm`.

---

## Windows - `build_windows.sh`

```bash
# Cross-compilation depuis Linux (cargo-xwin + NSIS) :
bash build_windows.sh                              # → dist/kubuno-core-setup-<ver>-x64.exe
TARGET=x86_64-pc-windows-gnu bash build_windows.sh # alternative toolchain GNU

# Build natif sur un runner/poste Windows (Git Bash) : même commande
# (détection automatique de l'hôte Windows → cargo build natif).
```

Installeur **NSIS** qui :
- installe binaires + frontend + migrations dans `C:\Program Files\Kubuno\` ;
- crée les données inscriptibles dans `C:\ProgramData\Kubuno\` (`config.toml`,
  `files\`, `logs\`) - c'est le répertoire de travail du service ;
- enregistre et démarre le service **« Kubuno Core »** via le wrapper
  [WinSW](https://github.com/winsw/winsw) (`kubuno-service.exe` + `.xml`,
  redistribuable, .NET Framework intégré à Windows 10+) ;
- génère un `config.toml` pré-rempli (chemins réels) sans écraser l'existant ;
- ajoute une entrée « Programmes et fonctionnalités » + désinstalleur
  (les données `ProgramData\Kubuno` sont **conservées** à la désinstallation).

Pré-requis de build sur l'hôte Linux : `makensis`, `curl`, `cargo-xwin`,
`clang` (avec un `clang-cl` accessible : `ln -s $(command -v clang) /usr/local/bin/clang-cl`).
Le SDK MSVC est téléchargé/caché automatiquement par cargo-xwin.

---

## macOS - `build_macos.sh` (à exécuter sur un Mac)

```bash
bash build_macos.sh                       # → dist/kubuno-core-<ver>-arm64.pkg (Apple Silicon)
TARGET=x86_64-apple-darwin bash build_macos.sh
UNIVERSAL=1 bash build_macos.sh           # binaire fat arm64+x86_64
MACOS_SIGN_IDENTITY="Developer ID Installer: …" bash build_macos.sh   # signé
```

Paquet **`.pkg`** (pkgbuild + productbuild) qui :
- installe dans `/usr/local/kubuno/{bin,frontend,migrations}` ;
- pose la config dans `/etc/kubuno/config.toml` (chemin lu nativement par le binaire) ;
- données inscriptibles dans `/usr/local/var/kubuno/{files,logs,themes}` ;
- crée un compte de service `_kubuno` et un daemon launchd
  `/Library/LaunchDaemons/com.kubuno.core.plist` (RunAtLoad + KeepAlive).

> Non compilable depuis Linux. Utiliser un Mac ou le runner `macos-latest` de la
> CI. Pour une distribution hors App Store : **signer** (`MACOS_SIGN_IDENTITY`)
> puis **notariser** (`xcrun notarytool`).

---

## Modules - packaging générique

Chaque dépôt module reçoit (via `_tools/deploy_packaging.sh`) trois scripts
**auto-détectants** (id/version lus dans `Cargo.toml`) + un workflow CI :
`build_rpm.sh`, `build_windows.sh`, `build_macos.sh`, `.github/workflows/dist.yml`.

Layout installé (miroir du `.deb`, le core découvre le module à l'identique) :
- binaire + `module.toml` + `frontend/` → dans le dossier `modules/<id>/` du core
  (`/usr/lib/kubuno/modules/<id>` Linux ; `…\Kubuno\modules\<id>` Windows ;
  `/usr/local/kubuno/modules/<id>` macOS) ;
- RPM ajoute aussi les migrations sous `/usr/share/kubuno/modules/<id>/migrations`
  (référence : au runtime elles sont **embarquées** dans le binaire via `sqlx::migrate!`).

Le module **tourne sans `config.toml`** : le core injecte DB/secret/URL par variables
d'environnement (`KUBUNO_*`) et crée le CWD/données. Les paquets Windows/macOS ne
livrent donc pas les migrations et déposent simplement le module dans l'install du core,
puis redémarrent le service. `build_windows.sh` lit l'emplacement du core dans le
registre (`HKLM\Software\Kubuno` `InstallLocation`).

> **Pré-requis core** : les modules sur Windows/macOS exigent un core qui localise
> `config_dir`/`data_dir` des modules de façon portable (réglages
> `server.modules_config_dir` / `server.modules_data_dir`, défauts FHS Linux,
> surchargés par les installeurs core Windows/macOS via `KV__SERVER__MODULES_*`).
> Le core crée ces dossiers avant de lancer chaque module.

Déploiement / build :
```bash
bash _tools/deploy_packaging.sh             # pose les scripts dans tous les modules
bash _tools/deploy_packaging.sh calendar    # ou cibles précises
cd ../calendar && bash build_rpm.sh         # RPM du module (auto-détecté)
```

Dépendances système spécifiques gérées automatiquement : `media` → `ffmpeg`,
`assistant` → recommande `ollama`.

## CI - Releases GitHub multi-plateformes

`.github/workflows/dist.yml` construit RPM (ubuntu), Windows (windows-latest) et
macOS (macos-latest) sur push d'un tag `v*`, et attache les artefacts à la
Release. Le `.deb` reste produit par `build.yml`.

```bash
bash _tools/release.sh core <version>   # tag v<version> + push (par l'utilisateur via !)
```

Les quatre formats apparaissent alors dans la Release `kubuno/core`.
