pub mod alerts;
pub mod audit;
pub mod auth;
pub mod authz;
pub mod backup;
pub mod collab;
pub mod logging;
pub mod config;
pub mod maintenance;
pub mod crypto;
pub mod data_export;
/// Importing an organisation's data from a third-party provider - the core
/// orchestrates, the module that owns the destination does the copying.
pub mod data_migration;
pub mod database;
pub mod devices;
pub mod directory;
pub mod domains;
pub mod errors;
pub mod events;
pub mod handlers;
pub mod health;
pub mod holidays;
pub mod jobs;
pub mod mailer;
pub mod middleware;
pub mod models;
pub mod modules;
pub mod network;
pub mod openapi;
pub mod push;
pub mod router;
pub mod rules;
pub mod settings;
pub mod setup;
pub mod state;
pub mod storage;
/// The licence this software carries, and the support contract an instance may
/// have bought for it - two different things (`support/mod.rs` says why).
pub mod support;
pub mod websocket;
