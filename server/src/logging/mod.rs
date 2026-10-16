use axum::{body::Body, http::Request, middleware::Next, response::Response};
use chrono::Local;
use tracing_appender::{
    non_blocking::WorkerGuard,
    rolling::{RollingFileAppender, Rotation},
};
use tracing_subscriber::{
    filter, fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer,
};

use crate::config::settings::{LogFormat, LogRotation, LoggingSettings};

/// Garde-fous qui maintiennent les threads d'écriture non-bloquants en vie.
/// Doit être conservé jusqu'à la fin du processus.
pub struct LogGuards {
    _access: Option<WorkerGuard>,
    _error:  Option<WorkerGuard>,
}

/// Initialise le subscriber tracing global avec, selon la config :
///   - access.log  : chaque requête HTTP (format Apache Combined Log)
///   - error.log   : WARN et ERROR de toutes les sources (core + modules)
///   - stdout      : tous les niveaux selon RUST_LOG / logging.level
///
/// Les fichiers sont rotatifs (daily par défaut) et les anciens sont
/// supprimés automatiquement selon `max_log_files`.
///
/// Nommage des fichiers rotatifs :
///   - daily  → access.2026-05-21.log / error.2026-05-21.log
///   - hourly → access.2026-05-21-16.log / error.2026-05-21-16.log
///   - never  → access.log / error.log (comportement original, sans rotation)
pub fn init(settings: &LoggingSettings) -> LogGuards {
    let filter_str = EnvFilter::try_from_default_env()
        .map(|f| f.to_string())
        .unwrap_or_else(|_| settings.level.clone());

    if !settings.file_enabled {
        return init_stdout_only(&filter_str, &settings.format);
    }

    if let Err(e) = std::fs::create_dir_all(&settings.log_dir) {
        eprintln!(
            "kubuno: impossible de créer le répertoire de logs '{}': {e} - écriture fichiers désactivée",
            settings.log_dir
        );
        return init_stdout_only(&filter_str, &settings.format);
    }

    let rotation = map_rotation(&settings.rotation);

    let access_appender = match build_appender(&settings.log_dir, "access", rotation.clone(), settings.max_log_files as usize) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("kubuno: impossible d'initialiser access.log: {e} - écriture fichiers désactivée");
            return init_stdout_only(&filter_str, &settings.format);
        }
    };

    let error_appender = match build_appender(&settings.log_dir, "error", rotation, settings.max_log_files as usize) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("kubuno: impossible d'initialiser error.log: {e} - écriture fichiers désactivée");
            return init_stdout_only(&filter_str, &settings.format);
        }
    };

    let (access_writer, access_guard) = tracing_appender::non_blocking(access_appender);
    let (error_writer, error_guard)   = tracing_appender::non_blocking(error_appender);

    // Écrit uniquement les lignes Apache (message brut, sans métadonnées tracing)
    let access_layer = fmt::Layer::new()
        .without_time()
        .with_level(false)
        .with_target(false)
        .with_ansi(false)
        .with_writer(access_writer)
        .with_filter(filter::filter_fn(|meta| meta.target() == "access_log"));

    // Écrit WARN et ERROR (core + modules), avec timestamp et niveau
    let error_layer = fmt::Layer::new()
        .with_ansi(false)
        .with_writer(error_writer)
        .with_filter(filter::filter_fn(|meta| {
            meta.target() != "access_log" && *meta.level() <= tracing::Level::WARN
        }));

    match settings.format {
        LogFormat::Json => {
            tracing_subscriber::registry()
                .with(access_layer)
                .with(error_layer)
                .with(fmt::Layer::new().json().with_filter(EnvFilter::new(&filter_str)))
                .init();
        }
        LogFormat::Pretty => {
            tracing_subscriber::registry()
                .with(access_layer)
                .with(error_layer)
                .with(fmt::Layer::new().pretty().with_filter(EnvFilter::new(&filter_str)))
                .init();
        }
    }

    LogGuards {
        _access: Some(access_guard),
        _error:  Some(error_guard),
    }
}

fn map_rotation(r: &LogRotation) -> Rotation {
    match r {
        LogRotation::Daily  => Rotation::DAILY,
        LogRotation::Hourly => Rotation::HOURLY,
        LogRotation::Never  => Rotation::NEVER,
    }
}

fn build_appender(
    dir: &str,
    prefix: &str,
    rotation: Rotation,
    max_files: usize,
) -> Result<RollingFileAppender, tracing_appender::rolling::InitError> {
    RollingFileAppender::builder()
        .rotation(rotation)
        .filename_prefix(prefix)
        .filename_suffix("log")
        .max_log_files(max_files)
        .build(dir)
}

fn init_stdout_only(filter_str: &str, format: &LogFormat) -> LogGuards {
    match format {
        LogFormat::Json => {
            tracing_subscriber::registry()
                .with(fmt::Layer::new().json().with_filter(EnvFilter::new(filter_str)))
                .init();
        }
        LogFormat::Pretty => {
            tracing_subscriber::registry()
                .with(fmt::Layer::new().pretty().with_filter(EnvFilter::new(filter_str)))
                .init();
        }
    }
    LogGuards { _access: None, _error: None }
}

/// Middleware Axum - enregistre chaque requête HTTP au format Apache Combined Log.
/// Les lignes sont émises sur le target "access_log" pour être routées vers access.log.
pub async fn apache_log_middleware(req: Request<Body>, next: Next) -> Response {
    let method    = req.method().to_string();
    // Credentials carried in a query string (signed tickets, socket tokens)
    // must never reach a log file.
    let uri       = redact_query_credentials(&req.uri().to_string());
    let version   = format!("{:?}", req.version());
    let referer   = redact_query_credentials(&header_str(&req, "referer"));
    let ua        = header_str(&req, "user-agent");
    let remote_ip = forwarded_ip(&req);

    let response = next.run(req).await;

    let status = response.status().as_u16();
    let bytes  = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-")
        .to_string();

    let timestamp = Local::now().format("%d/%b/%Y:%H:%M:%S %z").to_string();
    let line = format_apache_line(
        &remote_ip, &timestamp, &method, &uri, &version,
        status, &bytes, &referer, &ua,
    );

    tracing::info!(target: "access_log", "{}", line);

    response
}

// Nine parameters, and they stay nine: this is one line of the Apache combined
// log format, whose fields are fixed by the format itself. Folding them into a
// struct would add a type whose only purpose is to be destructured immediately,
// and whose field order could then drift from the format it must reproduce.
#[allow(clippy::too_many_arguments)]
pub fn format_apache_line(
    remote_ip: &str,
    timestamp: &str,
    method: &str,
    uri: &str,
    version: &str,
    status: u16,
    bytes: &str,
    referer: &str,
    user_agent: &str,
) -> String {
    format!(
        r#"{remote_ip} - - [{timestamp}] "{method} {uri} {version}" {status} {bytes} "{referer}" "{user_agent}""#
    )
}

/// Replaces the value of every credential-bearing query parameter (`kt`,
/// `token`, `access_token`) with `REDACTED`.
pub fn redact_query_credentials(uri: &str) -> String {
    let Some((head, query)) = uri.split_once('?') else {
        return uri.to_owned();
    };
    let redacted: Vec<String> = query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((k, _)) if matches!(k, "kt" | "token" | "access_token") => {
                format!("{k}=REDACTED")
            }
            _ => pair.to_owned(),
        })
        .collect();
    format!("{head}?{}", redacted.join("&"))
}

fn header_str(req: &Request<Body>, name: &str) -> String {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-")
        .to_string()
}

/// Adresse du client pour le journal d'accès. Les en-têtes de redirection ne
/// sont pris en compte que derrière un mandataire de confiance : sinon le
/// journal serait trivialement falsifiable. Voir `crate::auth::client_ip`.
fn forwarded_ip(req: &Request<Body>) -> String {
    crate::auth::client_ip::client_ip(req)
        .map_or_else(|| "-".to_string(), |ip| ip.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_credentials_are_redacted() {
        assert_eq!(
            redact_query_credentials("/api/v1/drive/x/download?inline=1&kt=kt1.a.b"),
            "/api/v1/drive/x/download?inline=1&kt=REDACTED"
        );
        assert_eq!(redact_query_credentials("/ws?token=eyJ"), "/ws?token=REDACTED");
        assert_eq!(redact_query_credentials("/a?kts=1"), "/a?kts=1");
        assert_eq!(redact_query_credentials("/a"), "/a");
    }

    #[test]
    fn test_format_apache_line_standard() {
        let line = format_apache_line(
            "192.168.1.1", "21/May/2026:16:00:00 +0200",
            "GET", "/api/v1/me", "HTTP/1.1",
            200, "1234", "https://example.com/", "Mozilla/5.0",
        );
        assert_eq!(
            line,
            r#"192.168.1.1 - - [21/May/2026:16:00:00 +0200] "GET /api/v1/me HTTP/1.1" 200 1234 "https://example.com/" "Mozilla/5.0""#
        );
    }

    #[test]
    fn test_format_apache_line_no_referer() {
        let line = format_apache_line(
            "10.0.0.1", "01/Jan/2026:00:00:00 +0000",
            "POST", "/api/v1/auth/login", "HTTP/1.1",
            401, "-", "-", "curl/8.0",
        );
        assert!(line.starts_with("10.0.0.1 - - ["));
        assert!(line.contains(r#""POST /api/v1/auth/login HTTP/1.1" 401 -"#));
        assert!(line.ends_with(r#""-" "curl/8.0""#));
    }

    #[test]
    fn test_format_apache_line_server_error() {
        let line = format_apache_line(
            "127.0.0.1", "01/Jan/2026:12:00:00 +0000",
            "DELETE", "/api/v1/admin/users/123", "HTTP/1.1",
            500, "89", "-", "axios/1.7",
        );
        assert!(line.contains("500 89"));
    }

    #[test]
    fn test_format_apache_line_unknown_ip() {
        let line = format_apache_line(
            "-", "01/Jan/2026:12:00:00 +0000",
            "GET", "/health", "HTTP/1.1",
            200, "42", "-", "-",
        );
        assert!(line.starts_with("- - - ["));
    }

    #[test]
    fn test_map_rotation_variants() {
        assert_eq!(map_rotation(&LogRotation::Daily),  Rotation::DAILY);
        assert_eq!(map_rotation(&LogRotation::Hourly), Rotation::HOURLY);
        assert_eq!(map_rotation(&LogRotation::Never),  Rotation::NEVER);
    }
}
