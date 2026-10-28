//! Metadata export for catalog publishers; no instance, credentials or network.
use anyhow::{bail, Context, Result};
use kubuno_core::modules::marketplace::metadata::{read_manifest, PublisherMetadata};
use std::path::Path;

pub async fn export(sub: &clap::ArgMatches) -> Result<()> {
    let source = read_manifest(Path::new(sub.get_one::<String>("manifest").unwrap())).await?;
    let metadata = PublisherMetadata::parse(&source)?;
    let output = if let Some(path) = sub.get_one::<String>("catalog") {
        let mut catalog: serde_json::Value = serde_json::from_slice(&tokio::fs::read(path).await?)
            .context("Invalid catalog JSON")?;
        if let Some(metadata) = metadata {
            if metadata.merge_catalog(&mut catalog) == 0 {
                bail!("Catalog has no entry matching module {} version {}", metadata.id, metadata.version);
            }
        }
        catalog
    } else {
        serde_json::to_value(metadata)?
    };
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}
