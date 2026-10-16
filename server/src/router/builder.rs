use crate::auth::ddos::{concurrency_limit, global_rate_limit};
use crate::auth::rate_limit::rate_limit_auth;
use crate::logging::apache_log_middleware;
use crate::{
    handlers::{
        admin::{
            groups::{
                list_groups, get_group, create_group, update_group, delete_group,
                add_member, remove_member,
            },
            oauth_providers::{
                create_oauth_provider, delete_oauth_provider, list_oauth_providers,
                update_oauth_provider,
            },
            org_units::{
                create_org_unit, delete_org_unit, list_org_units, org_unit_impact,
                update_org_unit,
            },
            settings::{
                get_admin_module, get_settings, list_admin_modules, list_event_log, public_config,
                toggle_module, update_settings,
            },
            users::{
                admin_stats, bulk_delete_users, bulk_require_password_change, bulk_set_active,
                bulk_set_org_unit, create_user,
                delete_user, export_users, get_user,
                list_users, update_user, list_user_sessions, revoke_user_session,
                revoke_all_user_sessions,
            },
        },
        auth::{
            forgot_password, list_public_oauth_providers, login, logout, oauth_callback,
            oauth_redirect, refresh, register, reset_password, totp_verify,
        },
        health::{health, ready},
        themes::{
            create_theme, delete_theme, import_theme_zip, list_themes, serve_theme_asset,
            set_theme_trust,
        },
        modules::{
            get_module_config, internal_module_settings, internal_module_settings_by_id,
            list_modules, module_heartbeat, module_log, publish_event, register_module,
            serve_module_asset, unregister_module,
        },
        users::{
            change_password, get_me, me_activity, list_sessions, revoke_all_sessions, revoke_session,
            update_me, search_users, lookup_users, upload_avatar, get_avatar, get_avatar_original, linked_account_login,
            setup_totp, enable_totp, disable_totp,
        },
        api_tokens::{list as list_api_tokens, create as create_api_token, revoke as revoke_api_token,
                     available_scopes as api_token_scopes},
        labels::{
            list as list_labels, create as create_label, update as update_label,
            delete as delete_label, labels_for_resource, set_resource_labels,
            browse as browse_labels, list_links as list_label_links, remove_link as remove_label_link,
            list_shares as list_label_shares, set_shares as set_label_shares,
            share_targets as label_share_targets,
        },
        ws::ws_handler,
    },
    modules::proxy::{is_websocket_upgrade, proxy_to_module, proxy_ws_to_module},
    state::AppState,
};
use axum::{
    Router,
    body::Body,
    extract::DefaultBodyLimit,
    http::{HeaderName, HeaderValue, Method, Request, StatusCode, Uri,
        header::{AUTHORIZATION, CONTENT_TYPE},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post, put},
};
use std::time::Duration;
use tower_http::{
    compression::CompressionLayer,
    cors::{AllowOrigin, CorsLayer},
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

pub fn build(state: AppState, frontend_dist: String) -> Router {
    // HSTS comes from live state rather than a constant: its value follows the
    // `network.*` settings (see `crate::network`), and it is emitted only on
    // requests that actually arrived over TLS - whether this process terminated
    // it or a trusted reverse proxy did.
    let hsts_holder = state.tls.clone();

    // Auth routes with rate limiting (10 req/min for login/register, 3/min for password reset)
    let auth_routes = Router::new()
        .route("/register",                  post(register))
        .route("/login",                     post(login))
        .route("/refresh",                   post(refresh))
        .route("/logout",                    post(logout))
        .route("/forgot-password",           post(forgot_password))
        .route("/reset-password",            post(reset_password))
        .route("/oauth/:provider",          get(oauth_redirect))
        .route("/oauth/:provider/callback", get(oauth_callback))
        .route("/providers",                get(list_public_oauth_providers))
        // Ce que la page de connexion doit afficher. Propriété de la
        // CONFIGURATION seule : ne prend aucun identifiant, ne lit aucun compte,
        // donc ne peut pas servir à sonder l'existence d'un compte.
        .route("/methods",                  get(crate::handlers::auth::public_auth_methods))
        // A fresh CAPTCHA challenge for the sign-in form, once repeated failures
        // have armed the gate. Takes no login and reads no account - like
        // /methods, it cannot be used to probe whether an account exists.
        .route("/captcha",                  get(crate::handlers::auth::captcha_challenge))
        .route("/totp",                     post(totp_verify))
        // Multi-compte façon Google : énumération des comptes de CE navigateur
        // (lit uniquement les cookies de l'appelant) et bascule du compte actif.
        .route("/accounts",                 get(crate::handlers::auth::list_accounts))
        .route("/switch",                   post(crate::handlers::auth::switch_account))
        // Réauthentification avant action sensible (le porteur est déjà
        // authentifié ; le limiteur de débit s'applique quand même).
        .route("/reauth",                   post(crate::handlers::auth::reauth))
        .route("/reauth/challenge",          get(crate::handlers::auth::reauth_challenge))
        .layer(middleware::from_fn(rate_limit_auth))
        // Signed download / stream tickets. Added AFTER the layer on purpose:
        // the sign-in limiter (10/min) would starve a page of thumbnails, and
        // this route needs a valid session bearer anyway (global limits apply).
        .route("/tickets",                   post(crate::handlers::auth::issue_tickets));

    // ── Administration ───────────────────────────────────────────────────────
    // Every administrative route lives in ONE sub-router carrying ONE layer
    // guard. Before this, the 38 `/admin` routes were declared flat and each
    // relied on its handler taking an `AdminUser` extractor: a signature written
    // tomorrow that forgets it compiles and serves. The layer makes "at least an
    // administrator" structural; the extractors stay, and narrow it to the
    // privilege each operation actually needs (defence in depth, see
    // `crate::authz::guard`).
    //
    // Paths here are declared WITHOUT the `/admin` prefix - `.nest("/admin", …)`
    // below supplies it. Re-adding it inside would serve `/api/v1/admin/admin/…`
    // and nothing else, which is the single most likely way to get this wrong.
    let admin_routes = Router::new()
        // ── Thèmes ────────────────────────────────────────────────
        .route("/themes",            post(create_theme))
        .route("/themes/import",     post(import_theme_zip))
        .route("/themes/:id",       delete(delete_theme))
        .route("/themes/:id/trust",  patch(set_theme_trust))
        // ── Comptes ───────────────────────────────────────────────
        .route("/users",          get(list_users).post(create_user))
        // Déplacement groupé vers une unité : une transaction, une entrée
        // d'audit récapitulative - pas N appels PATCH (cf. handlers::admin::users).
        // Segment statique déclaré avant `/users/:id/…` par convention de lecture.
        .route("/users/bulk/org-unit", post(bulk_set_org_unit))
        // Même forme que le déplacement groupé : une transaction, une entrée
        // d'audit récapitulative. `bulk/delete` est la suppression DOUCE ;
        // la purge reste unitaire et exige que l'adresse soit retapée.
        .route("/users/bulk/active", post(bulk_set_active))
        .route("/users/bulk/delete", post(bulk_delete_users))
        // La forme groupée de la « réinitialisation » : on arme le changement
        // imposé, on ne fabrique pas N mots de passe (cf. le handler).
        .route("/users/bulk/require-password-change", post(bulk_require_password_change))
        // L'export prend les MÊMES paramètres que le listing : le fichier doit
        // être la liste que l'opérateur regarde. Statique avant `/users/:id`.
        .route("/users/export",  get(export_users))
        .route("/users/:id",     get(get_user).patch(update_user).delete(delete_user))
        // Permanent erasure. A separate route from the DELETE above, which only
        // deactivates: the two are different acts, and a flag on one endpoint
        // would put them one click apart.
        .route("/users/:id/purge", delete(crate::handlers::admin::users::purge_user))
        .route("/users/:id/sessions",      get(list_user_sessions).delete(revoke_all_user_sessions))
        .route("/users/:id/sessions/:sid", delete(revoke_user_session))
        // Réinitialisation du mot de passe d'un compte par un administrateur :
        // révoque aussi toutes ses sessions (cf. handlers::admin::password_reset).
        .route("/users/:id/reset-password",
               post(crate::handlers::admin::password_reset::reset_user_password))
        // « Ce mot de passe est suspect » - distinct de « ce mot de passe est
        // remplacé ». Arme (ou lève) le changement imposé sans toucher au
        // mot de passe : mêmes gardes que la réinitialisation, même audit.
        .route("/users/:id/require-password-change",
               post(crate::handlers::admin::password_reset::require_password_change))
        // Privilèges effectifs d'un compte (direct + via groupes, portées résolues).
        .route("/users/:id/privileges",
               get(crate::handlers::admin::roles::user_effective_privileges))
        // ── Relais de courriel sortant ────────────────────────────
        .route("/mail/settings", get(crate::handlers::admin::mail::get_mail_settings)
                               .patch(crate::handlers::admin::mail::update_mail_settings))
        .route("/mail/test",    post(crate::handlers::admin::mail::test_mail))
        // HTTP/HTTPS termination: the toggles are ordinary `network.*` settings
        // (edited via /settings/scoped/:key); this pair owns the certificate
        // material and the live serving status.
        .route("/network",             get(crate::handlers::admin::network::get_network))
        .route("/network/certificate", post(crate::handlers::admin::network::upload_certificate))
        .route("/network/certificate/:id",
               delete(crate::handlers::admin::network::delete_certificate))
        .route("/network/acme/request", post(crate::handlers::admin::network::request_acme))
        .route("/stats",          get(admin_stats))
        // ── Tableau de bord ───────────────────────────────────────────
        // Les mêmes faits que /stats, mais sur une FENÊTRE choisie et
        // comparés à la fenêtre de même longueur juste avant. /stats reste
        // l'instantané que consomment la page d'accueil et l'abonnement.
        .route("/dashboard",      get(crate::handlers::admin::dashboard::dashboard))
        // ── Stockage ──────────────────────────────────────────────────
        // Les agrégats d'instance et la liste des comptes qui consomment le
        // plus. Aucune route d'écriture : le quota d'un compte passe par
        // PATCH /admin/users/:id, la politique par défaut par
        // PUT/DELETE /admin/settings/scoped/:key - les deux déjà audités.
        .route("/storage/overview",  get(crate::handlers::admin::storage::overview))
        .route("/storage/consumers", get(crate::handlers::admin::storage::consumers))
        // One account's sheet: modules, categories, volumes and object counts -
        // and deliberately nothing that would say *what* the person stores.
        .route("/storage/accounts/:id/usage", get(crate::handlers::admin::storage::account_usage))
        // ── Sauvegarde planifiée ──────────────────────────────────────
        // La politique elle-même s'écrit par /admin/settings/scoped/:key
        // (déjà audité). Ici : la lecture, le déclenchement manuel et la
        // déclaration de restauration testée. Segments statiques d'abord.
        .route("/backup",              get(crate::handlers::admin::backup::get_backup))
        .route("/backup/files",        get(crate::handlers::admin::backup::list_files))
        .route("/backup/run",         post(crate::handlers::admin::backup::run_now))
        .route("/backup/restore",     post(crate::handlers::admin::backup::restore_now))
        .route("/backup/restore-test",
               post(crate::handlers::admin::backup::declare_restore_test))
        // ── Santé de l'instance ───────────────────────────────────────
        // Le segment statique précède `/:id`, comme pour /audit.
        .route("/health-checks",  get(crate::handlers::admin::health::get_health_checks))
        .route("/health-checks/:id/ignore",
               post(crate::handlers::admin::health::mute_check)
             .delete(crate::handlers::admin::health::unmute_check))
        .route("/settings",       get(get_settings).patch(update_settings))
        // ── Réglages par portée (héritage par unité organisationnelle) ──
        // Les segments statiques précèdent la clé, qui contient des points mais
        // jamais de barre oblique.
        .route("/settings/resolved",
               get(crate::handlers::admin::setting_scopes::resolved_settings))
        .route("/settings/chain/:key",
               get(crate::handlers::admin::setting_scopes::setting_chain))
        .route("/settings/scoped/:key",
               put(crate::handlers::admin::setting_scopes::set_scoped_value)
            .delete(crate::handlers::admin::setting_scopes::clear_scoped_value))
        .route("/settings/lock/:key",
               post(crate::handlers::admin::setting_scopes::set_scoped_lock))
        .route("/oauth-providers",      get(list_oauth_providers).post(create_oauth_provider))
        .route("/oauth-providers/:id", patch(update_oauth_provider).delete(delete_oauth_provider))
        .route("/oauth-providers/:id/test",
               post(crate::handlers::admin::oauth_providers::test_oauth_provider))
        // ── Annuaires LDAP / Active Directory ─────────────────────────
        // Mêmes privilèges que les fournisseurs SSO (core.auth_providers.*) :
        // un annuaire est un fournisseur d'authentification. Les deux sondes
        // sont synchrones - c'est ce qui rend une configuration diagnosticable.
        .route("/ldap/directories",
               get(crate::handlers::admin::ldap::list_directories)
              .post(crate::handlers::admin::ldap::create_directory))
        .route("/ldap/directories/:id",
               patch(crate::handlers::admin::ldap::update_directory)
             .delete(crate::handlers::admin::ldap::delete_directory))
        .route("/ldap/directories/:id/test",
               post(crate::handlers::admin::ldap::test_directory))
        .route("/ldap/directories/:id/test-auth",
               post(crate::handlers::admin::ldap::test_directory_auth))
        .route("/ldap/directories/:id/sync",
               post(crate::handlers::admin::ldap::sync_directory))
        .route("/ldap/directories/:id/govern",
               post(crate::handlers::admin::ldap::govern_accounts))
        .route("/modules",        get(list_admin_modules))
        .route("/modules/:id",   get(get_admin_module).patch(toggle_module))
        // Per-module database override (superadmin only): read/write the engine
        // and credentials a module runs on, test the connection, revert to the
        // inherited database.
        .route("/modules/:id/database",
               get(crate::handlers::admin::module_databases::get_module_database)
              .put(crate::handlers::admin::module_databases::put_module_database)
           .delete(crate::handlers::admin::module_databases::delete_module_database))
        .route("/modules/:id/database/test",
               post(crate::handlers::admin::module_databases::test_module_database))
        // ── Base de données principale (superadmin) : préfixe de schéma à chaud
        //    et bascule d'un SGBD vers un autre avec copie des données ────────
        .route("/database/schema-prefix",
               get(crate::handlers::admin::schema_prefix::get_schema_prefix)
              .put(crate::handlers::admin::schema_prefix::put_schema_prefix))
        .route("/database/migrate",
               post(crate::handlers::admin::db_switch::migrate_core_database))
        .route("/database/migration-jobs",
               get(crate::handlers::admin::db_switch::list_jobs))
        .route("/database/migration-jobs/:id",
               get(crate::handlers::admin::db_switch::get_job))
        .route("/modules/:id/database/migrate",
               post(crate::handlers::admin::db_switch::migrate_module_database))
        // ── Registre des connexions de base de données (superadmin) : préserve
        //    l'accès aux bases précédentes après une bascule, permet d'y revenir
        //    (données existantes / en écrasant), de rafraîchir un secours et
        //    d'oublier une connexion. Pour la base principale ET par module. ──────
        .route("/database/connections",
               get(crate::handlers::admin::db_connections::list_core_connections)
              .post(crate::handlers::admin::db_connections::register_core_connection))
        .route("/database/connections/:cid/switch",
               post(crate::handlers::admin::db_connections::switch_core_connection))
        .route("/database/connections/:cid/sync",
               post(crate::handlers::admin::db_connections::sync_core_connection))
        .route("/database/connections/:cid",
               delete(crate::handlers::admin::db_connections::forget_core_connection))
        .route("/modules/:id/database/connections",
               get(crate::handlers::admin::db_connections::list_module_connections))
        .route("/modules/:id/database/connections/:cid/switch",
               post(crate::handlers::admin::db_connections::switch_module_connection))
        .route("/modules/:id/database/connections/:cid/sync",
               post(crate::handlers::admin::db_connections::sync_module_connection))
        .route("/modules/:id/database/connections/:cid",
               delete(crate::handlers::admin::db_connections::forget_module_connection))
        // ── Marketplace (catalogue distant + installation) ────────
        .route("/marketplace",            get(crate::handlers::admin::marketplace::list_marketplace))
        .route("/marketplace/:id/install", post(crate::handlers::admin::marketplace::install_marketplace))
        .route("/marketplace/:id/status",  get(crate::handlers::admin::marketplace::install_status))
        .route("/marketplace/:id",         delete(crate::handlers::admin::marketplace::uninstall_marketplace))
        .route("/event-log",      get(list_event_log))
        // ── Journal d'audit d'administration ──────────────────────
        // Les segments statiques sont déclarés avant `/:id` : matchit les fait
        // primer sur le paramètre, donc `export` n'est jamais lu comme un id.
        .route("/audit",           get(crate::handlers::admin::audit::list_audit))
        .route("/audit/export",    get(crate::handlers::admin::audit::export_audit_csv))
        .route("/audit/facets",    get(crate::handlers::admin::audit::audit_facets))
        .route("/audit/retention", get(crate::handlers::admin::audit::audit_retention))
        .route("/audit/verify",    get(crate::handlers::admin::audit::verify_audit))
        .route("/audit/:id",       get(crate::handlers::admin::audit::get_audit_entry))
        // ── Centre d'alertes ──────────────────────────────────────
        // Mêmes précautions d'ordre que pour /audit : les segments statiques
        // (`summary`, `facets`, `bulk`, `scan`, `views`) précèdent `/:id`, sinon
        // matchit les lirait comme des identifiants d'alerte.
        .route("/alerts",          get(crate::handlers::admin::alerts::list_alerts))
        .route("/alerts/summary",  get(crate::handlers::admin::alerts::alerts_summary))
        .route("/alerts/facets",   get(crate::handlers::admin::alerts::alerts_facets))
        .route("/alerts/bulk",    post(crate::handlers::admin::alerts::bulk_alerts))
        .route("/alerts/scan",    post(crate::handlers::admin::alerts::scan_now))
        .route("/alerts/views",    get(crate::handlers::admin::alerts::list_alert_views)
                                  .post(crate::handlers::admin::alerts::save_alert_view))
        .route("/alerts/views/:id", delete(crate::handlers::admin::alerts::delete_alert_view))
        .route("/alerts/:id",      get(crate::handlers::admin::alerts::get_alert))
        .route("/alerts/:id/status",  post(crate::handlers::admin::alerts::set_alert_status))
        .route("/alerts/:id/assign",  post(crate::handlers::admin::alerts::assign_alert))
        .route("/alerts/:id/comment", post(crate::handlers::admin::alerts::comment_alert))
        .route("/alerts/:id/retry-jobs",   post(crate::handlers::admin::alerts::retry_dead_jobs))
        .route("/alerts/:id/discard-jobs", post(crate::handlers::admin::alerts::discard_dead_jobs))
        // ── Inventaire des appareils et des sessions ──────────────
        // Même précaution d'ordre : `facets` précède `/:id`, sinon matchit le
        // lirait comme un identifiant d'appareil.
        .route("/devices",             get(crate::handlers::admin::devices::list_devices))
        .route("/devices/facets",      get(crate::handlers::admin::devices::device_facets))
        .route("/devices/:id",         get(crate::handlers::admin::devices::get_device)
                                    .delete(crate::handlers::admin::devices::forget_device))
        .route("/devices/:id/approval", post(crate::handlers::admin::devices::set_approval))
        .route("/devices/:id/sign-out", post(crate::handlers::admin::devices::sign_out_device))
        // Liste globale des sessions actives - vue qui n'existait pas.
        .route("/sessions",            get(crate::handlers::admin::devices::list_sessions))
        // ── Moteur de règles d'administration ─────────────────────
        // Mêmes précautions d'ordre que pour /audit et /alerts : les segments
        // statiques (`catalog`, `executions`) précèdent `/:id`.
        .route("/rules",            get(crate::handlers::admin::rules::list_rules)
                                   .post(crate::handlers::admin::rules::create_rule))
        .route("/rules/catalog",     get(crate::handlers::admin::rules::get_catalog))
        .route("/rules/executions",  get(crate::handlers::admin::rules::list_executions))
        .route("/rules/:id",         get(crate::handlers::admin::rules::get_rule)
                                   .patch(crate::handlers::admin::rules::update_rule)
                                  .delete(crate::handlers::admin::rules::delete_rule))
        .route("/rules/:id/mode",   post(crate::handlers::admin::rules::set_mode))
        .route("/rules/:id/versions", get(crate::handlers::admin::rules::list_versions))
        .route("/rules/:id/backtest", post(crate::handlers::admin::rules::start_backtest))
        .route("/rules/:id/backtest/:backtest_id",
                                      get(crate::handlers::admin::rules::get_backtest))
        // ── Tableau de bord sécurité ──────────────────────────────
        // Une seule lecture pour toute la page : chaque panneau est un agrégat
        // à portée instance, filtré par le privilège qui le gouverne (sessions,
        // audit, alertes, règles). Aucune écriture - chaque panneau renvoie
        // vers le rapport détaillé qui, lui, a déjà ses routes.
        .route("/security/dashboard",
               get(crate::handlers::admin::security_dashboard::security_dashboard))
        // ── Détecteurs de contenu (protection des données) ────────
        // Mêmes précautions d'ordre : `test` et `reference` précèdent `/:id`.
        .route("/detectors",           get(crate::handlers::admin::detectors::list_detectors)
                                      .post(crate::handlers::admin::detectors::create_detector))
        .route("/detectors/test",     post(crate::handlers::admin::detectors::test_detector))
        .route("/detectors/reference", get(crate::handlers::admin::detectors::lookup_reference))
        .route("/detectors/:id",       get(crate::handlers::admin::detectors::get_detector)
                                     .patch(crate::handlers::admin::detectors::update_detector)
                                    .delete(crate::handlers::admin::detectors::delete_detector))
        // ── Unités organisationnelles et groupes ──────────────────
        .route("/org-units",     get(list_org_units).post(create_org_unit))
        // Ce qu'une suppression détruirait, avant de la déclencher.
        .route("/org-units/:id/impact", get(org_unit_impact))
        .route("/org-units/:id", patch(update_org_unit).delete(delete_org_unit))
        // Audiences cibles : les listes de destinataires proposées au partage.
        // La politique (quelles audiences, dans quel module, pour quelle unité)
        // a ses segments statiques AVANT `/audiences/:id`, sinon « policy »
        // serait lu comme un identifiant.
        .route("/audiences/policy",             get(crate::handlers::admin::audiences::get_policy)
                                                .put(crate::handlers::admin::audiences::set_policy))
        .route("/audiences",                    get(crate::handlers::admin::audiences::list_audiences)
                                                .post(crate::handlers::admin::audiences::create_audience))
        .route("/audiences/:id",                get(crate::handlers::admin::audiences::get_audience)
                                                .patch(crate::handlers::admin::audiences::update_audience)
                                                .delete(crate::handlers::admin::audiences::delete_audience))
        .route("/audiences/:id/members",        post(crate::handlers::admin::audiences::add_members)
                                                .delete(crate::handlers::admin::audiences::remove_members))
        // Domaines : ce que l'instance affirme s'appeler, et la preuve DNS qui
        // le rend opposable. Segments statiques d'abord, comme partout ailleurs.
        .route("/domains",                      get(crate::handlers::admin::domains::list)
                                               .post(crate::handlers::admin::domains::create))
        .route("/domains/:id",                  get(crate::handlers::admin::domains::get)
                                             .delete(crate::handlers::admin::domains::delete))
        .route("/domains/:id/verify",          post(crate::handlers::admin::domains::verify))
        .route("/domains/:id/mail-check",      post(crate::handlers::admin::domains::mail_check))
        .route("/domains/:id/primary",         post(crate::handlers::admin::domains::promote))
        // Migration de données : le core tient le plan et l'avancement, le
        // module propriétaire de la destination fait la copie. Segments
        // statiques d'abord - « probe » doit précéder `/:id`, sinon il serait lu
        // comme un identifiant de campagne.
        .route("/data-migration/probe",         post(crate::handlers::admin::data_migration::probe))
        .route("/data-migration",                get(crate::handlers::admin::data_migration::list)
                                                .post(crate::handlers::admin::data_migration::create))
        .route("/data-migration/:id",            get(crate::handlers::admin::data_migration::get)
                                              .delete(crate::handlers::admin::data_migration::delete))
        .route("/data-migration/:id/start",     post(crate::handlers::admin::data_migration::start))
        .route("/data-migration/:id/pause",     post(crate::handlers::admin::data_migration::pause))
        .route("/data-migration/:id/accounts/:account_id/retry",
                                                post(crate::handlers::admin::data_migration::retry_account))
        // Export de données : le miroir de la migration (celle-ci fait entrer,
        // celui-là fait sortir). La politique s'écrit par
        // /admin/settings/scoped/:key (déjà audité) ; ici la lecture, la
        // demande, l'annulation, la suppression et le téléchargement.
        //
        // Le téléchargement est une route et non un fichier servi : quatre
        // conditions doivent tenir à l'instant de la requête - exécution
        // terminée, délai de sécurité écoulé, archive non supprimée, rétention
        // non expirée - et chaque téléchargement est audité et compté.
        .route("/data-export",                   get(crate::handlers::admin::data_export::get_data_export)
                                                .post(crate::handlers::admin::data_export::request_export))
        .route("/data-export/:id",            delete(crate::handlers::admin::data_export::delete_export))
        .route("/data-export/:id/cancel",       post(crate::handlers::admin::data_export::cancel_export))
        .route("/data-export/:id/download",      get(crate::handlers::admin::data_export::download_export))
        .route("/data-export/:id/subjects",      get(crate::handlers::admin::data_export::export_subjects))
        // Licence du logiciel et contrat de support. Une seule lecture pour
        // toute la page - elle compose la licence (une constante), l'identité de
        // l'instance, l'inventaire des modules et le contrat, chaque bloc
        // n'étant inclus que si l'appelant a le droit de le voir. Aucun
        // identifiant dans l'URL : la section n'a qu'un seul objet.
        .route("/subscription",                 get(crate::handlers::admin::subscription::get))
        .route("/subscription/support-key",    post(crate::handlers::admin::subscription::register_key)
                                             .delete(crate::handlers::admin::subscription::remove_key))
        // Jours fériés : le référentiel mondial, ses corrections locales et la
        // surcouche par unité. Même précaution d'ordre que les sections
        // voisines - `/holidays/preview`, `/holidays/reload` et
        // `/holidays/overview` précèdent tout segment paramétré, et les
        // journées vivent sous `/holidays/days/:id` plutôt que sous
        // `/holidays/:id` pour ne jamais être confondues avec un calendrier.
        .route("/holidays/overview",            get(crate::handlers::admin::holidays::overview))
        .route("/holidays/preview",            post(crate::handlers::admin::holidays::preview))
        .route("/holidays/reload",             post(crate::handlers::admin::holidays::reload))
        .route("/holidays/calendars",           get(crate::handlers::admin::holidays::list_calendars)
                                               .post(crate::handlers::admin::holidays::create_calendar))
        .route("/holidays/calendars/:id",       get(crate::handlers::admin::holidays::calendar_detail)
                                              .patch(crate::handlers::admin::holidays::update_calendar)
                                             .delete(crate::handlers::admin::holidays::delete_calendar))
        .route("/holidays/calendars/:id/holidays",   post(crate::handlers::admin::holidays::create_holiday))
        .route("/holidays/calendars/:id/exclusions",  put(crate::handlers::admin::holidays::set_exclusions))
        .route("/holidays/days/:id",          patch(crate::handlers::admin::holidays::update_holiday)
                                             .delete(crate::handlers::admin::holidays::delete_holiday))
        .route("/holidays/days/:id/enabled",  patch(crate::handlers::admin::holidays::set_holiday_enabled))
        .route("/holidays/days/:id/reset",     post(crate::handlers::admin::holidays::reset_holiday))
        .route("/holidays/units/:unit_id",      get(crate::handlers::admin::holidays::unit_overlay)
                                                .put(crate::handlers::admin::holidays::set_unit_pref))
        // Bâtiments et ressources : la partie de l'annuaire qui n'est pas des
        // personnes. Même précaution d'ordre qu'au-dessus - `/resources/overview`
        // précède `/resources/:id`, sinon « overview » serait lu comme un
        // identifiant et renverrait un 400 sur une page qui existe.
        .route("/resources/overview",           get(crate::handlers::admin::resources::overview))
        // Les réservations vivent dans le schéma du module : le core relaie la
        // question plutôt que de lire un schéma qui ne lui appartient pas.
        .route("/resources/room-stats",         get(crate::handlers::admin::resources::room_stats))
        .route("/resources",                    get(crate::handlers::admin::resources::list_resources)
                                                .post(crate::handlers::admin::resources::create_resource))
        .route("/resources/:id",              patch(crate::handlers::admin::resources::update_resource)
                                                .delete(crate::handlers::admin::resources::delete_resource))
        .route("/buildings",                    get(crate::handlers::admin::resources::list_buildings)
                                                .post(crate::handlers::admin::resources::create_building))
        .route("/buildings/:id",              patch(crate::handlers::admin::resources::update_building)
                                                .delete(crate::handlers::admin::resources::delete_building))
        .route("/resource-features",            get(crate::handlers::admin::resources::list_features)
                                                .post(crate::handlers::admin::resources::create_feature))
        .route("/resource-features/:id",      patch(crate::handlers::admin::resources::update_feature)
                                                .delete(crate::handlers::admin::resources::delete_feature))
        .route("/groups",                        get(list_groups).post(create_group))
        .route("/groups/:id",                   get(get_group).patch(update_group).delete(delete_group))
        .route("/groups/:id/members",           post(add_member))
        .route("/groups/:id/members/:user_id", delete(remove_member))
        // ── Administration déléguée : catalogue, rôles, affectations ──
        .route("/privileges",       get(crate::handlers::admin::roles::list_privileges))
        .route("/roles",            get(crate::handlers::admin::roles::list_roles)
                                   .post(crate::handlers::admin::roles::create_role))
        .route("/roles/:id",      patch(crate::handlers::admin::roles::update_role)
                                 .delete(crate::handlers::admin::roles::delete_role))
        .route("/role-assignments",     get(crate::handlers::admin::roles::list_assignments)
                                       .post(crate::handlers::admin::roles::create_assignment))
        .route("/role-assignments/:id", delete(crate::handlers::admin::roles::delete_assignment))
        // The floor. Applied to the sub-router, so it covers every route above
        // and every route added below it later.
        .layer(middleware::from_fn_with_state(state.clone(), crate::authz::admin_layer));

    let api_v1 = Router::new()
        // ── Auth public ──────────────────────────────────────────
        .nest("/auth", auth_routes)
        // ── Administration (garde de couche + extracteurs) ───────
        .nest("/admin", admin_routes)
        // ── Config publique ──────────────────────────────────────
        .route("/config",                   get(public_config))
        // Counterpart of the installer's endpoint: an installed instance says so
        // plainly instead of letting the request fall through to the SPA, which
        // would answer 200 with HTML and read as "not installed" to a client.
        .route("/setup/status",              get(|| async {
            axum::Json(serde_json::json!({ "setup_required": false }))
        }))
        // ── Spec OpenAPI + doc interactive (publiques) ───────────
        .route("/openapi.json", get(crate::openapi::openapi_json))
        .route("/docs",         get(crate::openapi::docs))
        // ── Thèmes (public) ──────────────────────────────────────
        .route("/themes", get(list_themes))
        // Assets d'un thème empaqueté (CSS/JS/polices…), servis en même origine.
        .route("/themes/:id/*path", get(serve_theme_asset))
        // ── Modules (public) ─────────────────────────────────────
        .route("/modules", get(list_modules))
        // Paramètres résolus d'un module pour l'utilisateur courant (authentifié).
        .route("/modules/:module/config", get(get_module_config))
        // ── User profile (authentifié) ───────────────────────────
        .route("/me",                   get(get_me).patch(update_me))
        .route("/me/activity",          get(me_activity))
        .route("/me/avatar",                post(upload_avatar))
        .route("/users/:id/avatar",        get(get_avatar))
        .route("/users/:id/avatar/original", get(get_avatar_original))
        .route("/linked-account/login",    post(linked_account_login))
        .route("/me/password",          patch(change_password))
        .route("/users/search",         get(search_users))
        .route("/users/lookup",         get(lookup_users))
        // One person, as the directory publishes them - for a contact card.
        .route("/users/:id/card",       get(crate::handlers::users::user_card))
        .route("/me/sessions",          get(list_sessions).delete(revoke_all_sessions))
        .route("/me/sessions/:id",     delete(revoke_session))
        // Mes appareils : exactement ce qu'un administrateur voit des miens.
        // Le segment statique `declare` précède `/:id`.
        .route("/me/devices",              get(crate::handlers::devices::list_my_devices))
        .route("/me/devices/declare",     post(crate::handlers::devices::declare))
        .route("/me/devices/:id",          get(crate::handlers::devices::get_my_device)
                                        .patch(crate::handlers::devices::rename_my_device))
        .route("/me/devices/:id/sign-out", post(crate::handlers::devices::sign_out_my_device))
        .route("/me/devices/:id/not-me",   post(crate::handlers::devices::disown_my_device))
        // API tokens personnels
        .route("/me/api-tokens",        get(list_api_tokens).post(create_api_token))
        .route("/me/api-tokens/scopes", get(api_token_scopes))
        .route("/me/api-tokens/:id",   delete(revoke_api_token))
        // Historique du presse-papiers (par utilisateur, tous modules confondus)
        .route("/clipboard",     get(crate::handlers::clipboard::list)
                                 .post(crate::handlers::clipboard::push)
                               .delete(crate::handlers::clipboard::clear))
        .route("/clipboard/:id", patch(crate::handlers::clipboard::update)
                               .delete(crate::handlers::clipboard::delete))
        // Jours fériés et journées spéciales : information publique, lisible par
        // tout compte authentifié. Les segments statiques précèdent tout
        // paramètre - il n'y en a aucun ici, mais l'ordre reste celui des
        // sections voisines.
        .route("/holidays",             get(crate::handlers::holidays::feed))
        .route("/holidays/applicable",  get(crate::handlers::holidays::applicable))
        .route("/holidays/calendars",   get(crate::handlers::holidays::calendars))
        // Étiquettes transversales (labels reliant des éléments de tous les modules)
        .route("/labels",               get(list_labels).post(create_label))
        .route("/labels/browse",        get(browse_labels))
        .route("/labels/share-targets", get(label_share_targets))
        .route("/labels/resource",      get(labels_for_resource).put(set_resource_labels))
        .route("/labels/:id",         patch(update_label).delete(delete_label))
        .route("/labels/:id/links",     get(list_label_links))
        .route("/labels/:id/shares",    get(list_label_shares).put(set_label_shares))
        .route("/labels/:id/links/:link_id", delete(remove_label_link))
        // 2FA / TOTP
        .route("/me/2fa/setup",         post(setup_totp))
        .route("/me/2fa/enable",        post(enable_totp))
        .route("/me/2fa",              delete(disable_totp))
        // Codes de secours : GET = compteurs, POST = nouveau lot (action sensible).
        .route("/me/2fa/backup-codes",   get(crate::handlers::backup_codes::get_status)
                                        .post(crate::handlers::backup_codes::regenerate))
        // Vue d'ensemble sécurité du compte courant (compteurs, échéance 2FA admin).
        .route("/me/security",           get(crate::handlers::users::security_overview))
        // « Télécharger mes données » : l'export de données, ouvert au compte
        // qu'il concerne. Aucune de ces routes n'accepte d'identifiant de compte -
        // le sujet est toujours l'appelant, pris du jeton. Les trois répondent
        // 404 quand `data_export.self_service` est désactivé pour la portée de
        // l'utilisateur : la fonction disparaît au lieu d'être refusée.
        .route("/me/export",              get(crate::handlers::me_export::get_my_export)
                                         .post(crate::handlers::me_export::request_my_export))
        .route("/me/export/:id/download",  get(crate::handlers::me_export::download_my_export))
        // Notifications push (devices + préférences)
        .route("/me/push/devices",      post(crate::handlers::push::register_device))
        .route("/me/push/devices/:id", delete(crate::handlers::push::delete_device))
        .route("/me/push/preferences",  get(crate::handlers::push::list_preferences).patch(crate::handlers::push::set_preference))
        // Coupe les requêtes REST anormalement lentes (slowloris applicatif).
        // N'est PAS appliqué à /ws ni au proxy de modules (connexions longues /
        // streaming), interceptés avant ce sous-routeur.
        .layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(60)))
        // Idempotence des écritures (rejeu offline) : court-circuite les requêtes
        // mutantes portant un Idempotency-Key déjà vu. No-op sur les GET.
        .layer({
            let st = state.clone();
            middleware::from_fn(move |req: Request<Body>, next: Next| {
                let st = st.clone();
                async move { crate::middleware::idempotency::idempotency(st, req, next).await }
            })
        });

    let internal = Router::new()
        .route("/modules/register",         post(register_module))
        // A module reading back its own instance settings. Two ways in: by the
        // internal secret alone (works only when per-module derived secrets
        // identify the caller), or by naming the module in the URL (the path
        // that also works under a shared master secret). Both refuse a caller
        // that is identified as a DIFFERENT module.
        .route("/modules/settings",         get(internal_module_settings))
        .route("/modules/:id/settings",     get(internal_module_settings_by_id))
        .route("/modules/:id/heartbeat",   post(module_heartbeat))
        .route("/modules/:id/unregister",  post(unregister_module))
        .route("/modules/:id/log",         post(module_log))
        .route("/events/publish",           post(publish_event))
        // A module closes one of its collaboration rooms after replacing the
        // content behind it (REST save from outside the room).
        .route("/collab/rooms/close",       post(crate::collab::close_room))
        // Portail de protection des données : un module demande, AVANT de
        // valider une opération, si elle est autorisée. Interne par nature -
        // pouvoir soumettre un texte et lire « bloqué » depuis un navigateur,
        // c'est pouvoir cartographier la politique par dichotomie.
        .route("/rules/gate",               post(crate::handlers::gate::gate))
        // Internal MCP gateway: the assistant module lists/executes tools
        // des modules au nom d'un utilisateur (identité via en-tête, pas de token API).
        .route("/mcp",                      post(crate::handlers::mcp::internal_mcp_endpoint))
        // Provenance du stockage : un module déclare ce qu'il occupe pour un
        // compte. L'identité du déclarant vient du secret interne dérivé, jamais
        // du corps de la requête - un module ne peut déclarer que pour lui-même.
        .route("/storage/usage",            post(crate::handlers::storage_usage::declare))
        // Catalogue des ressources réservables, en LECTURE seule. Un module qui
        // pourrait écrire ici serait un module qui décide du contenu de
        // l'annuaire - c'est le travail de l'administrateur. Aucun module n'est
        // nommé : le secret interne prouve que l'appelant est dans l'instance,
        // et tous lisent la même réponse.
        .route("/directory/resources",       get(crate::handlers::admin::resources::internal_list_resources))
        // Les comptes, en LECTURE seule, pour un module qui doit rattacher un de
        // ses objets à une personne (une boîte aux lettres à son propriétaire).
        // Même projection que les sélecteurs de personnes ; aucun module n'est
        // nommé, le secret interne prouve seulement que l'appelant est dans
        // l'instance. Écrire ici est et reste impossible : c'est le core qui
        // définit les comptes, et lui seul.
        .route("/directory/users",           get(crate::handlers::users::internal_list_users))
        .route("/directory/users/:id",       get(crate::handlers::users::internal_get_user))
        // Group membership, READ ONLY, for a module gating access on groups (e.g.
        // the forum's per-group forum permissions). Only id + name are disclosed.
        .route("/directory/users/:id/groups", get(crate::handlers::users::internal_user_groups))
        .route("/directory/groups",          get(crate::handlers::users::internal_list_groups))
        .route("/mail/provisioning/users",     get(crate::handlers::users::internal_provisioning_users))
        .route("/mail/provisioning/users/:id", get(crate::handlers::users::internal_provisioning_user))
        // Les domaines déclarés par l'instance, en LECTURE seule, avec leur état
        // de vérification. C'est la SEULE réponse à « ce nom est-il à nous ? » :
        // un module qui garderait sa propre liste ferait diverger les deux (le
        // module mail servait un domaine retiré ici, sans jamais l'apprendre).
        // Non filtré aux vérifiés : « déclaré, en attente » et « pas déclaré »
        // appellent des conseils opposés, et un module ne peut pas les
        // distinguer d'une liste tronquée.
        .route("/domains",                   get(crate::handlers::admin::domains::internal_list_domains))
        // Montages distants centralisés (le module drive proxifie vers ici).
        .route("/storage/smb-shares/:user_id",              post(crate::handlers::storage_mounts::smb_shares))
        .route("/storage/mounts/:user_id",                  get(crate::handlers::storage_mounts::list).post(crate::handlers::storage_mounts::create))
        .route("/storage/mounts/:user_id/:id",              axum::routing::patch(crate::handlers::storage_mounts::update)
                                                               .delete(crate::handlers::storage_mounts::delete))
        .route("/storage/mounts/:user_id/:id/config",       get(crate::handlers::storage_mounts::config))
        .route("/storage/mounts/:user_id/:id/test",         post(crate::handlers::storage_mounts::test))
        .route("/storage/mounts/:user_id/:id/browse",       get(crate::handlers::storage_mounts::browse_root))
        .route("/storage/mounts/:user_id/:id/browse/*path", get(crate::handlers::storage_mounts::browse))
        .route("/storage/mounts/:user_id/:id/file/*path",   get(crate::handlers::storage_mounts::get_file))
        .route("/storage/mounts/:user_id/:id/upload/*path", post(crate::handlers::storage_mounts::upload))
        .route("/storage/mounts/:user_id/:id/entry/*path",  axum::routing::delete(crate::handlers::storage_mounts::delete_entry))
        .route("/storage/mounts/:user_id/:id/rename/*path", post(crate::handlers::storage_mounts::rename_entry))
        .route("/storage/mounts/:user_id/:id/mkdir/*path",  post(crate::handlers::storage_mounts::create_dir))
        .layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(30)))
        // Relais IPC module→module. Un module ne peut pas s'authentifier
        // directement auprès d'un autre sous secrets dérivés (chacun ne détient
        // que le sien, comparé à l'égalité) : l'appel transite par le core, qui
        // authentifie l'appelant et ré-injecte le secret de la cible. Placé
        // APRÈS le TimeoutLayer pour que les gros transferts /ipc (contenu de
        // fichiers) ne soient pas coupés à 30 s, comme /ws et le proxy de modules.
        .route("/ipc/:target/*rest", axum::routing::any(crate::modules::proxy::ipc_relay));

    let cors = {
        let origins = state.settings.server.cors_origins.clone();
        let allow = if origins.is_empty() {
            AllowOrigin::list([])
        } else {
            let parsed: Vec<_> = origins.iter()
                .filter_map(|o| o.parse().ok())
                .collect();
            AllowOrigin::list(parsed)
        };
        CorsLayer::new()
            .allow_origin(allow)
            .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE, Method::PUT, Method::OPTIONS])
            .allow_headers([AUTHORIZATION, CONTENT_TYPE])
            .allow_credentials(false)
    };

    let static_files = ServeDir::new(&frontend_dist)
        .fallback(ServeFile::new(format!("{frontend_dist}/index.html")));

    // CSP : l'import map ESM du host est un <script type="importmap"> inline.
    // Sa valeur est recalculée à chaque changement de `importmap.sha256` - voir
    // `CspHeaderCache` pour la raison (un déploiement frontend-only ne redémarre
    // pas le serveur).
    let csp_cache = std::sync::Arc::new(crate::router::csp::CspHeaderCache::new(&frontend_dist));

    // Le middleware de proxy intercepte les requêtes vers les modules actifs
    // AVANT le routage, ce qui évite tout conflit avec les routes paramétrées.
    let proxy_state = state.clone();
    let proxy_middleware = middleware::from_fn(move |req: Request<Body>, next: Next| {
        let state = proxy_state.clone();
        async move { module_proxy_middleware(state, req, next).await }
    });

    Router::new()
        .route("/health", get(health))
        .route("/ready",  get(ready))
        // Public ACME HTTP-01 challenge - unauthenticated by design, answers only
        // tokens the core itself is currently proving (see crate::network::acme).
        .route("/.well-known/acme-challenge/:token",
               get(crate::handlers::acme::http01_challenge))
        .route("/ws",     get(ws_handler))
        .route("/collab/:room/sync", get(crate::collab::collab_handler))
        .route("/mcp",    post(crate::handlers::mcp::mcp_endpoint))
        // Assets frontend des modules (bundles UI chargés à l'exécution par le host).
        .route("/modules/:id/*path", get(serve_module_asset))
        .nest("/api/v1",  api_v1)
        .nest("/internal", internal)
        .fallback_service(static_files)
        .layer(proxy_middleware)
        .layer(DefaultBodyLimit::max(100 * 1024 * 1024)) // 100 MB; modules set their own limits
        .layer(middleware::from_fn(cache_control_middleware))
        .layer(middleware::from_fn(apache_log_middleware))
        .layer(cors)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-frame-options"),
            HeaderValue::from_static("DENY"),
        ))
        // `if_not_present`: a response may ask for a STRICTER policy - the module
        // proxy sets `no-referrer` on anything fetched with a signed ticket, whose
        // URL must never travel on as a Referer (see `crate::auth::tickets`).
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        // HSTS : évalué PAR REQUÊTE, car il faut connaître la requête (et pas
        // seulement la réponse) pour savoir si elle est arrivée en TLS. Deux cas
        // comptent : le core a terminé le TLS lui-même, ou un mandataire inverse
        // de confiance l'a fait et l'annonce (`X-Forwarded-Proto`). Émettre
        // l'en-tête sur du HTTP en clair non mandaté n'a aucun effet ; ne PAS
        // l'émettre derrière nginx supprimerait la protection là où elle sert.
        .layer(middleware::from_fn({
            let holder = hsts_holder.clone();
            move |req: Request<Body>, next: Next| {
                let holder = holder.clone();
                async move {
                    let configured = holder.hsts();
                    let over_tls = configured.is_some().then(|| {
                        let peer = req
                            .extensions()
                            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                            .map(|ci| ci.0.ip());
                        let host = req
                            .headers()
                            .get(axum::http::header::HOST)
                            .and_then(|v| v.to_str().ok());
                        crate::network::runtime::hsts_applies_to_host(host)
                            && crate::network::runtime::response_is_over_tls(
                                req.headers(),
                                peer,
                                holder.is_https_live(),
                            )
                    }) == Some(true);
                    let mut response = next.run(req).await;
                    if over_tls {
                        if let Some(value) = configured {
                            response.headers_mut().insert(
                                HeaderName::from_static("strict-transport-security"),
                                value,
                            );
                        }
                    }
                    response
                }
            }
        }))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("content-security-policy"),
            // Fermeture évaluée par réponse : elle relit le hash de l'import map
            // dès que le fichier change sur disque (cf. `CspHeaderCache`).
            {
                let cache = csp_cache.clone();
                move |_: &Response<_>| Some(cache.header())
            },
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("permissions-policy"),
            // Allow same-origin access to camera/mic/screen-capture so the chat
            // module can run WebRTC audio/video calls, and to geolocation so
            // Maps can offer "Your location", the locate button and live
            // navigation. Third parties stay blocked.
            HeaderValue::from_static("camera=(self), microphone=(self), display-capture=(self), geolocation=(self)"),
        ))
        // ── Protections anti-DDoS (les plus externes : filtrent avant tout
        //    travail coûteux). global_rate_limit amortit un flood par IP ;
        //    concurrency_limit est le garde-fou ultime qui borne la mémoire/les
        //    tâches en sheddant (503) quand le serveur est saturé. Les deux
        //    laissent passer les connexions longues (WebSocket). ──
        .layer(middleware::from_fn(concurrency_limit))
        .layer(middleware::from_fn(global_rate_limit))
        .with_state(state)
}

/// Middleware : si le chemin est /api/v1/{module_id}/... et que ce module est actif,
/// proxifie directement. Sinon laisse passer vers le routeur (routes internes du core).
async fn module_proxy_middleware(
    state: AppState,
    req: Request<Body>,
    next: Next,
) -> Response {
    let path = req.uri().path().to_owned();

    if let Some(api_path) = path.strip_prefix("/api/v1/") {
        let module_id = api_path.split('/').next().unwrap_or("").to_string();
        if !module_id.is_empty() {
            let is_active = state.modules.read().await.get(&module_id).is_some();
            if is_active {
                let rewritten = rewrite_uri_strip_prefix(req.uri(), "/api/v1");
                let (mut parts, body) = req.into_parts();
                parts.uri = rewritten;
                let proxied_req = Request::from_parts(parts, body);

                // WebSocket upgrades need a TCP tunnel, not a reqwest proxy
                if is_websocket_upgrade(&proxied_req) {
                    return proxy_ws_to_module(state, module_id, proxied_req).await;
                }

                return match proxy_to_module(&state, &module_id, proxied_req).await {
                    Ok(resp)  => resp.into_response(),
                    Err(e)    => e.into_response(),
                };
            }
        }
    }

    next.run(req).await
}

/// Cache-Control :
///   - assets content-hashés (URL change à chaque changement de contenu) →
///     immutable 1 an : `/assets/*`, `/shared/*` (host), et côté modules
///     `/modules/<id>/entry-<hash>.{js,css}` + `/modules/<id>/chunks/*`
///   - médias statiques à nom STABLE (logos, icônes, polices) → `no-cache`
///   - tout le reste (index.html, routes SPA, API, entry non hashé, assets
///     modules non hashés) → no-store
///
/// Le content-hash dans le NOM est ce qui permet le cache long : l'URL change
/// dès que le contenu change. C'est aussi ce qui empêche iOS Safari de resservir
/// un module ES périmé (son cache est indexé par URL et ignore `no-store` tant
/// que l'URL reste stable).
///
/// `no-cache` ne veut PAS dire « ne pas mettre en cache » (c'est `no-store`) :
/// le navigateur garde la copie et REVALIDE avant chaque réutilisation. Ces
/// fichiers portent un nom stable, donc `no-store` les faisait re-télécharger
/// intégralement à chaque montage - le lanceur d'applications, qui affiche une
/// vignette par module, repayait ~650 ko à chaque ouverture. Avec `no-cache`,
/// `ServeDir` répond 304 (corps vide) tant que le fichier n'a pas changé, et
/// sert le nouveau contenu dès qu'il change : aucun risque de version périmée,
/// contrairement à un `max-age` qui, lui, laisserait servir l'ancienne image
/// sans rien demander au serveur.
async fn cache_control_middleware(req: Request<Body>, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    // Kept for the content-ETag below, which must read them before `next` takes
    // ownership of the request. HEAD is excluded on purpose: its body is empty,
    // so hashing it would publish an ETag that does not describe the file.
    let is_get = req.method() == Method::GET;
    let if_none_match = req
        .headers()
        .get(axum::http::header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let mut response = next.run(req).await;
    // A handler (or proxied module) that set Cache-Control itself did so on
    // purpose - e.g. drive's font endpoints, which are content-addressed via
    // ETag and would be re-downloaded on every page load under `no-store`.
    // Axum/reqwest never add the header on their own, so its presence is
    // always a deliberate upstream decision.
    if response.headers().contains_key(axum::http::header::CACHE_CONTROL) {
        return response;
    }
    let revalidatable = is_revalidatable_static(&path);
    let value = if is_content_hashed_asset(&path) {
        "public, max-age=31536000, immutable"
    } else if revalidatable {
        "no-cache"
    } else {
        "no-store"
    };
    if let Ok(v) = HeaderValue::from_str(value) {
        response.headers_mut().insert(axum::http::header::CACHE_CONTROL, v);
    }
    if revalidatable && is_get && response.status() == StatusCode::OK {
        response = with_content_etag(response, if_none_match).await;
    }
    response
}

/// Validation par CONTENU (ETag) des médias statiques, en plus de la validation
/// par date que `ServeDir` fournit seul.
///
/// `Last-Modified` ne dit pas « le fichier a changé » mais « le fichier a été
/// réécrit » : installer un `.deb` ou lancer `deploy_local.sh` recopie tout, si
/// bien que chaque mise à jour renvoyait la totalité des logos (~1 Mo) même
/// quand pas un pixel n'avait bougé. L'ETag est un condensé du contenu : tant
/// que l'image est la même, le navigateur reçoit un 304 vide, quelle que soit
/// la date du fichier sur le disque.
///
/// Le corps n'est mis en mémoire que si `Content-Length` l'annonce sous le
/// plafond : sans cette borne, `to_bytes` consommerait un corps qu'on ne
/// pourrait plus rejouer, et un gros média serait bufferisé pour rien.
async fn with_content_etag(response: Response, if_none_match: Option<String>) -> Response {
    /// Au-delà, on laisse `ServeDir` streamer le fichier avec sa date.
    const MAX_HASHED_BYTES: usize = 2 * 1024 * 1024;

    let (mut parts, body) = response.into_parts();
    let len = parts
        .headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    if len.is_none_or(|l| l > MAX_HASHED_BYTES) {
        return Response::from_parts(parts, body);
    }

    let bytes = match axum::body::to_bytes(body, MAX_HASHED_BYTES).await {
        Ok(b) => b,
        // The body is gone at this point, so the only honest answer is an error
        // rather than a truncated file.
        Err(e) => {
            tracing::error!("lecture du corps pour l'ETag: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    use sha2::Digest;
    let digest = sha2::Sha256::digest(&bytes);
    let etag = format!("\"{:x}\"", digest);

    // A cached copy that still matches: answer 304 and send no body at all.
    // `If-None-Match` may carry a list, and a proxy may have weakened the tag
    // with the `W/` prefix - both are matches for our purposes.
    if let Some(candidates) = if_none_match.as_deref() {
        let hit = candidates
            .split(',')
            .map(|c| c.trim().trim_start_matches("W/"))
            .any(|c| c == etag || c == "*");
        if hit {
            parts.status = StatusCode::NOT_MODIFIED;
            parts.headers.remove(axum::http::header::CONTENT_LENGTH);
            parts.headers.remove(axum::http::header::CONTENT_TYPE);
            if let Ok(v) = HeaderValue::from_str(&etag) {
                parts.headers.insert(axum::http::header::ETAG, v);
            }
            return Response::from_parts(parts, Body::empty());
        }
    }

    if let Ok(v) = HeaderValue::from_str(&etag) {
        parts.headers.insert(axum::http::header::ETAG, v);
    }
    Response::from_parts(parts, Body::from(bytes))
}

/// Vrai si le chemin désigne un asset dont le NOM contient un content-hash (donc
/// URL stable ⇔ contenu stable → cachable `immutable`).
fn is_content_hashed_asset(path: &str) -> bool {
    if path.starts_with("/assets/") || path.starts_with("/shared/") {
        return true;
    }
    // Bundles des modules : entrée content-hashée + chunks internes hashés.
    if path.starts_with("/modules/") {
        if path.contains("/chunks/") {
            return true;
        }
        if let Some(file) = path.rsplit('/').next() {
            for ext in [".js", ".css"] {
                if let Some(rest) = file.strip_suffix(ext) {
                    if let Some(hash) = rest.strip_prefix("entry-") {
                        if !hash.is_empty() && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

/// Vrai si le chemin désigne un média statique à nom stable (image, icône,
/// police) servi depuis le disque - donc revalidable par `Last-Modified`/ETag
/// plutôt que re-téléchargé intégralement.
///
/// Les routes applicatives sont exclues : `/api/*` et `/internal/*` peuvent
/// renvoyer des données privées sous une URL qui « ressemble » à un fichier, et
/// celles qui servent réellement un média (avatars…) posent déjà leur propre
/// Cache-Control, honoré plus haut.
fn is_revalidatable_static(path: &str) -> bool {
    if path.starts_with("/api/") || path.starts_with("/internal/") {
        return false;
    }
    const EXTS: [&str; 11] = [
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".woff2", ".woff", ".ttf",
        ".otf",
    ];
    let file = path.rsplit('/').next().unwrap_or(path);
    let lower = file.to_ascii_lowercase();
    EXTS.iter().any(|ext| lower.ends_with(ext))
}

fn rewrite_uri_strip_prefix(uri: &Uri, prefix: &str) -> Uri {
    let path_and_query = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
    let stripped = path_and_query
        .strip_prefix(prefix)
        .filter(|s| s.is_empty() || s.starts_with('/'))
        .unwrap_or(path_and_query);
    let new_pq = if stripped.is_empty() { "/" } else { stripped };
    let mut parts = uri.clone().into_parts();
    parts.path_and_query = new_pq.parse().ok();
    Uri::from_parts(parts).unwrap_or_else(|_| uri.clone())
}
