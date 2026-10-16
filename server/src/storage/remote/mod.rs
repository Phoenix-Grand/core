//! Connecteurs de stockage distant - CENTRALISÉS dans le core.
//! Un montage distant (webdav, nextcloud, owncloud, sftp, ftp, smb, nfs, gdrive,
//! dropbox) est exposé via le trait `RemoteConnector`. Le frontend (module drive)
//! y accède en proxifiant vers le core. Cf. [[project_storage_centralization]].

pub mod connector;
pub mod webdav;
pub mod sftp;
pub mod ftp;
pub mod gdrive;
pub mod dropbox;
pub mod smb;
pub mod nfs;
pub mod service;

pub use connector::{
    ByteStream, ConnectorConfig, RemoteConnector, RemoteEntry, RemoteEntryType, RemoteError, RemoteQuota,
};
pub use service::RemoteMountService;

use std::sync::Arc;

/// Fabrique un connecteur à partir du `provider` et de sa configuration déchiffrée.
pub fn build_connector(
    provider: &str,
    config: &ConnectorConfig,
) -> Result<Arc<dyn RemoteConnector>, RemoteError> {
    match provider {
        "webdav" | "nextcloud" | "owncloud" => Ok(Arc::new(webdav::WebDavConnector::new(config)?)),
        "sftp"    => Ok(Arc::new(sftp::SftpConnector::new(config)?)),
        "ftp"     => Ok(Arc::new(ftp::FtpConnector::new(config)?)),
        "gdrive"  => Ok(Arc::new(gdrive::GDriveConnector::new(config)?)),
        "dropbox" => Ok(Arc::new(dropbox::DropboxConnector::new(config)?)),
        "smb"     => Ok(Arc::new(smb::SmbConnector::new(config)?)),
        "nfs"     => Ok(Arc::new(nfs::NfsConnector::new(config)?)),
        p => Err(RemoteError::Unsupported(format!("Provider '{p}' non supporté"))),
    }
}
