#!/usr/bin/env bash
# Build a Kubuno Core RPM package (Fedora / RHEL / openSUSE).
#
# Mirrors build_deb.sh: same FHS layout (/usr/bin, /usr/share/kubuno, /etc/kubuno),
# same systemd unit, same postinst/prerm behaviour - expressed as an RPM .spec.
#
# Usage:
#   bash build_rpm.sh            # build the core RPM into dist/
#   bash build_rpm.sh --install  # build then `dnf/zypper/rpm` install locally
#
# Requirements: rpmbuild (rpm-build). The Rust binaries and frontend must be
# built beforehand (this script does it for you if missing).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Repository layout (2026-10, platform layout): the server in server/ (its Cargo workspace, migrations/,
# config.toml.example, man/), the web host in web/ (frontend/ before it moved), the shared crates in common/.
# The older layout (Cargo.toml at the root, frontend/) is still accepted. The installed layout is the same.
SERVER_DIR=server; [[ -f server/Cargo.toml ]] || SERVER_DIR=.
WEB_DIR=web; [[ -f web/package.json ]] || WEB_DIR=frontend
THEMES_DIR=web/themes; [[ -d web/themes ]] || THEMES_DIR=themes
TARGET_DIR="${CARGO_TARGET_DIR:-$SERVER_DIR/target}"

VERSION=$(grep -m1 '^version' "$SERVER_DIR/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')
RELEASE="${RPM_RELEASE:-1}"
# RPM arch naming differs from dpkg: amd64→x86_64, arm64→aarch64.
case "$(uname -m)" in
  x86_64)  ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *) ARCH="$(uname -m)" ;;
esac
DIST_DIR="${DIST_DIR:-dist}"
mkdir -p "$DIST_DIR"

if ! command -v rpmbuild &>/dev/null; then
  echo "Erreur : rpmbuild introuvable. Installez le paquet 'rpm-build' (Fedora/RHEL) ou 'rpm' (Debian/Ubuntu)." >&2
  exit 1
fi

# ── Pré-requis : binaires + frontend ────────────────────────────────────────
if [[ ! -x "$TARGET_DIR/release/kubuno-core" || ! -x "$TARGET_DIR/release/kubuno" ]]; then
  echo "==> Compilation Rust (release)…"
  (cd "$SERVER_DIR" && SQLX_OFFLINE=true cargo build --release --bin kubuno-core --bin kubuno)
fi
if [[ ! -d "$WEB_DIR/dist" ]]; then
  echo "==> Build frontend…"
  (cd "$WEB_DIR" && npm ci && npm run build)
fi

# ── Arborescence de build RPM ───────────────────────────────────────────────
# rpmbuild nettoie %{buildroot} avant %install : on remplit donc le buildroot
# DANS %install (méthode canonique), en référençant l'arbre source via _srcdir.
TOP="$(mktemp -d)"
trap 'rm -rf "$TOP"' EXIT
mkdir -p "$TOP"/{BUILD,RPMS,SOURCES,SPECS,SRPMS,BUILDROOT}

SRCDIR="$PWD"
TARGET_ABS="$(cd "$TARGET_DIR" && pwd)"

# README (fallback si absent)
[[ -f README.md ]] || echo "# Kubuno Core" > "$TOP/SOURCES/README.md"
README_SRC="$([[ -f README.md ]] && echo "$SRCDIR/README.md" || echo "$TOP/SOURCES/README.md")"

# systemd unit (identique au .deb) → déposé dans SOURCES
cat > "$TOP/SOURCES/kubuno.service" << 'SYSTEMD'
[Unit]
Description=Kubuno Core - plateforme cloud self-hosted
Documentation=https://github.com/kubuno/core
After=network.target postgresql.service
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
# répertoire en lecture seule et chaque exécution échoue.
ReadWritePaths=/var/lib/kubuno /etc/kubuno /var/log/kubuno /usr/lib/kubuno/modules /var/backups/kubuno

[Install]
WantedBy=multi-user.target
SYSTEMD

# ── Spec ────────────────────────────────────────────────────────────────────
# %config(noreplace) sur l'exemple seulement ; les fichiers d'état (config.toml,
# users, logs) sont créés dans %post et déclarés %ghost pour être suivis sans
# être écrasés ni effacés à la désinstallation.
SPEC="$TOP/SPECS/kubuno-core.spec"
cat > "$SPEC" << SPEC
Name:           kubuno-core
Version:        ${VERSION}
Release:        ${RELEASE}%{?dist}
Summary:        Kubuno Core - plateforme cloud self-hosted

License:        AGPL-3.0-or-later
URL:            https://github.com/kubuno/core
BuildArch:      ${ARCH}

# Dépendances runtime (équivalent du Depends Debian)
Requires:       openssl-libs
Requires:       ca-certificates
Recommends:     postgresql-server >= 16
Requires(post): systemd
Requires(preun): systemd
Requires(postun): systemd

# Chemins source (artefacts pré-compilés) passés depuis build_rpm.sh.
%global _srcdir ${SRCDIR}
%global _serverdir ${SRCDIR}/${SERVER_DIR}
%global _webdir ${SRCDIR}/${WEB_DIR}
%global _themesdir ${SRCDIR}/${THEMES_DIR}
%global _targetdir ${TARGET_ABS}
%global _readme ${README_SRC}

# Binaires Rust déjà strippés/optimisés : pas de re-traitement debuginfo.
%global debug_package %{nil}
%global __os_install_post %{nil}
# Pas de liens /usr/lib/.build-id (évite les conflits entre RPM Kubuno).
%global _build_id_links none

%description
Core haute performance (Rust + Axum) de la plateforme Kubuno.
Alternative souverainiste et open-source à Google Workspace et Microsoft 365,
architecture modulaire (un core + des modules indépendants).

%prep
# Rien : les artefacts sont pré-compilés (binaires Rust + frontend).

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}/usr/bin \
         %{buildroot}/usr/share/kubuno/frontend \
         %{buildroot}/usr/share/kubuno/migrations \
         %{buildroot}/usr/share/kubuno/themes \
         %{buildroot}/usr/share/man/man1 \
         %{buildroot}/usr/share/doc/kubuno-core \
         %{buildroot}/etc/kubuno \
         %{buildroot}/usr/lib/systemd/system
install -m 755 %{_targetdir}/release/kubuno-core %{buildroot}/usr/bin/kubuno-core
install -m 755 %{_targetdir}/release/kubuno       %{buildroot}/usr/bin/kubuno
gzip -c %{_serverdir}/man/kubuno.1 > %{buildroot}/usr/share/man/man1/kubuno.1.gz
cp -r %{_webdir}/dist/. %{buildroot}/usr/share/kubuno/frontend/
cp -r %{_serverdir}/migrations/. %{buildroot}/usr/share/kubuno/migrations/
cp -r %{_themesdir}/. %{buildroot}/usr/share/kubuno/themes/
install -m 644 %{_serverdir}/config.toml.example %{buildroot}/etc/kubuno/config.toml.example
install -m 644 %{_sourcedir}/kubuno.service %{buildroot}/usr/lib/systemd/system/kubuno.service
install -m 644 %{_srcdir}/LICENSE %{buildroot}/usr/share/doc/kubuno-core/LICENSE
install -m 644 %{_readme} %{buildroot}/usr/share/doc/kubuno-core/README.md

%files
%license /usr/share/doc/kubuno-core/LICENSE
%doc /usr/share/doc/kubuno-core/README.md
/usr/bin/kubuno-core
/usr/bin/kubuno
/usr/share/kubuno/frontend
/usr/share/kubuno/migrations
/usr/share/kubuno/themes
/usr/share/man/man1/kubuno.1.gz
/usr/lib/systemd/system/kubuno.service
%config(noreplace) /etc/kubuno/config.toml.example
%ghost %config(noreplace) /etc/kubuno/config.toml

%pre
# Crée le compte de service avant l'installation des fichiers.
getent group kubuno >/dev/null || groupadd --system kubuno
getent passwd kubuno >/dev/null || \
  useradd --system --gid kubuno --no-create-home \
          --home-dir /var/lib/kubuno --shell /sbin/nologin kubuno
exit 0

%post
# Store des modules : c'est là que le core et « kubuno modules:install »
# déballent les .kbpkg. Absent, le premier qui écrit en devient propriétaire -
# root quand l'installation passe par sudo - et le service ne peut plus rien y
# installer ensuite. Le créer ici le donne au compte de service dès le départ.
mkdir -p /var/lib/kubuno/files /var/lib/kubuno/themes /var/lib/kubuno/modules-store
# Destination par défaut des sauvegardes. 0700 : le fichier contient les
# empreintes de mots de passe de tous les comptes de l'instance.
mkdir -p /var/backups/kubuno
chown kubuno:kubuno /var/backups/kubuno
chmod 700 /var/backups/kubuno
# Sème/rafraîchit les thèmes livrés (les thèmes importés par l'admin, d'autres IDs,
# ne sont jamais dans /usr/share et restent intacts).
if [ -d /usr/share/kubuno/themes ]; then
    cp -r /usr/share/kubuno/themes/. /var/lib/kubuno/themes/ 2>/dev/null || true
fi
chown -R kubuno:kubuno /var/lib/kubuno
chmod 750 /var/lib/kubuno /var/lib/kubuno/themes
mkdir -p /var/log/kubuno
chown kubuno:kubuno /var/log/kubuno
chmod 750 /var/log/kubuno
# L'assistant d'installation écrit /etc/kubuno/config.toml par renommage
# atomique (.config.toml.new puis rename), ce qui exige le droit d'écriture sur le
# RÉPERTOIRE et pas seulement sur le fichier. Livré root:root, l'assistant échouait
# à sa dernière étape, APRÈS avoir créé la base. Le bit setgid maintient le groupe
# sur ce que le service y dépose ensuite.
mkdir -p /etc/kubuno
chown root:kubuno /etc/kubuno
chmod 2775 /etc/kubuno
if [ ! -f /etc/kubuno/config.toml ]; then
    cp /etc/kubuno/config.toml.example /etc/kubuno/config.toml
    echo "→ /etc/kubuno/config.toml créé. Renseignez database, auth.jwt_secret et server.internal_secret."
fi
chmod 640 /etc/kubuno/config.toml
chown root:kubuno /etc/kubuno/config.toml
# Scriptlets systemd explicites (équivalents des macros %systemd_*, sans
# dépendre de systemd-rpm-macros sur l'hôte de build).
if [ \$1 -eq 1 ] ; then
    systemctl daemon-reload >/dev/null 2>&1 || :
    systemctl enable --now kubuno.service >/dev/null 2>&1 || :
fi

%preun
if [ \$1 -eq 0 ] ; then
    systemctl --no-reload disable --now kubuno.service >/dev/null 2>&1 || :
fi

%postun
systemctl daemon-reload >/dev/null 2>&1 || :
if [ \$1 -ge 1 ] ; then
    systemctl try-restart kubuno.service >/dev/null 2>&1 || :
fi

%changelog
* Mon Jun 29 2026 Martinien OLINGA <kubuno@toiledev.com> - ${VERSION}-${RELEASE}
- Paquet RPM (parité layout avec le .deb).
SPEC

# ── Construction ────────────────────────────────────────────────────────────
echo "==> rpmbuild…"
rpmbuild \
  --define "_topdir $TOP" \
  -bb "$SPEC"

OUT="$TOP/RPMS/${ARCH}/kubuno-core-${VERSION}-${RELEASE}.${ARCH}.rpm"
# Certaines versions ajoutent .fcXX via %{?dist}; on récupère le fichier produit.
PRODUCED=$(find "$TOP/RPMS" -name 'kubuno-core-*.rpm' | head -1)
[[ -f "$PRODUCED" ]] || { echo "Erreur : RPM non produit." >&2; exit 1; }
FINAL="$DIST_DIR/$(basename "$PRODUCED")"
cp "$PRODUCED" "$FINAL"

echo ""
echo "══════════════════════════════════════════════"
echo "  RPM généré : $FINAL"
echo "══════════════════════════════════════════════"

if [[ "${1:-}" == "--install" ]]; then
  echo "==> Installation locale…"
  if command -v dnf &>/dev/null; then
    sudo dnf install -y "$FINAL"
  elif command -v zypper &>/dev/null; then
    sudo zypper --non-interactive install --allow-unsigned-rpm "$FINAL"
  else
    sudo rpm -Uvh --replacepkgs "$FINAL"
  fi
  echo "  ✓ Installé."
fi
