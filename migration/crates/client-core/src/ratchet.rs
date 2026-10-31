//! Existing HiChat DM chain/DH ratchet contract. Pure transitions: the caller must
//! durably commit the returned state BEFORE releasing outbound ciphertext.
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, PartialEq, Eq)]
pub struct Key(pub(crate) [u8; 32]);
impl Drop for Key {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
impl Serialize for Key {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("Key", 1)?;
        let encoded = Zeroizing::new(B64.encode(self.0));
        st.serialize_field("__b64", &*encoded)?;
        st.end()
    }
}
impl<'de> Deserialize<'de> for Key {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wrapped {
            __b64: String,
        }
        let v = Wrapped::deserialize(d)?;
        let encoded = Zeroizing::new(v.__b64);
        if encoded.len() != 44 {
            return Err(serde::de::Error::custom("invalid_key_length"));
        }
        let bytes = Zeroizing::new(
            B64.decode(encoded.as_bytes())
                .map_err(serde::de::Error::custom)?,
        );
        Ok(Self(bytes.as_slice().try_into().map_err(|_| {
            serde::de::Error::custom("invalid_key_length")
        })?))
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyPair {
    pub public_key: Key,
    pub private_key: Key,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Skipped {
    pub ratchet_key: String,
    pub message_number: u32,
    pub message_key: Key,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub root_key: Key,
    pub sending_chain_key: Option<Key>,
    pub receiving_chain_key: Option<Key>,
    pub sending_ratchet_key_pair: KeyPair,
    pub receiving_ratchet_key: Option<Key>,
    pub send_message_number: u32,
    pub receive_message_number: u32,
    pub previous_send_chain_length: u32,
    pub skipped_message_keys: Vec<Skipped>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Header {
    pub ratchet_key: String,
    pub previous_chain_length: u32,
    pub message_number: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wire {
    pub r#type: u8,
    pub header: Header,
    pub ciphertext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_key_info: Option<super::x3dh::PreKeyInfo>,
}

pub(crate) fn key(s: &str) -> Result<Key, &'static str> {
    if s.len() != 44 {
        return Err("invalid_key");
    }
    let b = Zeroizing::new(B64.decode(s).map_err(|_| "invalid_key")?);
    Ok(Key(b.as_slice().try_into().map_err(|_| "invalid_key")?))
}
fn chain(k: &Key) -> (Key, Key) {
    let mac = |byte| {
        let mut h = <Hmac<Sha256> as Mac>::new_from_slice(&k.0).expect("fixed HMAC key");
        h.update(&[byte]);
        Key(h.finalize().into_bytes().into())
    };
    (mac(1), mac(2))
}
pub(crate) fn root(root: &Key, private: &Key, public: &Key) -> Result<(Key, Key), &'static str> {
    let secret = StaticSecret::from(private.0).diffie_hellman(&PublicKey::from(public.0));
    if !secret.was_contributory() {
        return Err("invalid_dh_public_key");
    }
    let mut out = Zeroizing::new([0u8; 64]);
    hkdf::Hkdf::<Sha256>::new(Some(&root.0), secret.as_bytes())
        .expand(b"mqvi-e2ee-rk", &mut *out)
        .map_err(|_| "invalid_kdf")?;
    Ok((
        Key(out[..32].try_into().unwrap()),
        Key(out[32..].try_into().unwrap()),
    ))
}
fn aad(h: &Header) -> Result<Vec<u8>, &'static str> {
    let mut result = key(&h.ratchet_key)?.0.to_vec();
    result.extend(h.previous_chain_length.to_be_bytes());
    result.extend(h.message_number.to_be_bytes());
    Ok(result)
}
fn open(k: &Key, data: &[u8], header: &Header) -> Result<Zeroizing<Vec<u8>>, &'static str> {
    if data.len() < 28 || data.len() > 16 * 1024 * 1024 {
        return Err("invalid_ciphertext");
    }
    let cipher = Aes256Gcm::new_from_slice(&k.0).map_err(|_| "invalid_key")?;
    let attempt = |ad: &[u8]| {
        cipher.decrypt(
            Nonce::from_slice(&data[..12]),
            Payload {
                msg: &data[12..],
                aad: ad,
            },
        )
    };
    // Historical V8 JSON AAD is deliberately supported, with exact field order.
    let result = attempt(&aad(header)?)
        .or_else(|_| attempt(serde_json::to_string(header).unwrap().as_bytes()))
        .map_err(|_| "message_authentication_failed")?;
    Ok(Zeroizing::new(result))
}
pub(crate) fn validate_pair(pair: &KeyPair) -> Result<(), &'static str> {
    let expected = PublicKey::from(&StaticSecret::from(pair.private_key.0));
    if expected.as_bytes() != &pair.public_key.0 {
        return Err("invalid_ratchet_key_pair");
    }
    Ok(())
}
pub(crate) fn validate_state(s: &Session) -> Result<(), &'static str> {
    if s.skipped_message_keys.len() > 1000 {
        return Err("skipped_key_limit");
    }
    validate_pair(&s.sending_ratchet_key_pair)?;
    let mut seen = std::collections::HashSet::new();
    for sk in &s.skipped_message_keys {
        key(&sk.ratchet_key)?;
        if !seen.insert((&sk.ratchet_key, sk.message_number)) {
            return Err("duplicate_skipped_key");
        }
    }
    Ok(())
}
fn skip(s: &mut Session, until: u32) -> Result<(), &'static str> {
    let Some(mut ck) = s.receiving_chain_key.clone() else {
        return Ok(());
    };
    let count = until.saturating_sub(s.receive_message_number) as usize;
    if count > 1000 || s.skipped_message_keys.len() + count > 1000 {
        return Err("skipped_key_limit");
    }
    while s.receive_message_number < until {
        let (message, next) = chain(&ck);
        ck = next;
        let remote = s
            .receiving_ratchet_key
            .as_ref()
            .ok_or("missing_receiving_ratchet")?;
        s.skipped_message_keys.push(Skipped {
            ratchet_key: B64.encode(remote.0),
            message_number: s.receive_message_number,
            message_key: message,
        });
        s.receive_message_number = s
            .receive_message_number
            .checked_add(1)
            .ok_or("ratchet_counter_exhausted")?;
    }
    s.receiving_chain_key = Some(ck);
    Ok(())
}

/// Native and WASM callers supply fresh OS/browser CSPRNG nonce bytes; never derive
/// a nonce from a restored counter or accept production entropy from the server.
pub fn encrypt(
    session: &Session,
    plaintext: &[u8],
    nonce: [u8; 12],
) -> Result<(Session, Wire), &'static str> {
    validate_state(session)?;
    if plaintext.len() > 8 * 1024 * 1024 {
        return Err("message_too_large");
    }
    let mut s = session.clone();
    let ck = s
        .sending_chain_key
        .as_ref()
        .ok_or("sending_chain_missing")?;
    let (message, next) = chain(ck);
    let h = Header {
        ratchet_key: B64.encode(s.sending_ratchet_key_pair.public_key.0),
        previous_chain_length: s.previous_send_chain_length,
        message_number: s.send_message_number,
    };
    s.send_message_number = s
        .send_message_number
        .checked_add(1)
        .ok_or("ratchet_counter_exhausted")?;
    let cipher = Aes256Gcm::new_from_slice(&message.0).map_err(|_| "invalid_key")?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad(&h)?,
            },
        )
        .map_err(|_| "encryption_failed")?;
    let mut data = nonce.to_vec();
    data.extend(encrypted);
    s.sending_chain_key = Some(next);
    Ok((
        s,
        Wire {
            r#type: 2,
            header: h,
            ciphertext: B64.encode(data),
            pre_key_info: None,
        },
    ))
}
/// Auth failure leaves the caller's original state, skipped keys and counters intact.
/// PreKey messages require X3DH establishment before this established-session API.
pub fn decrypt(
    session: &Session,
    wire: &Wire,
    new_private: [u8; 32],
) -> Result<(Session, Zeroizing<Vec<u8>>), &'static str> {
    validate_state(session)?;
    if wire.r#type != 2 {
        return Err("prekey_establishment_required");
    }
    if wire.ciphertext.len() > 24 * 1024 * 1024 {
        return Err("message_too_large");
    }
    let data = B64
        .decode(&wire.ciphertext)
        .map_err(|_| "invalid_ciphertext")?;
    let mut s = session.clone();
    let h = &wire.header;
    if let Some(index) = s
        .skipped_message_keys
        .iter()
        .position(|k| k.ratchet_key == h.ratchet_key && k.message_number == h.message_number)
    {
        let plain = open(&s.skipped_message_keys[index].message_key, &data, h)?;
        s.skipped_message_keys.remove(index);
        return Ok((s, plain));
    }
    let remote = key(&h.ratchet_key)?;
    if s.receiving_ratchet_key.as_ref() != Some(&remote) {
        skip(&mut s, h.previous_chain_length)?;
        s.previous_send_chain_length = s.send_message_number;
        s.send_message_number = 0;
        s.receive_message_number = 0;
        let (rk, ck) = root(
            &s.root_key,
            &s.sending_ratchet_key_pair.private_key,
            &remote,
        )?;
        s.root_key = rk;
        s.receiving_chain_key = Some(ck);
        let private = Key(new_private);
        let public = Key(*PublicKey::from(&StaticSecret::from(private.0)).as_bytes());
        let (rk, ck) = root(&s.root_key, &private, &remote)?;
        s.root_key = rk;
        s.sending_chain_key = Some(ck);
        s.sending_ratchet_key_pair = KeyPair {
            public_key: public,
            private_key: private,
        };
        s.receiving_ratchet_key = Some(remote);
    } else if h.message_number < s.receive_message_number {
        return Err("message_replayed_or_expired");
    }
    skip(&mut s, h.message_number)?;
    let (message, next) = chain(
        s.receiving_chain_key
            .as_ref()
            .ok_or("receiving_chain_missing")?,
    );
    let plain = open(&message, &data, h)?;
    s.receiving_chain_key = Some(next);
    s.receive_message_number = s
        .receive_message_number
        .checked_add(1)
        .ok_or("ratchet_counter_exhausted")?;
    Ok((s, plain))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_typescript_messages_states_and_dh_turns_match_exactly() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../protocol/fixtures/ratchet.json")).unwrap();
        for item in fixture["cases"].as_array().unwrap() {
            let state: Session = serde_json::from_value(item["state"].clone()).unwrap();
            let wire: Wire = serde_json::from_value(item["wire"].clone()).unwrap();
            let expected: Session = serde_json::from_value(item["next"].clone()).unwrap();
            let next = if item["operation"] == "encrypt" {
                let data = B64.decode(&wire.ciphertext).unwrap();
                let (next, actual) = encrypt(
                    &state,
                    item["plaintext"].as_str().unwrap().as_bytes(),
                    data[..12].try_into().unwrap(),
                )
                .unwrap();
                assert_eq!(serde_json::to_value(actual).unwrap(), item["wire"]);
                next
            } else {
                let (next, plain) = decrypt(
                    &state,
                    &wire,
                    expected.sending_ratchet_key_pair.private_key.0,
                )
                .unwrap();
                assert_eq!(&*plain, item["plaintext"].as_str().unwrap().as_bytes());
                next
            };
            assert_eq!(serde_json::to_value(next).unwrap(), item["next"]);
        }
    }
    #[test]
    fn authentication_failure_and_replay_cannot_commit_ratchet_or_consume_skipped_keys() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../protocol/fixtures/ratchet.json")).unwrap();
        let item = &fixture["cases"][4]; // skipped key from out-of-order delivery
        let state: Session = serde_json::from_value(item["state"].clone()).unwrap();
        let before = serde_json::to_value(&state).unwrap();
        let mut wire: Wire = serde_json::from_value(item["wire"].clone()).unwrap();
        let mut ciphertext = B64.decode(&wire.ciphertext).unwrap();
        ciphertext[13] ^= 1;
        wire.ciphertext = B64.encode(ciphertext);
        assert!(decrypt(&state, &wire, [9; 32]).is_err());
        assert_eq!(serde_json::to_value(&state).unwrap(), before);
        let original: Wire = serde_json::from_value(item["wire"].clone()).unwrap();
        let (next, _) = decrypt(&state, &original, [9; 32]).unwrap();
        assert!(decrypt(&next, &original, [9; 32]).is_err());
    }
    #[test]
    fn counter_limits_skipped_key_dos_and_low_order_dh_are_rejected() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../protocol/fixtures/ratchet.json")).unwrap();
        let mut state: Session =
            serde_json::from_value(fixture["cases"][0]["state"].clone()).unwrap();
        state.send_message_number = u32::MAX;
        assert!(encrypt(&state, b"overflow", [1; 12]).is_err());
        let mut wire: Wire = serde_json::from_value(fixture["cases"][3]["wire"].clone()).unwrap();
        let state: Session = serde_json::from_value(fixture["cases"][3]["state"].clone()).unwrap();
        wire.header.message_number = 1001;
        assert!(decrypt(&state, &wire, [9; 32]).is_err());
        wire.header.message_number = 0;
        wire.header.ratchet_key = B64.encode([0; 32]);
        assert!(decrypt(&state, &wire, [9; 32]).is_err());
    }
}
