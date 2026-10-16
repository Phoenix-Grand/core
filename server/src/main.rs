use anyhow::{Context, Result};
use clap::Parser;
use kubuno_core::{
    config::Settings,
    database::{migrations, outbox::start_event_source, pool::create_pool, seed},
    events::EventBus,
    modules::registry::ModuleRegistry,
    router::builder,
    state::AppState,
    websocket::hub::{WsHub, event_to_ws_worker},
};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Serveur HTTP du core Kubuno.
///
/// La configuration est chargée depuis config.toml puis surchargée
/// par les variables d'environnement préfixées KV_ (ex: KV_SERVER_PORT=9000).
/// Un fichier .env est chargé automatiquement s'il est présent.
#[derive(Parser, Debug)]
#[command(
    name    = "kubuno-core",
    version = env!("CARGO_PKG_VERSION"),
    about   = "Serveur core de la plateforme Kubuno",
    long_about = "\
Kubuno Core est le serveur HTTP principal de la plateforme Kubuno.\n\
Il applique les migrations SQL au démarrage, expose les routes REST\n\
et WebSocket, proxifie les requêtes vers les modules actifs et gère\n\
l'authentification JWT.\n\
\n\
Variables d'environnement importantes :\n\
  KV_DATABASE_URL          URL PostgreSQL (ex: postgres://user:pass@host/db)\n\
  KV_AUTH_JWT_SECRET       Secret JWT (min. 32 caractères)\n\
  KV_SERVER_PORT           Port d'écoute (défaut : 8080)\n\
  KV_SERVER_HOST           Adresse d'écoute (défaut : 0.0.0.0)\n\
  KV_STORAGE_BACKEND       Backend de stockage : local | s3\n\
  RUST_LOG                 Niveau de log (ex: debug, info, warn)"
)]
struct Cli {
    /// Fichier de configuration : s'il est donné, c'est le seul lu. Sinon : config.toml du
    /// répertoire courant, puis le fichier système (/etc/kubuno/config.toml…) pour l'instance
    /// système uniquement (service, compte de service ou administrateur).
    #[arg(short, long, value_name = "FICHIER", env = "KV_CONFIG_FILE")]
    config: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Charger .env si présent (développement / Docker) - optionnel
    let _ = dotenvy::dotenv();

    // Parser les arguments - affiche l'aide et quitte proprement sur --help / --version
    let cli = Cli::parse();

    // Read the configuration WITHOUT validating it first: a freshly installed
    // package still carries the example's placeholders, which is exactly what
    // `Settings::load()` refuses to start on - and the state the installation
    // wizard exists to leave behind.
    let raw = Settings::load_unvalidated_from(cli.config.as_deref())
        .context("Lecture de la configuration")?;

    // Initialiser le logging (stdout + fichiers access.log / error.log)
    // Les guards doivent rester en vie jusqu'à la fin du processus.
    let _log_guards = kubuno_core::logging::init(&raw.logging);

    tracing::info!("Kubuno Core v{} démarrage…", env!("CARGO_PKG_VERSION"));
    // Which configuration files were read (paths only, never values), and why
    // the system file was not, when it was not.
    match kubuno_core::config::paths::config_plan(cli.config.as_deref()) {
        Ok(plan) => kubuno_core::config::paths::log_config_plan(&plan),
        Err(e) => tracing::warn!(error = %e, "Configuration sources could not be listed"),
    }

    // Not installed yet: serve the wizard on the normal port until it succeeds,
    // then carry on with the configuration it has just written. Nothing has to
    // be restarted - same behaviour under systemd, Docker and in development.
    if kubuno_core::setup::needs_setup(&raw).await {
        tracing::warn!(
            manquant = ?kubuno_core::setup::missing(&raw),
            "Instance non installée - assistant d'installation"
        );
        if !kubuno_core::setup::run_wizard(&raw).await? {
            tracing::info!("Arrêt avant la fin de l'installation");
            return Ok(());
        }
    }

    let settings = Settings::load_from(cli.config.as_deref())
        .context("Chargement de la configuration")?;

    // Search term cap, before any pool is opened; the module supervisor then
    // hands the value in force to every module it starts.
    if let Some(n) = settings.search.max_terms {
        let kept = kubuno_db::search::set_max_terms(n);
        if kept != n {
            tracing::warn!(requested = n, kept, "search.max_terms hors bornes, valeur ramenée");
        }
    }

    // Mandataires inverses autorisés à définir X-Forwarded-For / X-Real-IP.
    // À installer AVANT le démarrage du serveur : toute résolution d'adresse
    // client (limitation de débit, anti-DDoS, sessions, journal d'accès) en dépend.
    kubuno_core::auth::client_ip::init(&settings.server.trusted_proxy_cidrs);

    // Load the key that protects data at rest - SMTP and directory passwords,
    // OIDC client secrets, TOTP secrets. It lives in its own file so that
    // rotating the token-signing secret, which is a thing an administrator
    // SHOULD be able to do, no longer makes every stored secret and every
    // enrolled second factor unreadable. On an instance that predates the file,
    // it is seeded with the JWT secret in force, so nothing already encrypted
    // has to be touched. Must run before anything decrypts.
    if let Err(e) = kubuno_core::crypto::datakey::init(&settings.auth.jwt_secret) {
        tracing::error!(erreur = %e, "Clé de chiffrement des données illisible");
        return Err(e);
    }
    let platform = kubuno_core::config::paths::current();
    tracing::info!(
        mode = platform.mode.as_str(),
        config = %platform.config_dir.display(),
        state = %platform.state_dir.display(),
        data = %platform.data_dir.display(),
        "Platform directories"
    );
    kubuno_core::config::paths::warn_about_legacy_locations(&settings.server.modules_install_dir);

    // Install the audit hash-chain key (derived from the internal secret, never
    // stored in the database) before any audit row can be written.
    kubuno_core::audit::chain::init_audit_key(&settings.server.internal_secret);

    // Pool PostgreSQL
    let pool = create_pool(&settings.database)
        .await
        .context("Initialisation du pool PostgreSQL")?;

    // Migrations
    if settings.database.run_migrations {
        migrations::run(&pool).await?;
    }

    // Instance identity: PostgreSQL seeds it in a migration, but the random
    // per-install id cannot be a static default in the consolidated MySQL/SQLite
    // schema, so mint it here (idempotent, never re-minted once present).
    seed::ensure_instance_identity(&pool).await;

    // Maintenance banners: sweep any notice left up by an operation that a
    // restart or crash interrupted before it could tear its own banner down.
    // Every `global` notice present here belongs to a process that is no longer
    // running (a core engine switch ends by restarting the service).
    kubuno_core::maintenance::sweep_stale(&pool).await;

    // Réglages anti-DDoS : amorce env puis source de vérité = core.settings
    // (pilotables à chaud depuis le panneau d'administration).
    kubuno_core::auth::ddos::seed_from_env();
    kubuno_core::auth::ddos::set_jwt_secret(&settings.auth.jwt_secret);
    kubuno_core::auth::ddos::reload_from_db(&pool).await;

    // Inventaire des appareils : base de pays hors-ligne (optionnelle, aucun
    // appel sortant) puis rattachement des sessions antérieures à l'inventaire.
    kubuno_core::devices::bootstrap(&pool).await;

    // Référentiel des jours fériés : le jeu de données livré, chargé une fois
    // par version. Jamais bloquant - une instance qui échoue ici sert ce qu'elle
    // a déjà, et toutes les lectures tolèrent un référentiel vide.
    kubuno_core::holidays::seed::ensure_dataset(&pool).await;

    // Seed : compte administrateur initial
    seed::ensure_default_admin(&pool)
        .await
        .context("Création du compte administrateur initial")?;

    // An administrator whose account predates this repair holds the `role`
    // flag but no role assignment, and the console - which reads the assignment
    // - showed them almost nothing. The migration that granted it ran before
    // their account existed, so only a check at start can put it right.
    if let Err(e) = kubuno_core::authz::bootstrap::reconcile_superadmins(&pool).await {
        tracing::error!(error = %e, "Vérification des attributions de super-administration");
    }

    // Infrastructure
    let event_bus = Arc::new(EventBus::new(1024));
    let ws_hub    = Arc::new(WsHub::new());
    let registry  = Arc::new(RwLock::new(ModuleRegistry::new()));

    // Storage backend
    let storage = kubuno_storage::from_config(&settings.storage)
        .await
        .context("Initialisation du backend de stockage")?;

    // Source d'événements inter-modules : PgListener (LISTEN/NOTIFY) sur
    // PostgreSQL, poller d'outbox sur MySQL/SQLite. Le choix se fait au run time
    // selon le moteur du pool ; le reste du core ignore lequel tourne.
    start_event_source(&pool, Arc::clone(&event_bus))
        .await
        .context("Démarrage de la source d'événements")?;

    // Worker EventBus → WebSocket
    tokio::spawn(event_to_ws_worker(Arc::clone(&event_bus), Arc::clone(&ws_hub)));

    // Worker EventBus → notifications push (UnifiedPush / APNs / FCM)
    tokio::spawn(kubuno_core::push::worker::push_worker(
        Arc::clone(&event_bus),
        pool.clone(),
    ));

    // Worker EventBus → modules abonnés. Met en file une livraison par module
    // dont `subscribed_events` nomme le type - la file (core.jobs) porte les
    // réessais, pour qu'un module redémarré reçoive quand même l'événement.
    // Avant lui, `subscribed_events` était stocké, affiché, et lu par personne :
    // les traitements « UserDeleted » des modules ne s'exécutaient jamais.
    tokio::spawn(kubuno_core::events::dispatch::fanout_worker(
        Arc::clone(&event_bus),
        pool.clone(),
    ));

    // Exécuteur de tâches de fond (core.jobs).
    // Un nouveau type de tâche s'ajoute ICI, sans toucher à l'exécuteur :
    //     job_registry.register_fn("mon.type", |ctx, job| async move { … });
    let mut job_registry = kubuno_core::jobs::JobRegistry::new();
    kubuno_core::jobs::builtin::register(&mut job_registry);
    // Courriels sortants (core.send_email) : le secret JWT est capturé car le
    // gestionnaire doit déchiffrer le mot de passe SMTP stocké.
    kubuno_core::mailer::register_jobs(&mut job_registry, &settings.auth.jwt_secret);
    // Centre d'alertes (core.alerts.scan) : les producteurs ont besoin de la
    // configuration (évaluation de santé, volume de données), que le contexte
    // de tâche ne transporte pas - d'où la capture.
    kubuno_core::alerts::jobs::register(&mut job_registry, Arc::new(settings.clone()));
    // Moteur de règles (core.rules.action / .backtest / .maintenance) : les
    // réglages serveur sont capturés car exécuter l'action d'un MODULE est un
    // appel interne portant le secret dérivé DE CE MODULE, et le contexte de
    // tâche ne transporte qu'un pool.
    kubuno_core::rules::jobs::register(
        &mut job_registry,
        Arc::new(settings.server.clone()),
    );
    // Sauvegarde planifiée du schéma core (core.backup.run / .run_now). Écrite
    // en Rust depuis le pool : kubuno-seccomp interdit execve, donc pg_dump
    // n'est pas lançable depuis le serveur - cf. crate::backup.
    kubuno_core::backup::jobs::register(&mut job_registry);
    // Livraison des événements aux modules (core.events.deliver). Les réglages
    // serveur sont capturés : l'appel porte le secret interne DU MODULE VISÉ,
    // dérivé par module, et le contexte de tâche ne transporte qu'un pool.
    kubuno_core::events::dispatch::register(
        &mut job_registry,
        Arc::new(settings.server.clone()),
    );
    // Import périodique des annuaires LDAP / Active Directory
    // (core.directory_sync). Le secret JWT est capturé : le gestionnaire doit
    // déchiffrer le mot de passe du compte de service, et un contexte de tâche
    // ne transporte qu'un pool.
    kubuno_core::directory::job::register(&mut job_registry, settings.auth.jwt_secret.clone());
    // Migration de données (core.data_migration.step) : deux captures, car un
    // contexte de tâche ne transporte qu'un pool. Les réglages serveur, parce
    // que faire travailler un module est un appel interne portant le secret
    // dérivé DE CE MODULE ; le secret JWT, parce que les identifiants du serveur
    // source sont scellés au repos et doivent être ouverts pour être transmis.
    kubuno_core::data_migration::jobs::register(
        &mut job_registry,
        Arc::new(settings.server.clone()),
        Arc::new(settings.auth.jwt_secret.clone()),
    );
    // Export de données (core.data_export.run / .prune) : les réglages serveur
    // sont capturés, car demander à un module les données d'un compte est un
    // appel interne portant le secret dérivé DE CE MODULE, et un contexte de
    // tâche ne transporte qu'un pool. Cf. crate::data_export::contract.
    kubuno_core::data_export::jobs::register(&mut job_registry, Arc::new(settings.server.clone()));
    let job_cfg = kubuno_core::jobs::JobRunnerConfig::from_db(&pool).await;
    let jobs = kubuno_core::jobs::runner::start(
        pool.clone(),
        Arc::new(job_registry),
        job_cfg,
    )
    .await;
    // Tâches récurrentes du core (purges du journal d'événements et du journal
    // d'audit administratif) - idempotent, ne double pas au redémarrage.
    kubuno_core::jobs::builtin::schedule(&pool).await;
    // Analyse périodique du centre d'alertes - même discipline : idempotent,
    // ré-armé par son propre gestionnaire après chaque passage réussi.
    kubuno_core::alerts::jobs::schedule(&pool).await;
    // Un cycle par annuaire dont la synchronisation périodique est armée.
    kubuno_core::directory::job::schedule_all(&pool).await;
    // Entretien du moteur de règles (purge du journal d'exécution et des
    // compteurs de seuil) - même discipline idempotente.
    kubuno_core::rules::jobs::schedule(&pool).await;
    // Sauvegarde automatique - même discipline : idempotente, ré-armée par son
    // propre gestionnaire, et planifiée à l'heure de la politique (jamais à
    // l'instant du démarrage : un redéploiement ne doit pas déclencher un dump).
    kubuno_core::backup::jobs::schedule(&pool).await;
    // Une campagne de migration laissée « en cours » par un redémarrage reprend
    // d'elle-même. Rien n'est mis en file s'il n'y a rien à migrer : cette
    // chaîne ne tourne que tant qu'il reste du travail.
    kubuno_core::data_migration::jobs::resume(&pool).await;
    // Purge horaire des archives d'export dont la rétention est écoulée. Même
    // discipline idempotente : l'entrée d'historique survit toujours au fichier.
    kubuno_core::data_export::jobs::schedule(&pool).await;

    // Moteur de règles d'administration : déclare le catalogue du core, construit
    // l'index en mémoire, écoute les changements et s'abonne au bus. Démarré
    // APRÈS le PgListener (l'index se recharge par NOTIFY) et après l'exécuteur
    // de tâches (les actions y sont mises en file).
    kubuno_core::rules::start(pool.clone(), Arc::clone(&event_bus)).await;

    // Recompactage GC unique des snapshots collab (résorbe le bloat hérité de
    // l'ancienne concaténation sans GC). En arrière-plan : ne retarde pas le boot.
    tokio::spawn(kubuno_core::collab::recompact_all(pool.clone()));

    // Lancer et superviser les modules installés
    // start_all scanne modules_dir, synce la DB (core.modules), puis démarre
    // uniquement les modules où is_enabled = TRUE.
    let modules_dir = std::path::PathBuf::from(&settings.server.modules_dir);
    kubuno_core::modules::manager::start_all(
        Arc::new(settings.clone()),
        &modules_dir,
        pool.clone(),
    ).await;

    let remote_mounts = Arc::new(
        kubuno_core::storage::remote::RemoteMountService::new(
            pool.clone(), &settings.server.internal_secret,
        )
    );

    // Fréquentation des applications : compteur en mémoire alimenté par le proxy,
    // consolidé en base une fois par minute. Démarré ici pour que le compteur
    // existe avant la première requête proxifiée.
    let usage = Arc::new(kubuno_core::modules::usage::UsageMeter::new());
    tokio::spawn(kubuno_core::modules::usage::flusher(
        pool.clone(),
        Arc::clone(&usage),
    ));

    // Live TLS state - shared with the response layer (HSTS) and the admin
    // handlers (hot certificate reload). Populated below once the serving mode
    // is decided.
    let tls_runtime = Arc::new(kubuno_core::network::TlsRuntime::new());

    let state = AppState {
        db:       pool,
        settings: Arc::new(settings.clone()),
        events:   event_bus,
        modules:  registry,
        storage,
        ws_hub,
        remote_mounts,
        usage,
        tls:      Arc::clone(&tls_runtime),
    };

    // Automatic ACME certificate renewal (no-op unless cert_mode = acme).
    tokio::spawn(kubuno_core::network::acme::renewal_worker(state.clone()));

    kubuno_core::handlers::health::init_start_time();

    let frontend_dist = settings.server.frontend_dist.clone();
    // The DB handle is needed after `state` is moved into the router, to resolve
    // the console-managed network configuration.
    let db = state.db.clone();
    let app = builder::build(state, frontend_dist);

    let http_addr: std::net::SocketAddr = format!("{}:{}", settings.server.host, settings.server.port)
        .parse()
        .with_context(|| format!("Adresse d'écoute invalide : {}:{}", settings.server.host, settings.server.port))?;

    // HSTS is seeded for EVERY serving mode, not just the ones that terminate
    // TLS here: an instance behind a TLS-terminating reverse proxy serves plain
    // HTTP at this socket and must still send the header (the response layer
    // decides per request - see `network::runtime::response_is_over_tls`).
    set_hsts_from_db(&db, &tls_runtime).await;

    let secure_cookies = settings.server.secure_cookies;
    let warn_insecure_cookies = |reason: &str| {
        if !secure_cookies {
            tracing::warn!(
                "{reason} mais server.secure_cookies = false - activez secure_cookies \
                 pour que les cookies (refresh token) soient marqués Secure."
            );
        }
    };

    // ── Which sockets to open ────────────────────────────────────────────────
    //
    // Like any ordinary web server, the core listens on HTTP **and** HTTPS at the
    // same time when both are configured (Apache's `Listen 80` + `Listen 443`).
    // Enabling HTTPS therefore never takes the HTTP port away - which would cut
    // off a reverse proxy, a health probe or a module talking to the loopback
    // port. What the HTTP socket *serves* is the choice: the application, or a
    // redirect to HTTPS.
    let file_tls = &settings.server.tls;
    let net = kubuno_core::network::NetworkConfig::load(&db).await;

    // The TLS listener, if any, and the port it answers on.
    let mut https: Option<(axum_server::tls_rustls::RustlsConfig, u16)> = None;
    if file_tls.enabled {
        // Legacy path: TLS pinned in config.toml. An explicit operator file
        // override wins over the console, which reports itself as read-only.
        // Historically this served HTTPS on `server.port`, and that is kept.
        kubuno_core::network::runtime::install_crypto_provider();
        let cfg = axum_server::tls_rustls::RustlsConfig::from_pem_file(
            &file_tls.cert_path,
            &file_tls.key_path,
        )
        .await
        .with_context(|| {
            format!(
                "Chargement du certificat/clé TLS ({} / {})",
                file_tls.cert_path, file_tls.key_path
            )
        })?;
        tls_runtime.set_reload(cfg.clone());
        warn_insecure_cookies("server.tls.enabled = true");
        https = Some((cfg, http_addr.port()));
    } else if net.https_enabled {
        match kubuno_core::network::cert::active_material(
            &kubuno_core::network::store::Paths::from_settings(&settings.server.tls),
        ) {
            Some((cert_pem, key_pem)) => {
                match kubuno_core::network::runtime::build_server_config(
                    cert_pem.as_bytes(),
                    key_pem.as_bytes(),
                    net.tls_min_version,
                ) {
                    Ok(server_config) => {
                        let cfg =
                            axum_server::tls_rustls::RustlsConfig::from_config(server_config);
                        tls_runtime.set_reload(cfg.clone());
                        warn_insecure_cookies("network.https_enabled = true");
                        https = Some((cfg, net.https_port));
                    }
                    Err(e) => tracing::error!(
                        error = %e,
                        "réseau : certificat actif inexploitable - HTTPS non démarré. \
                         Ré-importez un certificat depuis la console."
                    ),
                }
            }
            None => tracing::warn!(
                "network.https_enabled = true mais aucun certificat actif - HTTPS non démarré. \
                 Importez un certificat depuis la console puis redémarrez le service."
            ),
        }
    }

    let https_port: Option<u16> = https.as_ref().map(|(_, p)| *p);

    // Redirect only makes sense once something answers in HTTPS.
    let redirect_to_https = https_port.is_some()
        && (if file_tls.enabled {
            file_tls.redirect_http_from_port > 0
        } else {
            net.http_redirect_to_https
        });

    // Plain-HTTP ports. `server.port` always - the main listener, whose failure
    // to bind is fatal. In the legacy file mode `server.port` carries the TLS
    // listener instead, so only the extra port is plain HTTP.
    let mut http_ports: Vec<u16> = Vec::new();
    if !file_tls.enabled {
        http_ports.push(http_addr.port());
    }
    // The EXTRA port (typically 80) exists only to receive the redirect. It is
    // added only when redirection is actually on: `network.http_redirect_port`
    // defaults to 80, and binding it unconditionally would make every instance
    // fail to start without CAP_NET_BIND_SERVICE.
    let extra_http_port = if redirect_to_https {
        if file_tls.enabled {
            file_tls.redirect_http_from_port
        } else {
            net.http_redirect_port
        }
    } else {
        0
    };
    let extra_http_port = if extra_http_port > 0
        && !http_ports.contains(&extra_http_port)
        // Never collide with the TLS socket.
        && https_port != Some(extra_http_port)
    {
        Some(extra_http_port)
    } else {
        None
    };

    // Hosts this instance legitimately answers for - the active certificate's
    // subject alternative names, plus the domains ACME is configured for. Used
    // to keep the HTTP→HTTPS redirect from being pointed at somebody else's
    // domain by a forged `Host` header (see `network::redirect`).
    let canonical_hosts: Vec<String> = {
        let mut hosts: Vec<String> = kubuno_core::network::cert::active(&db)
            .await
            .ok()
            .flatten()
            .map(|c| c.san)
            .unwrap_or_default();
        for d in kubuno_core::network::acme::AcmeConfig::load(&db).await.domains {
            if !hosts.contains(&d) {
                hosts.push(d);
            }
        }
        hosts
    };

    // ── Bind every socket BEFORE serving ─────────────────────────────────────
    // A port that is taken (or privileged, e.g. 80/443 without
    // CAP_NET_BIND_SERVICE) must fail at startup with a clear message rather
    // than inside a detached task nobody reads.
    let mut set: tokio::task::JoinSet<Result<()>> = tokio::task::JoinSet::new();

    if let Some((tls_config, port)) = https {
        let addr = std::net::SocketAddr::new(http_addr.ip(), port);
        let listener = std::net::TcpListener::bind(addr)
            .with_context(|| format!("Bind HTTPS sur {addr}"))?;
        listener
            .set_nonblocking(true)
            .context("Socket HTTPS en mode non bloquant")?;
        let app = app.clone();
        set.spawn(async move { serve_https(addr, listener, tls_config, app).await });
    }

    let redirect_target_port = https_port.unwrap_or(443);
    // The router served on a plain-HTTP socket: the application, or the redirect
    // to HTTPS. The redirect must NOT swallow the ACME challenge - proving domain
    // control happens over plain HTTP, and answering a renewal check with a 308
    // to the very certificate being renewed is how automatic renewal quietly
    // stops working (see `network::redirect`).
    let http_router = || {
        if redirect_to_https {
            kubuno_core::network::redirect::wrap(
                app.clone(),
                redirect_target_port,
                canonical_hosts.clone(),
            )
        } else {
            app.clone()
        }
    };

    for port in http_ports {
        let addr = std::net::SocketAddr::new(http_addr.ip(), port);
        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .with_context(|| format!("Bind HTTP sur {addr}"))?;
        let router = http_router();
        set.spawn(async move { serve_http(addr, listener, router).await });
    }

    // The extra port is a convenience, never a condition of starting: 80 without
    // CAP_NET_BIND_SERVICE, or a port another service already holds, must cost a
    // loud log line - not the instance.
    if let Some(port) = extra_http_port {
        let addr = std::net::SocketAddr::new(http_addr.ip(), port);
        match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => {
                let router = http_router();
                set.spawn(async move { serve_http(addr, listener, router).await });
            }
            Err(e) => tracing::error!(
                error = %e,
                "réseau : port de redirection {addr} non disponible - la redirection HTTP→HTTPS \
                 n'y répondra pas (un port < 1024 exige la capacité CAP_NET_BIND_SERVICE). \
                 Le reste du service démarre normalement."
            ),
        }
    }

    // Every listener stops on the same signal; the first error is reported.
    let mut serve_result: Result<()> = Ok(());
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(())) => {}
            Ok(Err(e)) => serve_result = Err(e),
            Err(e) => serve_result = Err(anyhow::anyhow!("Tâche de service interrompue : {e}")),
        }
    }

    // L'exécuteur de tâches s'arrête APRÈS le serveur : il cesse de réclamer de
    // nouvelles tâches puis laisse celles en cours se terminer. Une tâche coupée
    // en deux serait rejouée depuis le début au démarrage suivant - tous les
    // gestionnaires ne sont pas idempotents.
    jobs.shutdown(std::time::Duration::from_secs(30)).await;

    serve_result?;
    Ok(())
}

/// Attend SIGTERM (systemctl stop/restart) ou Ctrl-C (exécution manuelle).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(e) => {
                tracing::error!(error = %e, "Écoute de SIGTERM impossible");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c    => {}
        _ = terminate => {}
    }
}

/// Sert l'application en HTTPS (TLS natif via rustls) avec arrêt en douceur, sur
/// une socket déjà liée (le bind a lieu au démarrage pour qu'un port occupé
/// échoue tout de suite, avec un message).
async fn serve_https(
    addr: std::net::SocketAddr,
    listener: std::net::TcpListener,
    config: axum_server::tls_rustls::RustlsConfig,
    app: axum::Router,
) -> Result<()> {
    // Arrêt en douceur : axum-server pilote la fin de service via un Handle.
    let handle = axum_server::Handle::new();
    {
        let handle = handle.clone();
        tokio::spawn(async move {
            shutdown_signal().await;
            tracing::info!("Signal d'arrêt reçu - fin de service HTTPS en douceur");
            handle.graceful_shutdown(Some(std::time::Duration::from_secs(15)));
        });
    }

    tracing::info!("Serveur démarré sur https://{addr} (TLS natif)");
    axum_server::from_tcp_rustls(listener, config)
        .handle(handle)
        .serve(app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .await
        .context("Erreur du serveur HTTPS")
}

/// Sert un routeur en HTTP nu (application ou redirecteur) avec arrêt en
/// douceur, sur une socket déjà liée.
async fn serve_http(
    addr: std::net::SocketAddr,
    listener: tokio::net::TcpListener,
    app: axum::Router,
) -> Result<()> {
    tracing::info!("Serveur démarré sur http://{addr}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        shutdown_signal().await;
        tracing::info!("Signal d'arrêt reçu - fin de service HTTP en douceur");
    })
    .await
    .context("Erreur du serveur HTTP")
}

/// Seeds the HSTS header holder from the instance's `network.*` settings, for a
/// server that is about to serve over HTTPS.
async fn set_hsts_from_db(
    db: &kubuno_db::DbPool,
    tls_runtime: &std::sync::Arc<kubuno_core::network::TlsRuntime>,
) {
    let net = kubuno_core::network::NetworkConfig::load(db).await;
    let hv = net
        .hsts
        .header_value()
        .and_then(|s| axum::http::HeaderValue::from_str(&s).ok());
    tls_runtime.set_hsts(hv);
}

