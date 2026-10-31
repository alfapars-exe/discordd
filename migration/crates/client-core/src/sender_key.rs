//! Existing signed Sender Key frame and replay contract; no database side effects.
use super::ratchet::Key;
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SenderKey {
    pub channel_id: String,
    pub sender_user_id: String,
    pub sender_device_id: String,
    pub distribution_id: String,
    pub chain_key: Key,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_chain_key: Option<Key>,
    pub public_signing_key: Key,
    pub iteration: u32,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seen_iterations: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_floor: Option<u32>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wire {
    pub distribution_id: String,
    pub iteration: u32,
    pub ciphertext: String,
}
fn hmac(key: &Key, msg: &[u8]) -> Key {
    let mut mac = <Hmac<sha2::Sha256> as Mac>::new_from_slice(&key.0).expect("fixed HMAC key");
    mac.update(msg);
    Key(mac.finalize().into_bytes().into())
}
fn advance(key: &Key) -> Key {
    hmac(key, &[1])
}
fn message_key(key: &Key) -> Key {
    hmac(key, b"mqvi-e2ee-sk")
}
fn aad(distribution: &str, iteration: u32) -> Vec<u8> {
    format!("{distribution}:{iteration}").into_bytes()
}
pub(crate) fn valid(s: &SenderKey) -> Result<(), &'static str> {
    if [
        &s.channel_id,
        &s.sender_user_id,
        &s.sender_device_id,
        &s.distribution_id,
    ]
    .iter()
    .any(|s| s.is_empty() || s.len() > 256)
        || s.iteration > 1101
        || s.created_at > 9007199254740991
    {
        return Err("invalid_sender_key");
    }
    if s.seen_iterations
        .as_ref()
        .is_some_and(|v| v.len() > 1024 || v.windows(2).any(|w| w[0] >= w[1]))
    {
        return Err("invalid_replay_window");
    }
    Ok(())
}
pub fn encrypt(
    s: &SenderKey,
    signing_seed: &Key,
    plain: &[u8],
    nonce: [u8; 12],
    now: u64,
) -> Result<(SenderKey, Wire), &'static str> {
    valid(s)?;
    if s.protocol_version != Some(2)
        || s.iteration >= 100
        || now.saturating_sub(s.created_at) > 7 * 24 * 60 * 60 * 1000
    {
        return Err("sender_key_rotation_required");
    }
    if plain.len() > 8 * 1024 * 1024 {
        return Err("message_too_large");
    }
    let signing = SigningKey::from_bytes(&signing_seed.0);
    if signing.verifying_key().as_bytes() != &s.public_signing_key.0 {
        return Err("sender_signing_key_mismatch");
    }
    let key = message_key(&s.chain_key);
    let cipher = Aes256Gcm::new_from_slice(&key.0).map_err(|_| "invalid_key")?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plain,
                aad: &aad(&s.distribution_id, s.iteration),
            },
        )
        .map_err(|_| "encryption_failed")?;
    let mut body = nonce.to_vec();
    body.extend(encrypted);
    let signature = signing.sign(&body);
    let mut signed = signature.to_bytes().to_vec();
    signed.extend(body);
    let mut next = s.clone();
    next.chain_key = advance(&s.chain_key);
    next.iteration += 1;
    Ok((
        next,
        Wire {
            distribution_id: s.distribution_id.clone(),
            iteration: s.iteration,
            ciphertext: B64.encode(signed),
        },
    ))
}
pub fn decrypt(
    s: &SenderKey,
    wire: &Wire,
) -> Result<(SenderKey, Zeroizing<Vec<u8>>), &'static str> {
    valid(s)?;
    if wire.distribution_id != s.distribution_id || wire.iteration > 1100 {
        return Err("invalid_sender_key_frame");
    }
    if wire.iteration < s.replay_floor.unwrap_or(0)
        || s.seen_iterations
            .as_ref()
            .is_some_and(|v| v.binary_search(&wire.iteration).is_ok())
    {
        return Err("sender_key_replay");
    }
    if wire.ciphertext.len() > 24 * 1024 * 1024 {
        return Err("message_too_large");
    }
    let data = B64
        .decode(&wire.ciphertext)
        .map_err(|_| "invalid_sender_key_frame")?;
    if data.len() < 92 {
        return Err("unsigned_or_truncated_sender_key_frame");
    }
    let public = VerifyingKey::from_bytes(&s.public_signing_key.0)
        .map_err(|_| "invalid_sender_key_signature")?;
    public
        .verify_strict(
            &data[64..],
            &Signature::from_slice(&data[..64]).map_err(|_| "invalid_sender_key_signature")?,
        )
        .map_err(|_| "invalid_sender_key_signature")?;
    let out_of_order = wire.iteration < s.iteration;
    let (mut ck, start) = if out_of_order {
        (
            s.initial_chain_key
                .clone()
                .ok_or("sender_key_anchor_missing")?,
            0,
        )
    } else {
        (s.chain_key.clone(), s.iteration)
    };
    for _ in start..wire.iteration {
        ck = advance(&ck)
    }
    let key = message_key(&ck);
    let cipher = Aes256Gcm::new_from_slice(&key.0).map_err(|_| "invalid_key")?;
    let plain = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&data[64..76]),
                Payload {
                    msg: &data[76..],
                    aad: &aad(&wire.distribution_id, wire.iteration),
                },
            )
            .map_err(|_| "message_authentication_failed")?,
    );
    let mut next = s.clone();
    if !out_of_order {
        next.chain_key = advance(&ck);
        next.iteration = wire.iteration + 1;
    }
    let seen = next.seen_iterations.get_or_insert_with(Vec::new);
    let at = seen.binary_search(&wire.iteration).unwrap_err();
    seen.insert(at, wire.iteration);
    if seen.len() > 1024 {
        let evicted = seen.remove(0);
        next.replay_floor = Some(next.replay_floor.unwrap_or(0).max(evicted + 1));
    }
    Ok((next, plain))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_signed_frames_and_receive_only_legacy_state_match() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../protocol/fixtures/sender-key.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let state: SenderKey = serde_json::from_value(case["state"].clone()).unwrap();
            let wire: Wire = serde_json::from_value(case["wire"].clone()).unwrap();
            let next = if case["operation"] == "encrypt" {
                let raw = B64.decode(&wire.ciphertext).unwrap();
                let seed: Key = serde_json::from_value(case["seed"].clone()).unwrap();
                let (next, actual) = encrypt(
                    &state,
                    &seed,
                    case["plaintext"].as_str().unwrap().as_bytes(),
                    raw[64..76].try_into().unwrap(),
                    state.created_at,
                )
                .unwrap();
                assert_eq!(serde_json::to_value(actual).unwrap(), case["wire"]);
                next
            } else {
                let (next, plain) = decrypt(&state, &wire).unwrap();
                assert_eq!(&*plain, case["plaintext"].as_str().unwrap().as_bytes());
                next
            };
            assert_eq!(serde_json::to_value(next).unwrap(), case["next"]);
        }
    }
    #[test]
    fn signatures_replays_rotation_and_failed_auth_do_not_advance_state() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../protocol/fixtures/sender-key.json")).unwrap();
        let case = &fixture["cases"][3];
        let state: SenderKey = serde_json::from_value(case["state"].clone()).unwrap();
        let before = serde_json::to_value(&state).unwrap();
        let wire: Wire = serde_json::from_value(case["wire"].clone()).unwrap();
        let mut damaged = wire.clone();
        let mut data = B64.decode(&damaged.ciphertext).unwrap();
        data[0] ^= 1;
        damaged.ciphertext = B64.encode(data);
        assert!(decrypt(&state, &damaged).is_err());
        assert_eq!(serde_json::to_value(&state).unwrap(), before);
        let (next, _) = decrypt(&state, &wire).unwrap();
        assert!(decrypt(&next, &wire).is_err());
        let mut invalid = wire.clone();
        invalid.iteration = 1101;
        assert!(decrypt(&state, &invalid).is_err());
        let mut outbound: SenderKey =
            serde_json::from_value(fixture["cases"][0]["state"].clone()).unwrap();
        let seed: Key = serde_json::from_value(fixture["cases"][0]["seed"].clone()).unwrap();
        outbound.iteration = 100;
        assert!(encrypt(&outbound, &seed, b"rotate", [1; 12], outbound.created_at).is_err());
        outbound.iteration = 0;
        outbound.protocol_version = Some(1);
        assert!(
            encrypt(
                &outbound,
                &seed,
                b"legacy outbound",
                [1; 12],
                outbound.created_at
            )
            .is_err()
        );
    }
}
