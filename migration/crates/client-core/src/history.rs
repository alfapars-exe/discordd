use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const MAX_BACKUP_BYTES: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
struct Envelope {
    version: u32,
    algorithm: String,
    encrypted_data: String,
    nonce: String,
    salt: String,
}
#[derive(Deserialize)]
struct Registration {
    #[serde(rename = "userId")]
    user_id: String,
}
#[derive(Deserialize)]
struct Contents {
    version: u32,
    registration: Registration,
    #[serde(default, rename = "messageCache")]
    messages: Vec<HistoryMessage>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub message_id: String,
    pub channel_id: String,
    pub dm_channel_id: Option<String>,
    pub content: String,
    pub timestamp: f64,
}

fn iterations(algorithm: &str) -> Result<u32, &'static str> {
    if algorithm == "aes-256-gcm" {
        return Ok(1_000_000);
    }
    let count = algorithm
        .strip_prefix("aes-256-gcm+pbkdf2-")
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or("unsupported_backup_algorithm")?;
    if !(600_000..=10_000_000).contains(&count) {
        return Err("invalid_backup_iterations");
    }
    Ok(count)
}

/// Reads the existing recovery backup without importing device identity or sending keys.
/// Only cached plaintext history is returned. Unknown ciphertext cannot be decrypted here.
pub fn restore_history(
    backup_json: String,
    password: String,
    owner: String,
) -> Result<String, String> {
    restore(&backup_json, Zeroizing::new(password), &owner).map_err(str::to_owned)
}

fn restore(json: &str, password: Zeroizing<String>, owner: &str) -> Result<String, &'static str> {
    if owner.is_empty() || owner.len() > 256 {
        return Err("invalid_account_scope");
    }
    if json.len() > MAX_BACKUP_BYTES * 2 {
        return Err("backup_too_large");
    }
    let envelope: Envelope = serde_json::from_str(json).map_err(|_| "invalid_backup")?;
    if envelope.version != 1 {
        return Err("unsupported_backup_version");
    }
    let count = iterations(&envelope.algorithm)?;
    let salt = STANDARD
        .decode(&envelope.salt)
        .map_err(|_| "invalid_backup")?;
    let nonce = STANDARD
        .decode(&envelope.nonce)
        .map_err(|_| "invalid_backup")?;
    let ciphertext = STANDARD
        .decode(&envelope.encrypted_data)
        .map_err(|_| "invalid_backup")?;
    if salt.len() != 32 || nonce.len() != 12 || ciphertext.len() < 16 {
        return Err("invalid_backup");
    }
    if ciphertext.len() > MAX_BACKUP_BYTES {
        return Err("backup_too_large");
    }
    let mut key = Zeroizing::new([0_u8; 32]);
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), &salt, count, &mut *key);
    let cipher = Aes256Gcm::new_from_slice(&*key).map_err(|_| "invalid_backup")?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|_| "backup_authentication_failed")?,
    );
    // Typed deserialization ignores all private identity/session material.
    let contents: Contents =
        serde_json::from_slice(&plaintext).map_err(|_| "invalid_backup_contents")?;
    if contents.version != 1 || contents.registration.user_id != owner {
        return Err("backup_account_mismatch");
    }
    if contents.messages.len() > 100_000
        || contents.messages.iter().any(|m| !m.timestamp.is_finite())
    {
        return Err("invalid_backup_contents");
    }
    serde_json::to_string(&contents.messages).map_err(|_| "invalid_backup_contents")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_algorithms_and_kdf_abuse_before_derivation() {
        assert_eq!(iterations("aes-256-gcm"), Ok(1_000_000));
        assert_eq!(iterations("aes-256-gcm+pbkdf2-2000000"), Ok(2_000_000));
        assert!(iterations("aes-256-gcm+pbkdf2-1").is_err());
        assert!(iterations("aes-256-gcm+pbkdf2-10000001").is_err());
        assert!(iterations("unknown").is_err());
    }
    #[test]
    fn reads_both_legacy_and_current_default_webcrypto_backups() {
        for fixture in [
            include_str!("../../protocol/fixtures/history-legacy.json"),
            include_str!("../../protocol/fixtures/history-current.json"),
        ] {
            let history = restore_history(
                fixture.into(),
                "test-recovery-İstanbul".into(),
                "fixture-user".into(),
            )
            .unwrap();
            assert!(history.contains("Geçmiş mesaj"));
            assert!(!history.contains("privateKey"));
        }
    }
    #[test]
    fn reads_webcrypto_fixture_and_rejects_wrong_owner_password_and_tampering() {
        let fixture = include_str!("../../protocol/fixtures/history-backup.json");
        let history = restore_history(
            fixture.into(),
            "test-recovery-İstanbul".into(),
            "fixture-user".into(),
        )
        .unwrap();
        let messages: Vec<HistoryMessage> = serde_json::from_str(&history).unwrap();
        assert_eq!(messages[0].content, "Geçmiş mesaj: şğıöçü 👋");
        assert!(!history.contains("privateKey"));
        assert_eq!(
            restore_history(fixture.into(), "wrong".into(), "fixture-user".into()).unwrap_err(),
            "backup_authentication_failed"
        );
        assert_eq!(
            restore_history(
                fixture.into(),
                "test-recovery-İstanbul".into(),
                "other-user".into()
            )
            .unwrap_err(),
            "backup_account_mismatch"
        );
        let mut altered: serde_json::Value = serde_json::from_str(fixture).unwrap();
        altered["encrypted_data"] = serde_json::Value::String("AAAA".into());
        assert!(
            restore_history(
                altered.to_string(),
                "test-recovery-İstanbul".into(),
                "fixture-user".into()
            )
            .is_err()
        );
    }
}
