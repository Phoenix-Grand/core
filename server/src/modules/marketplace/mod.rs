//! Marketplace : catalogue distant + installation de modules à l'exécution.
//!
//! Le catalogue est servi par kubuno.com (`GET /api/v1/modules[/:id]`, User-Agent
//! requis). Les artefacts installables (`.deb`) vivent dans les **Releases GitHub**
//! du dépôt de chaque module (CI officielle). L'installation :
//!   1. résout le dépôt + la version via le catalogue,
//!   2. résout l'asset `.deb` de la release GitHub correspondante,
//!   3. télécharge, extrait (`dpkg-deb -x`) et relocalise dans le **store**
//!      inscriptible par le core (`modules_install_dir`),
//!   4. synchronise la DB et lance le module à chaud (`manager::spawn_module`).
//!
//! Sécurité : réservé aux admins (côté handler), HTTPS uniquement, et restreint aux
//! modules **officiels** hébergés sous `github.com/kubuno/`.
//!
//! Découpage :
//! - [`catalog`]  - client HTTP + modèles du catalogue distant
//! - [`artifact`] - résolution de l'artefact adapté à l'OS/arch (Releases GitHub)
//! - [`extract`]  - extraction de l'archive et repérage du dossier module
//! - [`install`]  - installation récursive (dépendances) et désinstallation
//! - [`progress`] - suivi en mémoire des installations en tâche de fond

mod artifact;
mod catalog;
mod extract;
mod install;
mod manifest;
mod progress;
mod target;

pub use catalog::{fetch_catalog, fetch_detail, validate_id, MarketLinks, MarketModule};
pub use install::{install, install_local, is_store_installed, uninstall, InstallReport};
pub use progress::{begin, finish_progress, get_progress, InstallProgress};
