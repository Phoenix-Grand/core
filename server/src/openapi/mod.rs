//! OpenAPI 3.1 specification of the core API.
//!
//! Generated from `#[utoipa::path]` annotations on the handlers. It drives the
//! generation of native clients (Swift via swift-openapi-generator, Kotlin via
//! the OpenAPI Generator). Modules expose their own spec; the core only
//! documents its own routes here (auth scope first).

use axum::response::{Html, IntoResponse, Json};
use utoipa::{
    openapi::security::{Http, HttpAuthScheme, SecurityScheme},
    Modify, OpenApi,
};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Kubuno Core API",
        description = "API du core Kubuno, consommée par les clients natifs (iOS/Android/Tauri) et le web.",
        license(name = "AGPL-3.0-or-later")
    ),
    paths(
        crate::handlers::auth::register,
        crate::handlers::auth::login,
        crate::handlers::auth::totp_verify,
        crate::handlers::auth::refresh,
        crate::handlers::auth::logout,
        crate::handlers::auth::issue_tickets,
        crate::handlers::users::get_me,
        crate::handlers::users::list_sessions,
        crate::handlers::modules::list_modules,
    ),
    components(schemas(
        crate::models::session::LoginDto,
        crate::models::session::LoginResponse,
        crate::models::session::NativeTokenResponse,
        crate::models::session::RefreshToken,
        crate::handlers::auth::RefreshRequest,
        crate::handlers::auth::TotpVerifyDto,
        crate::handlers::auth::TicketRequest,
        crate::handlers::auth::IssuedTicket,
        crate::handlers::auth::TicketResponse,
        crate::models::user::User,
        crate::models::user::CreateUserDto,
    )),
    tags(
        (name = "auth", description = "Authentification (login/refresh/logout, natif et web)"),
        (name = "me", description = "Profil et sessions de l'utilisateur courant"),
        (name = "modules", description = "Découverte des modules actifs")
    ),
    modifiers(&SecurityAddon)
)]
pub struct ApiDoc;

/// Declares the `bearer` security scheme (Authorization: Bearer <access token | kubuno_… API token>).
struct SecurityAddon;

impl Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        if let Some(components) = openapi.components.as_mut() {
            components.add_security_scheme(
                "bearer",
                SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
            );
        }
    }
}

/// GET /api/v1/openapi.json - sert la spec OpenAPI du core (public).
pub async fn openapi_json() -> impl IntoResponse {
    Json(ApiDoc::openapi())
}

/// GET /api/v1/docs - documentation interactive (Redoc).
///
/// Redoc s'auto-initialise depuis l'élément `<redoc>` : aucun script inline,
/// donc compatible avec la CSP stricte du host (script-src autorise jsdelivr).
pub async fn docs() -> impl IntoResponse {
    Html(
        r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Kubuno API</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <redoc spec-url="/api/v1/openapi.json"></redoc>
    <script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script>
  </body>
</html>"#,
    )
}
