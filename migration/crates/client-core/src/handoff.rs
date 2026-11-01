//! Target-bound handoff envelope. Source retirement is a storage protocol, not
//! inferred from decrypting an ordinary recovery backup.
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub version: u32,
    pub intent_id: String,
    pub owner: String,
    pub backend: String,
    pub public_key: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capsule {
    pub version: u32,
    pub intent_id: String,
    pub owner: String,
    pub backend: String,
    pub source_device_id: String,
    pub target_public_key: String,
    pub ephemeral_key: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}
pub fn public_key(private: &[u8]) -> Result<String, String> {
    let p: [u8; 32] = private.try_into().map_err(|_| "invalid_transfer_key")?;
    Ok(B64.encode(PublicKey::from(&StaticSecret::from(p)).as_bytes()))
}
pub fn open(json: &str, private: &[u8], intent_json: &str) -> Result<Zeroizing<String>, String> {
    if json.len() > 96 * 1024 * 1024 {
        return Err("capsule_too_large".into());
    }
    let c: Capsule = serde_json::from_str(json).map_err(|_| "invalid_capsule")?;
    let i: Intent = serde_json::from_str(intent_json).map_err(|_| "invalid_intent")?;
    if c.version != 1
        || i.version != 1
        || c.intent_id != i.intent_id
        || c.owner != i.owner
        || c.backend != i.backend
        || c.target_public_key != i.public_key
        || public_key(private)? != i.public_key
    {
        return Err("transfer_scope_mismatch".into());
    }
    let ephemeral = super::ratchet::key(&c.ephemeral_key).map_err(str::to_owned)?;
    let secret =
        StaticSecret::from(<[u8; 32]>::try_from(private).map_err(|_| "invalid_transfer_key")?)
            .diffie_hellman(&PublicKey::from(ephemeral.0));
    if !secret.was_contributory() {
        return Err("invalid_transfer_key".into());
    }
    let salt = B64.decode(&c.salt).map_err(|_| "invalid_capsule")?;
    let nonce = B64.decode(&c.nonce).map_err(|_| "invalid_capsule")?;
    if salt.len() != 32 || nonce.len() != 12 {
        return Err("invalid_capsule".into());
    }
    let aad = serde_json::to_vec(&serde_json::json!([
        "hichat-device-handoff-v1",
        c.intent_id,
        c.owner,
        c.backend,
        c.source_device_id,
        c.target_public_key,
        c.ephemeral_key,
        c.salt
    ]))
    .unwrap();
    let mut key = Zeroizing::new([0u8; 32]);
    hkdf::Hkdf::<sha2::Sha256>::new(Some(&salt), secret.as_bytes())
        .expand(&aad, &mut *key)
        .map_err(|_| "invalid_kdf")?;
    let data = B64.decode(&c.ciphertext).map_err(|_| "invalid_capsule")?;
    let plain = Zeroizing::new(
        Aes256Gcm::new_from_slice(&*key)
            .map_err(|_| "invalid_key")?
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &data,
                    aad: &aad,
                },
            )
            .map_err(|_| "capsule_authentication_failed")?,
    );
    let text =
        Zeroizing::new(String::from_utf8(plain.to_vec()).map_err(|_| "invalid_capsule_contents")?);
    let value: Value = serde_json::from_str(&text).map_err(|_| "invalid_capsule_contents")?;
    validate(&value, &c.owner, &c.source_device_id, &c.intent_id)?;
    Ok(text)
}
pub fn validate(v: &Value, owner: &str, device: &str, intent: &str) -> Result<(), String> {
    if v["retirement"]["state"] != "retired"
        || v["retirement"]["intentId"] != intent
        || v["retirement"]["databaseVersion"] != 2
    {
        return Err("source_retirement_required".into());
    }
    let stores = v["stores"].as_object().ok_or("invalid_snapshot")?;
    let entries = |name: &str| {
        stores
            .get(name)
            .and_then(Value::as_array)
            .ok_or("invalid_snapshot")
    };
    let primary = |name: &str| -> Result<Value, String> {
        Ok(entries(name)?
            .iter()
            .find(|e| e["key"] == "primary")
            .ok_or("snapshot_identity_missing")?["value"]
            .clone())
    };
    let registration = primary("registration")?;
    if registration["userId"] != owner || registration["deviceId"] != device {
        return Err("snapshot_account_mismatch".into());
    }
    let identity: super::ratchet::KeyPair =
        serde_json::from_value(primary("identity")?).map_err(|_| "invalid_identity")?;
    super::ratchet::validate_pair(&identity).map_err(str::to_owned)?;
    let signing: super::ratchet::KeyPair =
        serde_json::from_value(primary("signing")?).map_err(|_| "invalid_signing_identity")?;
    if ed25519_dalek::SigningKey::from_bytes(&signing.private_key.0)
        .verifying_key()
        .as_bytes()
        != &signing.public_key.0
    {
        return Err("invalid_signing_identity".into());
    }
    for row in entries("sessions")? {
        let state: super::ratchet::Session =
            serde_json::from_value(row["value"]["state"].clone()).map_err(|_| "invalid_session")?;
        super::ratchet::validate_state(&state).map_err(str::to_owned)?;
    }
    for name in ["signedPreKeys", "preKeys"] {
        for row in entries(name)? {
            let value = &row["value"];
            let pair = super::ratchet::KeyPair {
                public_key: serde_json::from_value(value["publicKey"].clone())
                    .map_err(|_| "invalid_prekey")?,
                private_key: serde_json::from_value(value["privateKey"].clone())
                    .map_err(|_| "invalid_prekey")?,
            };
            super::ratchet::validate_pair(&pair).map_err(str::to_owned)?;
            if name == "signedPreKeys" {
                let bytes = B64
                    .decode(
                        value["signature"]["__b64"]
                            .as_str()
                            .ok_or("invalid_prekey")?,
                    )
                    .map_err(|_| "invalid_prekey")?;
                let sig =
                    ed25519_dalek::Signature::from_slice(&bytes).map_err(|_| "invalid_prekey")?;
                ed25519_dalek::VerifyingKey::from_bytes(&signing.public_key.0)
                    .map_err(|_| "invalid_signing_identity")?
                    .verify_strict(&pair.public_key.0, &sig)
                    .map_err(|_| "invalid_prekey_signature")?;
            }
        }
    }
    for row in entries("senderKeys")? {
        let state: super::sender_key::SenderKey =
            serde_json::from_value(row["value"].clone()).map_err(|_| "invalid_sender_key")?;
        super::sender_key::valid(&state).map_err(str::to_owned)?;
    }
    Ok(())
}
/// The legacy own-device list exposes the signed prekey, not signing_key.
/// Verify the imported signing identity against that authenticated signature.
pub fn verify_roster(snapshot: &str, roster: &str) -> Result<(), String> {
    let v: Value = serde_json::from_str(snapshot).map_err(|_| "invalid_snapshot")?;
    let rows: Vec<Value> = serde_json::from_str(roster).map_err(|_| "invalid_roster")?;
    let primary = |name: &str| -> Result<&Value, String> {
        v["stores"][name]
            .as_array()
            .and_then(|a| a.iter().find(|r| r["key"] == "primary"))
            .map(|r| &r["value"])
            .ok_or("invalid_snapshot".into())
    };
    let reg = primary("registration")?;
    let identity: super::ratchet::KeyPair =
        serde_json::from_value(primary("identity")?.clone()).map_err(|_| "invalid_identity")?;
    let signing: super::ratchet::KeyPair =
        serde_json::from_value(primary("signing")?.clone()).map_err(|_| "invalid_identity")?;
    let row = rows
        .iter()
        .find(|r| {
            r["device_id"] == reg["deviceId"]
                && r["user_id"] == reg["userId"]
                && r["identity_key"] == B64.encode(identity.public_key.0)
        })
        .ok_or("registered_device_mismatch")?;
    let decode = |field: &str| {
        B64.decode(row[field].as_str().ok_or("invalid_roster")?)
            .map_err(|_| "invalid_roster")
    };
    let prekey = decode("signed_prekey")?;
    if prekey.len() != 32 {
        return Err("invalid_roster".into());
    }
    let signature = ed25519_dalek::Signature::from_slice(&decode("signed_prekey_signature")?)
        .map_err(|_| "invalid_roster")?;
    ed25519_dalek::VerifyingKey::from_bytes(&signing.public_key.0)
        .map_err(|_| "invalid_signing_identity")?
        .verify_strict(&prekey, &signature)
        .map_err(|_| "registered_device_mismatch".into())
}
/// Atomic-store caller persists the entire returned snapshot before returning
/// the request to a network dispatcher. Repeating an ID returns identical bytes.
pub fn prepare_peer(
    json: &str,
    user: &str,
    device: &str,
    id: &str,
    plaintext: &str,
    nonce: &[u8],
) -> Result<String, String> {
    use sha2::Digest;
    if json.len() > 96 * 1024 * 1024 || id.len() < 16 || id.len() > 128 {
        return Err("invalid_pending_request".into());
    }
    let mut v: Value = serde_json::from_str(json).map_err(|_| "invalid_snapshot")?;
    let hash = format!(
        "{:x}",
        sha2::Sha256::digest(
            serde_json::to_vec(&serde_json::json!([user, device, plaintext])).unwrap()
        )
    );
    if let Some(existing) = v["preparedPeerSends"]
        .as_array()
        .and_then(|a| a.iter().find(|r| r["id"] == id))
    {
        if existing["hash"] != hash {
            return Err("pending_request_conflict".into());
        }
        return serde_json::to_string(&serde_json::json!({"snapshot":v,"request":existing}))
            .map_err(|_| "invalid_snapshot".into());
    }
    let rows = v["stores"]["sessions"]
        .as_array_mut()
        .ok_or("invalid_snapshot")?;
    let row = rows
        .iter_mut()
        .find(|r| r["value"]["userId"] == user && r["value"]["deviceId"] == device)
        .ok_or("session_missing")?;
    let state: super::ratchet::Session =
        serde_json::from_value(row["value"]["state"].clone()).map_err(|_| "invalid_session")?;
    let (next, mut wire) = super::ratchet::encrypt(
        &state,
        plaintext.as_bytes(),
        nonce.try_into().map_err(|_| "invalid_nonce")?,
    )
    .map_err(str::to_owned)?;
    row["value"]["state"] = serde_json::to_value(next).map_err(|_| "invalid_session")?;
    let meta = v["stores"]["metadata"]
        .as_array_mut()
        .ok_or("invalid_snapshot")?;
    if let Some(info) = meta
        .iter_mut()
        .find(|r| r["key"] == format!("prekey_info:{user}:{device}") && !r["value"].is_null())
    {
        wire.r#type = 3;
        wire.pre_key_info = Some(
            serde_json::from_value(info["value"].clone()).map_err(|_| "invalid_prekey_metadata")?,
        );
        info["value"] = Value::Null;
    }
    let request =
        serde_json::json!({"id":id,"hash":hash,"userId":user,"deviceId":device,"wire":wire});
    if v["preparedPeerSends"].is_null() {
        v["preparedPeerSends"] = serde_json::json!([])
    }
    let pending = v["preparedPeerSends"]
        .as_array_mut()
        .ok_or("invalid_pending_request")?;
    if pending.len() >= 10000 {
        return Err("pending_queue_full".into());
    }
    pending.push(request.clone());
    serde_json::to_string(&serde_json::json!({"snapshot":v,"request":request}))
        .map_err(|_| "invalid_snapshot".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn bytes(data: &[u8]) -> Value {
        json!({"__b64":B64.encode(data)})
    }
    fn snapshot() -> Value {
        let fixture: Value =
            serde_json::from_str(include_str!("../../protocol/fixtures/ratchet.json")).unwrap();
        let private = [10u8; 32];
        let public = PublicKey::from(&StaticSecret::from(private));
        let signing = ed25519_dalek::SigningKey::from_bytes(&[11u8; 32]);
        json!({"stores":{
   "registration":[{"key":"primary","value":{"userId":"owner","deviceId":"device"}}],
   "identity":[{"key":"primary","value":{"privateKey":bytes(&private),"publicKey":bytes(public.as_bytes())}}],
   "signing":[{"key":"primary","value":{"privateKey":bytes(&[11u8;32]),"publicKey":bytes(signing.verifying_key().as_bytes())}}],
   "sessions":[{"key":"peer:peer-device","value":{"userId":"peer","deviceId":"peer-device","state":fixture["cases"][0]["state"]}}],
   "signedPreKeys":[],"preKeys":[],"senderKeys":[],"metadata":[],"trustedIdentities":[],"messageCache":[]},
   "portablePending":[],"preferences":{},"retirement":{"state":"retired","databaseVersion":2,"intentId":"intent"}})
    }
    fn envelope(payload: &Value) -> (Value, Value) {
        let target = public_key(&[9; 32]).unwrap();
        let ephemeral = StaticSecret::from([8; 32]);
        let ep = PublicKey::from(&ephemeral);
        let salt = B64.encode([7; 32]);
        let intent = json!({"version":1,"intentId":"intent","owner":"owner","backend":"https://test.invalid","publicKey":target});
        let aad = serde_json::to_vec(&json!([
            "hichat-device-handoff-v1",
            "intent",
            "owner",
            "https://test.invalid",
            "device",
            target,
            B64.encode(ep.as_bytes()),
            salt
        ]))
        .unwrap();
        let shared = ephemeral.diffie_hellman(&PublicKey::from(
            <[u8; 32]>::try_from(B64.decode(&target).unwrap()).unwrap(),
        ));
        let mut key = [0u8; 32];
        hkdf::Hkdf::<sha2::Sha256>::new(Some(&[7; 32]), shared.as_bytes())
            .expand(&aad, &mut key)
            .unwrap();
        let encrypted = Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .encrypt(
                Nonce::from_slice(&[6; 12]),
                Payload {
                    msg: &serde_json::to_vec(payload).unwrap(),
                    aad: &aad,
                },
            )
            .unwrap();
        (
            intent,
            json!({"version":1,"intentId":"intent","owner":"owner","backend":"https://test.invalid","sourceDeviceId":"device","targetPublicKey":target,"ephemeralKey":B64.encode(ep.as_bytes()),"salt":salt,"nonce":B64.encode([6;12]),"ciphertext":B64.encode(encrypted)}),
        )
    }
    #[test]
    fn capsule_requires_target_scope_authenticated_bytes_and_source_retirement() {
        let (i, c) = envelope(&snapshot());
        assert!(open(&c.to_string(), &[9; 32], &i.to_string()).is_ok());
        assert!(open(&c.to_string(), &[10; 32], &i.to_string()).is_err());
        for field in [
            "owner",
            "backend",
            "sourceDeviceId",
            "intentId",
            "ciphertext",
        ] {
            let mut changed = c.clone();
            changed[field] = json!("tampered");
            assert!(
                open(&changed.to_string(), &[9; 32], &i.to_string()).is_err(),
                "{field}"
            );
        }
        let mut v = snapshot();
        v["retirement"]["state"] = json!("frozen");
        let (i, c) = envelope(&v);
        assert_eq!(
            open(&c.to_string(), &[9; 32], &i.to_string())
                .unwrap_err()
                .as_str(),
            "source_retirement_required"
        );
    }
    #[test]
    fn durable_preparation_retries_identically_and_advances_only_for_new_ids() {
        let first: Value = serde_json::from_str(
            &prepare_peer(
                &snapshot().to_string(),
                "peer",
                "peer-device",
                "request-00000001",
                "hello",
                &[1; 12],
            )
            .unwrap(),
        )
        .unwrap();
        let next = first["snapshot"].to_string();
        let retry: Value = serde_json::from_str(
            &prepare_peer(
                &next,
                "peer",
                "peer-device",
                "request-00000001",
                "hello",
                &[2; 12],
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(first, retry);
        assert!(
            prepare_peer(
                &next,
                "peer",
                "peer-device",
                "request-00000001",
                "different",
                &[2; 12]
            )
            .is_err()
        );
        let second: Value = serde_json::from_str(
            &prepare_peer(
                &next,
                "peer",
                "peer-device",
                "request-00000002",
                "again",
                &[2; 12],
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(second["request"]["wire"]["header"]["messageNumber"], 1);
    }
    #[test]
    fn authenticated_roster_must_match_identity_and_signing_key() {
        use ed25519_dalek::Signer;
        let v = snapshot();
        let prekey = PublicKey::from(&StaticSecret::from([12; 32]));
        let signer = ed25519_dalek::SigningKey::from_bytes(&[11; 32]);
        let mut roster = json!([{"device_id":"device","user_id":"owner","identity_key":v["stores"]["identity"][0]["value"]["publicKey"]["__b64"],"signed_prekey":B64.encode(prekey.as_bytes()),"signed_prekey_signature":B64.encode(signer.sign(prekey.as_bytes()).to_bytes())}]);
        verify_roster(&v.to_string(), &roster.to_string()).unwrap();
        roster[0]["user_id"] = json!("different");
        assert!(verify_roster(&v.to_string(), &roster.to_string()).is_err());
    }
}
