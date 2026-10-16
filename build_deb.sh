#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Repository layout (2026-10, platform layout): the server in server/ (its Cargo workspace, migrations/,
# config.toml.example, man/), the web host in web/ (frontend/ before it moved), the shared crates in common/.
# The older layout (Cargo.toml at the root, frontend/) is still accepted. The installed layout is the same.
SERVER_DIR=server; [[ -f server/Cargo.toml ]] || SERVER_DIR=.
WEB_DIR=web; [[ -f web/package.json ]] || WEB_DIR=frontend
THEMES_DIR=web/themes; [[ -d web/themes ]] || THEMES_DIR=themes
TARGET_DIR="${CARGO_TARGET_DIR:-$SERVER_DIR/target}"

# --no-install: build the packages only (same as KUBUNO_NO_INSTALL=1).
_args=()
for _a in "$@"; do
  if [[ "$_a" == "--no-install" ]]; then export KUBUNO_NO_INSTALL=1; else _args+=("$_a"); fi
done
set -- "${_args[@]+"${_args[@]}"}"

# ── Config ──────────────────────────────────────────────────────────────────
VERSION=$(grep '^version' "$SERVER_DIR/Cargo.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')
ARCH=$(dpkg --print-architecture 2>/dev/null || echo "amd64")

# Git-derived build identifier: <commit-count>.g<short-hash>[.dirty.<UTC stamp>]
# Traceable to the exact commit, monotonic across builds, machine-independent.
# Shared by every package produced in this run.
GIT_COMMIT="$(git rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
GIT_COUNT="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
BUILD_ID="${GIT_COUNT}.g${GIT_COMMIT}"
[ -n "$(git status --porcelain 2>/dev/null)" ] && BUILD_ID="${BUILD_ID}.dirty.$(date -u +%Y%m%d%H%M%S)"
DIST_DIR="${DIST_DIR:-dist}"
STATE_DIR=".build_state"
mkdir -p "$DIST_DIR" "$STATE_DIR"

# Composants disponibles - ajouter ici le nom d'un nouveau module pour l'enregistrer
ALL_COMPONENTS=(
  core
  drive calendar photos notes office paintsharp forms
  chat contacts assistant mail code media keestore maps flow tasks
)

# ── Aide ─────────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--help" ]] || [[ "${1:-}" == "-h" ]]; then
  cat << EOF
Usage: bash build_deb.sh [OPTIONS] [COMPOSANT...]

Construit les paquets Debian Kubuno modifiés et les installe.

Arguments:
  (aucun)           Détecte automatiquement les composants modifiés et les build
  all               Rebuild tous les composants sans vérification
  <composant...>    Force le build des composants spécifiés (ex: core mail)

Options:
  -h, --help        Affiche cette aide
  --no-install      Construit les paquets sans les installer (KUBUNO_NO_INSTALL=1)

Composants disponibles:
  core              Core Rust + frontend React
  drive             Module fichiers
  calendar          Module calendrier
  photos            Module galerie photo
  notes             Module prise de notes
  office            Module documents collaboratifs
  paintsharp             Suite créative (3D, raster, vectoriel, vidéo)
  forms             Module formulaires
  chat              Module messagerie chiffrée
  contacts          Module carnet d'adresses
  assistant            Module assistant IA
  mail              Module messagerie IMAP/SMTP
  code              Module IDE web
  media             Module Watch & Listen
  keestore          Module gestionnaire de mots de passe
  maps              Module cartographie OpenStreetMap
  flow              Orchestrateur de workflows visuels no-code

Exemples:
  bash build_deb.sh              # build auto (composants modifiés seulement)
  bash build_deb.sh mail         # force le build de kubuno-mail
  bash build_deb.sh core mail    # force le build de kubuno-core et kubuno-mail
  bash build_deb.sh all          # rebuild tout

État des builds: .build_state/<composant>  (numéro + hash sources)
Paquets générés: dist/

EOF
  exit 0
fi

# ── Migration depuis l'ancien .build_number global ──────────────────────────
# Si .build_state/ est vide et .build_number existe, initialise tous les
# compteurs au numéro global pour ne pas rétrograder les paquets installés.
if [[ -f ".build_number" ]] && [[ -z "$(ls -A "$STATE_DIR" 2>/dev/null)" ]]; then
  _old=$(cat .build_number)
  echo "==> Migration .build_number → .build_state/ (base #${_old})…"
  for _c in "${ALL_COMPONENTS[@]}"; do
    printf '%s\n\n' "$_old" > "$STATE_DIR/$_c"
  done
fi

# ── Helpers ─────────────────────────────────────────────────────────────────

# Fichiers sources à surveiller par composant (pour détecter les changements)
get_sources() {
  case "$1" in
    core) echo "$SERVER_DIR/src $SERVER_DIR/Cargo.toml $SERVER_DIR/Cargo.lock $SERVER_DIR/migrations common crates \
                $WEB_DIR/src $WEB_DIR/public $WEB_DIR/package.json $WEB_DIR/package-lock.json \
                $WEB_DIR/vite.config.ts $WEB_DIR/tailwind.config.ts $WEB_DIR/index.html" ;;
    *)    echo "modules/$1 Cargo.lock Cargo.toml" ;;
  esac
}

# Binaires Rust à compiler par composant
get_bins() {
  case "$1" in
    core) echo "kubuno-core kubuno" ;;
    *)    echo "kubuno-$1" ;;
  esac
}

# Hash SHA-256 de tous les fichiers sources d'un ensemble de chemins
compute_hash() {
  local hash_input
  hash_input=$(
    for p in "$@"; do
      [[ -e "$p" ]] || continue
      find "$p" -type f \( \
        -name "*.rs" -o -name "*.toml" -o -name "*.sql" \
        -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" \
        -o -name "*.json" -o -name "*.html" -o -name "*.css" \
      \) 2>/dev/null
    done | sort -u
  )
  if [[ -z "$hash_input" ]]; then echo "empty"; return; fi
  printf '%s\n' "$hash_input" | tr '\n' '\0' | xargs -0 sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1
}

get_build_num() {
  local f="$STATE_DIR/$1"
  [[ -f "$f" ]] && head -1 "$f" || echo "0"
}

get_stored_hash() {
  local f="$STATE_DIR/$1"
  [[ -f "$f" ]] && sed -n '2p' "$f" || echo ""
}

save_state() {
  printf '%s\n%s\n' "$2" "$3" > "$STATE_DIR/$1"
}

needs_rebuild() {
  local name="$1"
  local current_hash
  read -ra src <<< "$(get_sources "$name")"
  current_hash=$(compute_hash "${src[@]}")
  [[ "$(get_stored_hash "$name")" != "$current_hash" ]]
}

purge_old_debs() {
  local pkg="$1"
  while IFS= read -r -d '' f; do
    rm -f "$f"
    echo "  ✗ Supprimé : $(basename "$f")"
  done < <(find "$DIST_DIR" -maxdepth 1 -name "${pkg}_*.deb" -print0 2>/dev/null)
}

# build_deb <package> <description> <setup_fn> <build_num>
# BUILD_NUM et FULL_VERSION sont définis en local ici et visibles dans setup_fn (dynamic scoping bash)
build_deb() {
  local PACKAGE="$1"
  local DESCRIPTION="$2"
  local SETUP_FN="$3"
  local BUILD_NUM="$4"
  local FULL_VERSION="${VERSION}-${BUILD_NUM}"

  local PKG_NAME="${PACKAGE}_${FULL_VERSION}_${ARCH}"
  local WORK_DIR
  WORK_DIR="$(mktemp -d)"
  local PKG_DIR="${WORK_DIR}/${PKG_NAME}"
  local OUTPUT="${DIST_DIR}/${PKG_NAME}.deb"

  echo "==> ${PACKAGE} (build #${BUILD_NUM})…"
  mkdir -p "${PKG_DIR}/DEBIAN"

  $SETUP_FN "${PKG_DIR}" "${PACKAGE}" "${DESCRIPTION}"

  # --root-owner-group: without it, dpkg-deb records the uid/gid of whoever
  # built the package, and dpkg restores those NUMERIC ids on the target. A
  # package built by uid 1000 therefore installed /usr/lib/kubuno/modules and
  # /etc/kubuno owned by whatever account happens to be uid 1000 over there -
  # a build-machine account leaking into every installation. Ownership is set
  # deliberately in postinst instead.
  dpkg-deb --root-owner-group --build "${PKG_DIR}" "${OUTPUT}"
  rm -rf "${WORK_DIR}"
  echo "  ✓ ${OUTPUT}"
}

# ════════════════════════════════════════════════════════
# kubuno-core
# ════════════════════════════════════════════════════════
setup_core() {
    local PKG_DIR="$1"
    local PACKAGE="$2"
    local DESCRIPTION="$3"

    mkdir -p \
        "${PKG_DIR}/usr/bin" \
        "${PKG_DIR}/usr/share/kubuno/frontend" \
        "${PKG_DIR}/usr/share/kubuno/migrations" \
        "${PKG_DIR}/usr/share/man/man1" \
        "${PKG_DIR}/etc/kubuno" \
        "${PKG_DIR}/etc/logrotate.d" \
        "${PKG_DIR}/lib/systemd/system" \
        "${PKG_DIR}/usr/lib/kubuno/modules" \
        "${PKG_DIR}/var/backups/kubuno"

    install -m 755 "$TARGET_DIR/release/kubuno-core" "${PKG_DIR}/usr/bin/kubuno-core"
    install -m 755 "$TARGET_DIR/release/kubuno"       "${PKG_DIR}/usr/bin/kubuno"
    gzip -c "$SERVER_DIR/man/kubuno.1" > "${PKG_DIR}/usr/share/man/man1/kubuno.1.gz"

    if [[ -d "$WEB_DIR/dist" ]]; then
        cp -r "$WEB_DIR/dist/." "${PKG_DIR}/usr/share/kubuno/frontend/"
        # Rétro-compatibilité des onglets ouverts : on CONSERVE les anciens chunks
        # hashés déjà déployés (assets/) en plus des nouveaux. Ainsi un onglet chargé
        # avant le déploiement peut encore résoudre ses imports dynamiques (pas de 404
        # → plus de « double-clic qui n'ouvre rien »). `-n` = ne pas écraser les neufs.
        # Les fichiers hashés sont immutables ; on accumule (purge éventuelle plus tard).
        if [[ -d /usr/share/kubuno/frontend/assets ]]; then
            mkdir -p "${PKG_DIR}/usr/share/kubuno/frontend/assets"
            cp -rn /usr/share/kubuno/frontend/assets/. "${PKG_DIR}/usr/share/kubuno/frontend/assets/" 2>/dev/null || true
        fi
    fi

    install -m 640 "$SERVER_DIR/config.toml.example" "${PKG_DIR}/etc/kubuno/config.toml.example"
    # Migrations are split per engine (postgres/mysql/sqlite) since the
    # multi-database port, so copy the whole tree, not a flat *.sql glob.
    cp -r "$SERVER_DIR/migrations/." "${PKG_DIR}/usr/share/kubuno/migrations/"

    # Thèmes livrés avec l'application (bundles CSS/JS dans themes/). Stagés en
    # lecture seule sous /usr/share, puis semés dans /var/lib/kubuno/themes au
    # postinst (le répertoire lu à l'exécution).
    if [[ -d "$THEMES_DIR" ]]; then
        mkdir -p "${PKG_DIR}/usr/share/kubuno/themes"
        cp -r "$THEMES_DIR/." "${PKG_DIR}/usr/share/kubuno/themes/"
    fi

    cat > "${PKG_DIR}/etc/logrotate.d/kubuno" << 'LOGROTATE'
/var/log/kubuno/error.log
/var/log/kubuno/access.log {
    daily
    dateext
    dateformat -%Y-%m-%d
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
LOGROTATE

    cat > "${PKG_DIR}/lib/systemd/system/kubuno.service" << 'SYSTEMD'
[Unit]
Description=Kubuno Core - plateforme cloud self-hosted
Documentation=https://github.com/kubuno/kubuno
After=network.target postgresql.service
# Wants, not Requires: a great many instances keep their database on another
# machine, and `Requires` makes the service refuse to start when no local
# postgresql.service exists - which is exactly the supported remote setup. The
# RPM has always used Wants; this aligns the two.
Wants=postgresql.service
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
User=kubuno
Group=kubuno
WorkingDirectory=/var/lib/kubuno
Environment=KV__SERVER__FRONTEND_DIST=/usr/share/kubuno/frontend
ExecStart=/usr/bin/kubuno-core
Restart=on-failure
RestartSec=3s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=kubuno-core
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
# /var/backups/kubuno : destination par défaut de la sauvegarde planifiée
# (crate::backup). Sans cette entrée, ProtectSystem=strict rend le
# répertoire en lecture seule et chaque exécution échoue sur
# « Read-only file system » - une politique armée qui ne produit rien.
# Chaque chemin est préfixé de « - » : sans cela, un répertoire absent fait
# échouer la mise en place du namespace et le service ne démarre pas du tout
# (« 226/NAMESPACE »), sur une machine neuve où aucun module n'est encore
# installé par exemple. Le préfixe dit à systemd d'ignorer ce qui n'existe pas.
ReadWritePaths=-/var/lib/kubuno -/etc/kubuno -/var/log/kubuno -/usr/lib/kubuno/modules -/var/backups/kubuno

[Install]
WantedBy=multi-user.target
SYSTEMD

    cat > "${PKG_DIR}/DEBIAN/control" << EOF
Package: ${PACKAGE}
Version: ${FULL_VERSION}
Architecture: ${ARCH}
Maintainer: Martinien OLINGA <kubuno@toiledev.com>
Depends: libssl3, ca-certificates, postgresql-common
Recommends: postgresql-16
Section: web
Priority: optional
Homepage: https://github.com/kubuno/core
Description: Kubuno Core - plateforme cloud self-hosted (build ${BUILD_NUM})
 Core haute performance (Rust + Axum) de la plateforme Kubuno.
 Alternative souverainiste et open-source à Google Workspace et Microsoft 365, architecture modulaire.
EOF

    cat > "${PKG_DIR}/DEBIAN/postinst" << 'POSTINST'
#!/bin/bash
set -e
if ! id -u kubuno &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin kubuno
fi
# Store des modules : c'est là que le core et « kubuno modules:install »
# déballent les .kbpkg. Absent, le premier qui écrit en devient propriétaire -
# root quand l'installation passe par sudo - et le service ne peut plus rien y
# installer ensuite. Le créer ici le donne au compte de service dès le départ.
mkdir -p /var/lib/kubuno/drive /var/lib/kubuno/themes /var/lib/kubuno/modules-store
# Répertoire des modules : l'unité le veut accessible en écriture, et une
# installation du seul core n'en contient encore aucun. Absent, systemd refusait
# de construire le namespace et le service ne démarrait pas (226/NAMESPACE).
mkdir -p /usr/lib/kubuno/modules
# The service installs modules from the marketplace and writes each module's
# configuration itself, so both directories must belong to it. Left to root they
# made every hot install fail - the module landed in the writable store but its
# configuration directory could not be created.
# L'assistant d'installation écrit /etc/kubuno/config.toml par renommage
# atomique (.config.toml.new puis rename), ce qui exige le droit d'écriture sur le
# RÉPERTOIRE et pas seulement sur le fichier. Livré root:root, l'assistant échouait
# à sa dernière étape, APRÈS avoir créé la base. Le bit setgid maintient le groupe
# sur ce que le service y dépose ensuite.
mkdir -p /etc/kubuno
chown root:kubuno /etc/kubuno
chmod 2775 /etc/kubuno
mkdir -p /etc/kubuno/modules
chown kubuno:kubuno /usr/lib/kubuno/modules /etc/kubuno/modules
chmod 750 /usr/lib/kubuno/modules /etc/kubuno/modules
# Destination par défaut des sauvegardes. 0700 : le fichier contient les
# empreintes de mots de passe de tous les comptes de l'instance.
mkdir -p /var/backups/kubuno
chown kubuno:kubuno /var/backups/kubuno
chmod 700 /var/backups/kubuno
# Sème/rafraîchit les thèmes livrés (IDs kubuno-*). Écrase les thèmes livrés pour
# qu'ils restent à jour ; les thèmes IMPORTÉS par l'admin (autres IDs) ne sont
# jamais dans /usr/share et restent donc intacts.
if [ -d /usr/share/kubuno/themes ]; then
    cp -r /usr/share/kubuno/themes/. /var/lib/kubuno/themes/ 2>/dev/null || true
fi
chown -R kubuno:kubuno /var/lib/kubuno
chmod 750 /var/lib/kubuno /var/lib/kubuno/themes /var/lib/kubuno/modules-store
mkdir -p /var/log/kubuno
chown kubuno:adm /var/log/kubuno
chmod 750 /var/log/kubuno
if [ ! -f /etc/kubuno/config.toml ]; then
    cp /etc/kubuno/config.toml.example /etc/kubuno/config.toml
    echo "→ /etc/kubuno/config.toml créé (valeurs d'exemple)."
    echo "→ Kubuno n'est pas encore installé : ouvrez http://<cette-machine>:8080/ dans un"
    echo "  navigateur, l'assistant d'installation vous guidera (base de données, compte"
    echo "  administrateur). Le jeton d'installation est dans /var/lib/kubuno/setup-token"
    echo "  et dans « journalctl -u kubuno -n 40 »."
fi
# Le service écrit lui-même ce fichier au terme de l'assistant d'installation :
# il doit donc lui appartenir. 0640 le garde illisible hors du groupe - il porte
# le mot de passe de la base et le secret JWT.
chmod 640 /etc/kubuno/config.toml
chown kubuno:kubuno /etc/kubuno/config.toml
systemctl daemon-reload || true
systemctl enable kubuno || true
systemctl reset-failed kubuno 2>/dev/null || true
systemctl restart kubuno || true
POSTINST
    chmod 755 "${PKG_DIR}/DEBIAN/postinst"

    cat > "${PKG_DIR}/DEBIAN/prerm" << 'PRERM'
#!/bin/bash
set -e
systemctl stop kubuno || true
systemctl disable kubuno || true
PRERM
    chmod 755 "${PKG_DIR}/DEBIAN/prerm"
}

# ════════════════════════════════════════════════════════
# Fonction générique pour les modules (layout identique)
# Usage: setup_module <PKG_DIR> <PACKAGE> <DESCRIPTION> <module_name> <description_text> <extra_data_dirs...>
# ════════════════════════════════════════════════════════
setup_module() {
    local PKG_DIR="$1"
    local PACKAGE="$2"
    local MODULE="$3"
    local DESC_TEXT="$4"
    shift 4
    local EXTRA_DATA_DIRS=("$@")

    mkdir -p \
        "${PKG_DIR}/usr/lib/kubuno/modules/${MODULE}" \
        "${PKG_DIR}/usr/share/kubuno/modules/${MODULE}/migrations" \
        "${PKG_DIR}/etc/kubuno/modules/${MODULE}" \
        "${PKG_DIR}/usr/bin"

    install -m 755 "target/release/kubuno-${MODULE}" \
        "${PKG_DIR}/usr/lib/kubuno/modules/${MODULE}/kubuno-${MODULE}"

    ln -sf "/usr/lib/kubuno/modules/${MODULE}/kubuno-${MODULE}" \
        "${PKG_DIR}/usr/bin/kubuno-${MODULE}"

    if [[ -f "modules/${MODULE}/module.toml" ]]; then
        install -m 644 "modules/${MODULE}/module.toml" \
            "${PKG_DIR}/usr/lib/kubuno/modules/${MODULE}/module.toml"
    fi

    # Bundle UI du module (plugin runtime) : buildé séparément et servi par le core
    # depuis <dir>/<id>/frontend/. Présent seulement pour les modules migrés (entry.ts).
    if [[ -f "frontend/src/modules/${MODULE}/entry.ts" ]]; then
        if [[ ! -f "frontend/dist-modules/${MODULE}/entry.js" ]]; then
            (cd frontend && MODULE_ID="${MODULE}" npm run build:module) || true
        fi
        if [[ -d "frontend/dist-modules/${MODULE}" ]]; then
            mkdir -p "${PKG_DIR}/usr/lib/kubuno/modules/${MODULE}/frontend"
            cp -r "frontend/dist-modules/${MODULE}/." \
                "${PKG_DIR}/usr/lib/kubuno/modules/${MODULE}/frontend/"
        fi
    fi

    if [[ -d "modules/${MODULE}/migrations" ]]; then
        cp "modules/${MODULE}/migrations/"*.sql \
            "${PKG_DIR}/usr/share/kubuno/modules/${MODULE}/migrations/"
    fi

    if [[ -f "modules/${MODULE}/config.toml.example" ]]; then
        install -m 640 "modules/${MODULE}/config.toml.example" \
            "${PKG_DIR}/etc/kubuno/modules/${MODULE}/config.toml.example"
    fi

    cat > "${PKG_DIR}/DEBIAN/control" << EOF
Package: ${PACKAGE}
Version: ${FULL_VERSION}
Architecture: ${ARCH}
Maintainer: Martinien OLINGA <kubuno@toiledev.com>
Depends: libssl3, ca-certificates, kubuno-core (>= ${VERSION})
Section: web
Priority: optional
Homepage: https://github.com/kubuno/kubuno
Description: ${DESC_TEXT} (build ${BUILD_NUM})
EOF

    # Construire le script postinst dynamiquement
    local data_dirs_script=""
    for d in "${EXTRA_DATA_DIRS[@]}"; do
        data_dirs_script+="mkdir -p /var/lib/kubuno/modules/${MODULE}/${d}"$'\n'
    done

    cat > "${PKG_DIR}/DEBIAN/postinst" << POSTINST
#!/bin/bash
set -e
if ! id -u kubuno &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin kubuno
fi
${data_dirs_script}chown -R kubuno:kubuno /var/lib/kubuno/modules
chmod 750 /var/lib/kubuno/modules
if [ ! -f /etc/kubuno/modules/${MODULE}/config.toml ]; then
    cp /etc/kubuno/modules/${MODULE}/config.toml.example \
       /etc/kubuno/modules/${MODULE}/config.toml
    echo "→ /etc/kubuno/modules/${MODULE}/config.toml créé."
fi
chmod 640 /etc/kubuno/modules/${MODULE}/config.toml
chown root:kubuno /etc/kubuno/modules/${MODULE}/config.toml
POSTINST
    chmod 755 "${PKG_DIR}/DEBIAN/postinst"
}

# ── setup_* par module ───────────────────────────────────────────────────────

setup_drive() {
    setup_module "$1" "$2" "drive" \
        "Kubuno Drive - module de gestion de fichiers" \
        "data" "temp"
}

setup_calendar() {
    setup_module "$1" "$2" "calendar" \
        "Kubuno Calendar - module calendrier" \
        "data"
}

setup_photos() {
    setup_module "$1" "$2" "photos" \
        "Kubuno Photos - module galerie photo" \
        "data" "temp"
}

setup_notes() {
    setup_module "$1" "$2" "notes" \
        "Kubuno Notes - module prise de notes"
}

setup_office() {
    setup_module "$1" "$2" "office" \
        "Kubuno Office - module documents collaboratifs"
}

setup_paintsharp() {
    setup_module "$1" "$2" "paintsharp" \
        "Kubuno PaintSharp - suite créative (3D, raster, vectoriel, vidéo)"
}

setup_forms() {
    setup_module "$1" "$2" "forms" \
        "Kubuno Forms - module de création de formulaires" \
        "uploads" "temp"
}

setup_chat() {
    setup_module "$1" "$2" "chat" \
        "Kubuno Chat - messagerie chiffrée de bout en bout" \
        "media" "temp"
}

setup_contacts() {
    setup_module "$1" "$2" "contacts" \
        "Kubuno Contacts - carnet d'adresses" \
        "avatars" "temp"
}

setup_assistant() {
    local PKG_DIR="$1"
    local PACKAGE="$2"
    local MODULE="assistant"

    setup_module "$PKG_DIR" "$PACKAGE" "$MODULE" \
        "Kubuno Assistant - assistant IA multi-modèles"

    # Recommends: ollama (pas de hard-dep)
    sed -i "s/^Depends:/Recommends: ollama\nDepends:/" \
        "${PKG_DIR}/DEBIAN/control"
}

setup_mail() {
    setup_module "$1" "$2" "mail" \
        "Kubuno Mail - module de messagerie IMAP/SMTP" \
        "data"
}

setup_code() {
    setup_module "$1" "$2" "code" \
        "Kubuno Code - module IDE web" \
        "projects" "extensions"
}

setup_media() {
    local PKG_DIR="$1"
    local PACKAGE="$2"
    local MODULE="media"

    setup_module "$PKG_DIR" "$PACKAGE" "$MODULE" \
        "Kubuno Media - module Watch et Listen" \
        "cache" "thumbnails"

    # Dépendance supplémentaire : ffmpeg
    sed -i "s/^Depends: libssl3, ca-certificates,/Depends: libssl3, ca-certificates, ffmpeg,/" \
        "${PKG_DIR}/DEBIAN/control"
}

setup_keestore() {
    setup_module "$1" "$2" "keestore" \
        "Kubuno Keestore - gestionnaire de mots de passe KeePass"
}

setup_maps() {
    setup_module "$1" "$2" "maps" \
        "Kubuno Maps - cartographie OpenStreetMap self-hosted" \
        "gpx"
}

setup_flow() {
    setup_module "$1" "$2" "flow" \
        "Kubuno Flow - orchestrateur de workflows visuels no-code"
}

setup_tasks() {
    setup_module "$1" "$2" "tasks" \
        "Kubuno Tasks - tâches et tableaux Kanban (Tasks + Deck)" \
        "data"
}

# ── Sélection des cibles ────────────────────────────────────────────────────
BUILD_TARGETS=()

if [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "all" ]]; then
      BUILD_TARGETS=("${ALL_COMPONENTS[@]}")
      break
    fi
    found=false
    for c in "${ALL_COMPONENTS[@]}"; do
      [[ "$c" == "$arg" ]] && found=true && break
    done
    if ! $found; then
      echo "Erreur: composant inconnu '$arg'" >&2
      echo "Disponibles: ${ALL_COMPONENTS[*]}" >&2
      exit 1
    fi
    BUILD_TARGETS+=("$arg")
  done
else
  echo "==> Détection des changements…"
  for c in "${ALL_COMPONENTS[@]}"; do
    if needs_rebuild "$c"; then
      echo "  modifié  : $c"
      BUILD_TARGETS+=("$c")
    else
      echo "  inchangé : $c (build #$(get_build_num "$c"))"
    fi
  done
fi

if [[ "${#BUILD_TARGETS[@]}" -eq 0 ]]; then
  echo ""
  echo "Aucun changement détecté - rien à builder."
  echo "Pour forcer : bash build_deb.sh all  ou  bash build_deb.sh <composant...>"
  exit 0
fi

# ── Compilation ──────────────────────────────────────────────────────────────
RUST_BINS=()
BUILD_FRONTEND=false
for comp in "${BUILD_TARGETS[@]}"; do
  for bin in $(get_bins "$comp"); do
    RUST_BINS+=("--bin" "$bin")
  done
  [[ "$comp" == "core" ]] && BUILD_FRONTEND=true
done

echo ""
echo "==> Kubuno - build Debian"
echo "    Version : ${VERSION}"
echo "    Arch    : ${ARCH}"
echo "    Cibles  : ${BUILD_TARGETS[*]}"
echo ""

if [[ "${#RUST_BINS[@]}" -gt 0 ]]; then
  echo "==> Compilation Rust…"
  (cd "$SERVER_DIR" && SQLX_OFFLINE=true cargo build --release "${RUST_BINS[@]}")
fi

if $BUILD_FRONTEND && [[ -f "$WEB_DIR/package.json" ]]; then
  echo "==> Build frontend…"
  (cd "$WEB_DIR" && npm run build)
fi

# ── Packaging ────────────────────────────────────────────────────────────────
declare -A BUILT_NUMS=()

for comp in "${BUILD_TARGETS[@]}"; do
  pkg="kubuno-${comp}"

  echo ""
  purge_old_debs "$pkg"

  build_deb "$pkg" "" "setup_${comp}" "$BUILD_ID"

  read -ra src <<< "$(get_sources "$comp")"
  current_hash=$(compute_hash "${src[@]}")
  save_state "$comp" "$BUILD_ID" "$current_hash"
  BUILT_NUMS[$comp]=$BUILD_ID
done

# ── Résumé ───────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo "  Paquets générés :"
for comp in "${BUILD_TARGETS[@]}"; do
  num="${BUILT_NUMS[$comp]}"
  echo "  dist/kubuno-${comp}_${VERSION}-${num}_${ARCH}.deb"
done
echo "══════════════════════════════════════════════"

# ── Installation ─────────────────────────────────────────────────────────────
DO_INSTALL=true
# --no-install (or KUBUNO_NO_INSTALL=1): build only, never touch the packages installed on this machine.
[[ "${KUBUNO_NO_INSTALL:-0}" == "1" ]] && DO_INSTALL=false

# En mode interactif (TTY), demander confirmation avant d'installer
if $DO_INSTALL && [[ -t 0 ]]; then
  echo ""
  read -r -p "Installer maintenant avec apt ? [O/n] " _confirm
  case "${_confirm:-o}" in
    [nN]*) DO_INSTALL=false ;;
  esac
fi

if $DO_INSTALL; then
  echo ""
  echo "==> Installation…"
  for comp in "${BUILD_TARGETS[@]}"; do
    num="${BUILT_NUMS[$comp]}"
    pkg_file="${DIST_DIR}/kubuno-${comp}_${VERSION}-${num}_${ARCH}.deb"
    echo "  apt install ./${pkg_file}"
    sudo apt install -y --allow-downgrades "./${pkg_file}"
  done
  echo "  ✓ Installation terminée."
else
  echo ""
  echo "  Installation ignorée. Pour installer manuellement :"
  for comp in "${BUILD_TARGETS[@]}"; do
    num="${BUILT_NUMS[$comp]}"
    echo "    sudo apt install ./dist/kubuno-${comp}_${VERSION}-${num}_${ARCH}.deb"
  done
fi
