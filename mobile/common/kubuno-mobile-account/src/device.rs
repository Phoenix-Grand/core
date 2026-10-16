//! The device key and the account book: what the phone remembers about itself and its accounts, next to the secrets.
//!
//! - The **device key** is a random identifier generated once per installation and sent on every request
//!   (`X-Kubuno-Device-Key`), so the server's device inventory recognises this phone across sessions.
//! - The **account book** lists the accounts signed in on this phone (server, user, label, device key) — most recent
//!   first — so the app can restore the last session at launch. It holds no secret (the refresh tokens are stored
//!   separately, one per account), but lives in the same OS store for simplicity: it is small, and the platform
//!   keystore is the only storage the account layer is given.

use crate::model::Account;
use crate::secret::SecretStore;
use crate::AccountError;

const DEVICE_KEY: &str = "kubuno.device_key";
const BOOK_KEY: &str = "kubuno.accounts";

/// This installation's device key, generated (a random UUID) and stored on first use.
pub fn device_key(store: &dyn SecretStore) -> Result<String, AccountError> {
    if let Some(key) = store.load(DEVICE_KEY)?.filter(|k| !k.is_empty()) {
        return Ok(key);
    }
    let key = uuid::Uuid::new_v4().to_string();
    store.store(DEVICE_KEY, &key)?;
    Ok(key)
}

/// The accounts signed in on this phone, most recent first. An unreadable book is treated as empty (and logged), so a
/// corrupted entry never locks the user out of signing in again.
pub fn accounts(store: &dyn SecretStore) -> Result<Vec<Account>, AccountError> {
    let Some(json) = store.load(BOOK_KEY)? else { return Ok(Vec::new()) };
    match serde_json::from_str(&json) {
        Ok(list) => Ok(list),
        Err(e) => {
            tracing::error!("unreadable account book, starting afresh: {e}");
            Ok(Vec::new())
        }
    }
}

/// Remember `account` as the most recent one (replacing its previous entry).
pub fn remember(store: &dyn SecretStore, account: &Account) -> Result<(), AccountError> {
    let mut list = accounts(store)?;
    list.retain(|a| !(a.server == account.server && a.user_id == account.user_id));
    list.insert(0, account.clone());
    save(store, &list)
}

/// Remove an account from the book.
pub fn forget_account(store: &dyn SecretStore, server: &str, user_id: &str) -> Result<(), AccountError> {
    let mut list = accounts(store)?;
    list.retain(|a| !(a.server == server && a.user_id == user_id));
    save(store, &list)
}

fn save(store: &dyn SecretStore, list: &[Account]) -> Result<(), AccountError> {
    let json = serde_json::to_string(list).map_err(|e| AccountError::Protocol(format!("account book: {e}")))?;
    store.store(BOOK_KEY, &json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::MemorySecretStore;

    fn account(user: &str) -> Account {
        Account { server: "https://k.test".into(), user_id: user.into(), label: user.into(), device_key: "d".into() }
    }

    #[test]
    fn the_device_key_is_generated_once() {
        let s = MemorySecretStore::new();
        let k = device_key(&s).unwrap();
        assert_eq!(k.len(), 36);
        assert_eq!(device_key(&s).unwrap(), k);
    }

    #[test]
    fn the_book_keeps_the_most_recent_account_first() {
        let s = MemorySecretStore::new();
        assert!(accounts(&s).unwrap().is_empty());
        remember(&s, &account("a")).unwrap();
        remember(&s, &account("b")).unwrap();
        remember(&s, &account("a")).unwrap();
        let ids: Vec<_> = accounts(&s).unwrap().into_iter().map(|a| a.user_id).collect();
        assert_eq!(ids, ["a", "b"]);
        forget_account(&s, "https://k.test", "a").unwrap();
        assert_eq!(accounts(&s).unwrap().len(), 1);
        s.store(BOOK_KEY, "not json").unwrap();
        assert!(accounts(&s).unwrap().is_empty(), "a corrupted book reads as empty");
    }
}
