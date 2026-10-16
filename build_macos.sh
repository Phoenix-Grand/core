#!/usr/bin/env bash
# Build a Kubuno Core macOS distribution: a signed-ready .pkg installer that
# installs the server and registers it as a launchd daemon.
#
# MUST run on macOS (uses pkgbuild / productbuild). Defaults to Apple Silicon
# (aarch64-apple-darwin, e.g. MacBook Air M1). Set TARGET / universal as needed.
#
# Usage (on a Mac):
#   bash build_macos.sh                         # dist/kubuno-core-<ver>-arm64.pkg
#   TARGET=x86_64-apple-darwin bash build_macos.sh
#   UNIVERSAL=1 bash build_macos.sh             # fat arm64+x86_64 binary
#
# Layout on the target Mac:
#   /usr/local/kubuno/{bin,frontend,migrations}   program files
#   /Library/Application Support/Kubuno/config.toml  configuration (kubuno-paths system layout)
#   /Library/Application Support/Kubuno/state         secrets (data.key, setup token, TLS), 0700
#   /Library/Application Support/Kubuno/data          writable data (files, themes, modules store)
#   /Library/Logs/Kubuno                              logs
#   (an existing /etc/kubuno/config.toml from an earlier version is still read)
#   /Library/LaunchDaemons/com.kubuno.core.plist   service definition
#   service account: _kubuno
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Repository layout (2026-10, platform layout): the server in server/ (its Cargo workspace, migrations/,
# config.toml.example, man/), the web host in web/ (frontend/ before it moved), the shared crates in common/.
# The older layout (Cargo.toml at the root, frontend/) is still accepted. The installed layout is the same.
SERVER_DIR=server; [[ -f server/Cargo.toml ]] || SERVER_DIR=.
WEB_DIR=web; [[ -f web/package.json ]] || WEB_DIR=frontend
THEMES_DIR=web/themes; [[ -d web/themes ]] || THEMES_DIR=themes
TARGET_DIR="${CARGO_TARGET_DIR:-$SERVER_DIR/target}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Erreur : build_macos.sh doit être exécuté sur macOS (pkgbuild/productbuild requis)." >&2
  echo "        Sur Linux, utilisez la CI GitHub (runner macos-latest)." >&2
  exit 1
fi

VERSION=$(grep -m1 '^version' "$SERVER_DIR/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')
TARGET="${TARGET:-aarch64-apple-darwin}"
UNIVERSAL="${UNIVERSAL:-0}"
DIST_DIR="${DIST_DIR:-dist}"
IDENTIFIER="com.kubuno.core"
PKGROOT="$(mktemp -d)"
SCRIPTS="$(mktemp -d)"
trap 'rm -rf "$PKGROOT" "$SCRIPTS"' EXIT
mkdir -p "$DIST_DIR"

# ── Frontend ────────────────────────────────────────────────────────────────
if [[ ! -d "$WEB_DIR/dist" ]]; then
  echo "==> Build frontend…"
  (cd "$WEB_DIR" && npm ci && npm run build)
fi

# ── Compilation Rust ────────────────────────────────────────────────────────
build_one() {
  local t="$1"
  rustup target add "$t" >/dev/null 2>&1 || true
  echo "==> Compilation Rust → ${t}…"
  (cd "$SERVER_DIR" && SQLX_OFFLINE=true cargo build --release --target "$t" --bin kubuno-core --bin kubuno)
}

if [[ "$UNIVERSAL" == "1" ]]; then
  build_one aarch64-apple-darwin
  build_one x86_64-apple-darwin
  ARCH_LABEL="universal"
  mkdir -p "$TARGET_DIR/universal/release"
  for b in kubuno-core kubuno; do
    lipo -create -output "$TARGET_DIR/universal/release/$b" \
      "$TARGET_DIR/aarch64-apple-darwin/release/$b" \
      "$TARGET_DIR/x86_64-apple-darwin/release/$b"
  done
  BIN_DIR="$TARGET_DIR/universal/release"
else
  build_one "$TARGET"
  case "$TARGET" in
    aarch64-apple-darwin) ARCH_LABEL="arm64" ;;
    x86_64-apple-darwin)  ARCH_LABEL="x86_64" ;;
    *) ARCH_LABEL="$TARGET" ;;
  esac
  BIN_DIR="$TARGET_DIR/${TARGET}/release"
fi

[[ -f "$BIN_DIR/kubuno-core" ]] || { echo "Erreur : kubuno-core non produit." >&2; exit 1; }

# ── pkgroot : arborescence installée ────────────────────────────────────────
echo "==> Staging du pkgroot…"
mkdir -p \
  "$PKGROOT/usr/local/kubuno/bin" \
  "$PKGROOT/usr/local/kubuno/frontend" \
  "$PKGROOT/usr/local/kubuno/migrations" \
  "$PKGROOT/usr/local/kubuno/themes" \
  "$PKGROOT/usr/local/kubuno/modules" \
  "$PKGROOT/Library/Application Support/Kubuno" \
  "$PKGROOT/Library/LaunchDaemons"
# .keep pour que pkgbuild conserve le dossier modules vide
touch "$PKGROOT/usr/local/kubuno/modules/.keep"

install -m 755 "$BIN_DIR/kubuno-core" "$PKGROOT/usr/local/kubuno/bin/kubuno-core"
install -m 755 "$BIN_DIR/kubuno"      "$PKGROOT/usr/local/kubuno/bin/kubuno"
cp -R "$WEB_DIR/dist/." "$PKGROOT/usr/local/kubuno/frontend/"
cp -R "$SERVER_DIR/migrations/." "$PKGROOT/usr/local/kubuno/migrations/"
cp -R "$THEMES_DIR/."  "$PKGROOT/usr/local/kubuno/themes/"

# config.toml.example adapté macOS (chemins Apple)
cat > "$PKGROOT/Library/Application Support/Kubuno/config.toml.example" << 'CFG'
[server]
host = "0.0.0.0"
port = 8080
frontend_dist = "/usr/local/kubuno/frontend"
modules_dir = "/usr/local/kubuno/modules"
themes_dir = "/Library/Application Support/Kubuno/data/themes"
# OBLIGATOIRE - openssl rand -hex 32
internal_secret = "CHANGEZ_MOI"
secure_cookies = false

[database]
host = "localhost"
port = 5432
user = "kubuno"
password = "CHANGEZ_MOI"
database = "kubuno"
run_migrations = true

[auth]
# OBLIGATOIRE - openssl rand -base64 48
jwt_secret = "CHANGEZ_MOI_AVEC_UNE_CLE_LONGUE_ET_ALEATOIRE"

[storage]
backend = "local"
local_path = "/Library/Application Support/Kubuno/data/files"

[logging]
level = "info"
format = "json"
log_dir = "/Library/Logs/Kubuno"
file_enabled = true
CFG

# launchd daemon
cat > "$PKGROOT/Library/LaunchDaemons/${IDENTIFIER}.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>            <string>${IDENTIFIER}</string>
    <key>ProgramArguments</key> <array><string>/usr/local/kubuno/bin/kubuno-core</string></array>
    <key>UserName</key>         <string>_kubuno</string>
    <key>GroupName</key>        <string>_kubuno</string>
    <key>WorkingDirectory</key> <string>/Library/Application Support/Kubuno</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>KV__SERVER__FRONTEND_DIST</key>    <string>/usr/local/kubuno/frontend</string>
        <key>KUBUNO_PATHS_MODE</key>            <string>system</string>
    </dict>
    <key>RunAtLoad</key>        <true/>
    <key>KeepAlive</key>        <true/>
    <key>StandardOutPath</key>  <string>/Library/Logs/Kubuno/stdout.log</string>
    <key>StandardErrorPath</key><string>/Library/Logs/Kubuno/stderr.log</string>
    <!-- launchd's default soft limit is 256 descriptors for the core AND its
         ~24 child modules; match the Linux units (LimitNOFILE=65536). -->
    <key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>65536</integer></dict>
    <key>HardResourceLimits</key><dict><key>NumberOfFiles</key><integer>65536</integer></dict>
</dict>
</plist>
PLIST

# ── Scripts d'installation (pre / post) ─────────────────────────────────────
cat > "$SCRIPTS/preinstall" << 'PRE'
#!/bin/bash
set -e
# Décharge un daemon existant avant la mise à jour des fichiers.
if [ -f /Library/LaunchDaemons/com.kubuno.core.plist ]; then
    launchctl bootout system /Library/LaunchDaemons/com.kubuno.core.plist 2>/dev/null || \
    launchctl unload /Library/LaunchDaemons/com.kubuno.core.plist 2>/dev/null || true
fi
exit 0
PRE

cat > "$SCRIPTS/postinstall" << 'POST'
#!/bin/bash
set -e

# ── Compte de service _kubuno (UID/GID libre dans la plage système) ─────────
if ! dscl . -read /Groups/_kubuno >/dev/null 2>&1; then
    for gid in $(seq 300 399); do
        if ! dscl . -list /Groups PrimaryGroupID 2>/dev/null | awk '{print $2}' | grep -qx "$gid"; then
            dscl . -create /Groups/_kubuno
            dscl . -create /Groups/_kubuno PrimaryGroupID "$gid"
            dscl . -create /Groups/_kubuno RealName "Kubuno Service"
            break
        fi
    done
fi
KGID=$(dscl . -read /Groups/_kubuno PrimaryGroupID 2>/dev/null | awk '{print $2}')
if ! dscl . -read /Users/_kubuno >/dev/null 2>&1; then
    for uid in $(seq 300 399); do
        if ! dscl . -list /Users UniqueID 2>/dev/null | awk '{print $2}' | grep -qx "$uid"; then
            dscl . -create /Users/_kubuno
            dscl . -create /Users/_kubuno UniqueID "$uid"
            dscl . -create /Users/_kubuno PrimaryGroupID "$KGID"
            dscl . -create /Users/_kubuno UserShell /usr/bin/false
            dscl . -create /Users/_kubuno RealName "Kubuno Service"
            dscl . -create /Users/_kubuno NFSHomeDirectory /var/empty
            dscl . -create /Users/_kubuno IsHidden 1
            break
        fi
    done
fi

# ── Répertoires (layout système de kubuno-paths) ────────────────────────────
KB="/Library/Application Support/Kubuno"
KL="/Library/Logs/Kubuno"
mkdir -p "$KB/state" "$KB/data/files" "$KB/data/themes" "$KB/data/modules" \
         "$KB/data/modules-store" "$KB/modules" "$KL"
# Module data written by an earlier version (/usr/local/var layout) follows the
# new default location, unless that location already exists.
if [ -d /usr/local/var/kubuno/modules ] && [ -z "$(ls -A "$KB/data/modules" 2>/dev/null)" ]; then
    rmdir "$KB/data/modules" 2>/dev/null && mv /usr/local/var/kubuno/modules "$KB/data/modules" || true
fi
# Sème/rafraîchit les thèmes livrés (themes_dir = $KB/data/themes).
# Les thèmes importés par l'admin (autres IDs) ne sont jamais sous /usr/local/kubuno
# et restent donc intacts.
if [ -d /usr/local/kubuno/themes ]; then
    cp -R /usr/local/kubuno/themes/. "$KB/data/themes/" 2>/dev/null || true
fi
chown -R _kubuno:_kubuno "$KB/state" "$KB/data" "$KB/modules" "$KL"
chown root:_kubuno "$KB"
chmod 750 "$KB" "$KB/data"
# Secrets (data.key, setup token, TLS): the service account only.
chmod 700 "$KB/state"

# ── config.toml (sans écrasement) ───────────────────────────────────────────
# An earlier version's /etc/kubuno/config.toml keeps being read: do not shadow
# it with a fresh copy of the example (the new file would take precedence).
if [ -f /etc/kubuno/config.toml ]; then
    CONFIG=/etc/kubuno/config.toml
elif [ ! -f "$KB/config.toml" ]; then
    cp "$KB/config.toml.example" "$KB/config.toml"
    CONFIG="$KB/config.toml"
    echo "→ $CONFIG créé. Renseignez database, auth.jwt_secret et server.internal_secret."
else
    CONFIG="$KB/config.toml"
fi
chmod 640 "$CONFIG"
chown root:_kubuno "$CONFIG"

# ── Chargement du daemon ────────────────────────────────────────────────────
chown root:wheel /Library/LaunchDaemons/com.kubuno.core.plist
chmod 644 /Library/LaunchDaemons/com.kubuno.core.plist
launchctl bootstrap system /Library/LaunchDaemons/com.kubuno.core.plist 2>/dev/null || \
launchctl load /Library/LaunchDaemons/com.kubuno.core.plist 2>/dev/null || true

echo "Kubuno Core installé. Pré-requis : PostgreSQL 16 accessible."
echo "Éditez $CONFIG puis : sudo launchctl kickstart -k system/com.kubuno.core"
exit 0
POST
chmod 755 "$SCRIPTS/preinstall" "$SCRIPTS/postinstall"

# ── Construction du .pkg ────────────────────────────────────────────────────
COMPONENT="$(mktemp -d)/kubuno-core-component.pkg"
echo "==> pkgbuild…"
pkgbuild \
  --root "$PKGROOT" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --scripts "$SCRIPTS" \
  --install-location "/" \
  "$COMPONENT"

# Distribution avec licence
DIST_XML="$(mktemp)"
cat > "$DIST_XML" << DIST
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>Kubuno Core ${VERSION}</title>
    <license file="LICENSE"/>
    <options customize="never" require-scripts="true" hostArchitectures="arm64,x86_64"/>
    <choices-outline><line choice="default"/></choices-outline>
    <choice id="default"><pkg-ref id="${IDENTIFIER}"/></choice>
    <pkg-ref id="${IDENTIFIER}" version="${VERSION}">kubuno-core-component.pkg</pkg-ref>
</installer-gui-script>
DIST

RES="$(mktemp -d)"
cp LICENSE "$RES/LICENSE" 2>/dev/null || echo "Kubuno - AGPL-3.0" > "$RES/LICENSE"

OUT="$DIST_DIR/kubuno-core-${VERSION}-${ARCH_LABEL}.pkg"
echo "==> productbuild…"
productbuild \
  --distribution "$DIST_XML" \
  --package-path "$(dirname "$COMPONENT")" \
  --resources "$RES" \
  ${MACOS_SIGN_IDENTITY:+--sign "$MACOS_SIGN_IDENTITY"} \
  "$OUT"

echo ""
echo "══════════════════════════════════════════════"
echo "  Paquet macOS : $OUT"
echo "  (non signé - pour distribution hors App Store :"
echo "   signez avec MACOS_SIGN_IDENTITY=… puis notarisez avec notarytool.)"
echo "══════════════════════════════════════════════"
