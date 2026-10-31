//! Existing X3DH setup, separate from persistence, TOFU/UI and ownership activation.
use super::ratchet::{Key, KeyPair, Session, key, root};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle {
    pub identity_key: String,
    pub signing_key: String,
    pub signed_prekey_id: u32,
    pub signed_prekey: String,
    pub signed_prekey_signature: String,
    pub one_time_prekey_id: Option<u32>,
    pub one_time_prekey: Option<String>,
    pub registration_id: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreKeyInfo {
    pub registration_id: u32,
    pub identity_key: String,
    pub ephemeral_key: String,
    pub signed_prekey_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub one_time_prekey_id: Option<u32>,
}
fn dh(private: &Key, public: &Key) -> Result<[u8; 32], &'static str> {
    let secret = StaticSecret::from(private.0).diffie_hellman(&PublicKey::from(public.0));
    if !secret.was_contributory() {
        return Err("invalid_dh_public_key");
    };
    Ok(*secret.as_bytes())
}
fn master(material: &[u8]) -> Result<(Key, Key), &'static str> {
    let mut out = Zeroizing::new([0u8; 64]);
    hkdf::Hkdf::<sha2::Sha256>::new(Some(&[0; 32]), material)
        .expand(b"mqvi-e2ee-rk", &mut *out)
        .map_err(|_| "invalid_kdf")?;
    Ok((
        Key(out[..32].try_into().unwrap()),
        Key(out[32..].try_into().unwrap()),
    ))
}
pub fn pair(private: [u8; 32]) -> KeyPair {
    KeyPair {
        public_key: Key(*PublicKey::from(&StaticSecret::from(private)).as_bytes()),
        private_key: Key(private),
    }
}
pub fn initiate(
    identity: &KeyPair,
    registration_id: u32,
    bundle: &Bundle,
    ephemeral_private: [u8; 32],
) -> Result<(Session, PreKeyInfo), &'static str> {
    super::ratchet::validate_pair(identity)?;
    let identity_peer = key(&bundle.identity_key)?;
    let signed = key(&bundle.signed_prekey)?;
    let signing = key(&bundle.signing_key)?;
    let sig = B64
        .decode(&bundle.signed_prekey_signature)
        .map_err(|_| "invalid_prekey_signature")?;
    VerifyingKey::from_bytes(&signing.0)
        .map_err(|_| "invalid_prekey_signature")?
        .verify_strict(
            &signed.0,
            &Signature::from_slice(&sig).map_err(|_| "invalid_prekey_signature")?,
        )
        .map_err(|_| "invalid_prekey_signature")?;
    if bundle.one_time_prekey.is_some() != bundle.one_time_prekey_id.is_some() {
        return Err("partial_one_time_prekey");
    }
    let eph = pair(ephemeral_private);
    let mut material = Zeroizing::new(Vec::with_capacity(128));
    material.extend(dh(&identity.private_key, &signed)?);
    material.extend(dh(&eph.private_key, &identity_peer)?);
    material.extend(dh(&eph.private_key, &signed)?);
    if let Some(ot) = &bundle.one_time_prekey {
        material.extend(dh(&eph.private_key, &key(ot)?)?)
    }
    let (root_key, chain) = master(&material)?;
    let info = PreKeyInfo {
        registration_id,
        identity_key: B64.encode(identity.public_key.0),
        ephemeral_key: B64.encode(eph.public_key.0),
        signed_prekey_id: bundle.signed_prekey_id,
        one_time_prekey_id: bundle.one_time_prekey_id,
    };
    Ok((
        Session {
            root_key,
            sending_chain_key: Some(chain),
            receiving_chain_key: None,
            sending_ratchet_key_pair: eph,
            receiving_ratchet_key: Some(signed),
            send_message_number: 0,
            receive_message_number: 0,
            previous_send_chain_length: 0,
            skipped_message_keys: vec![],
        },
        info,
    ))
}
/// The caller must load exactly the prekey IDs declared in info. A missing OTP
/// is a hard failure, never an implicit 4-DH to 3-DH downgrade.
pub fn receive(
    identity: &KeyPair,
    signed: &KeyPair,
    one_time: Option<&KeyPair>,
    info: &PreKeyInfo,
    new_private: [u8; 32],
) -> Result<Session, &'static str> {
    super::ratchet::validate_pair(identity)?;
    super::ratchet::validate_pair(signed)?;
    if let Some(otp) = one_time {
        super::ratchet::validate_pair(otp)?;
    }
    if info.one_time_prekey_id.is_some() != one_time.is_some() {
        return Err("one_time_prekey_missing");
    }
    let sender = key(&info.identity_key)?;
    let eph = key(&info.ephemeral_key)?;
    let mut material = Zeroizing::new(Vec::with_capacity(128));
    material.extend(dh(&signed.private_key, &sender)?);
    material.extend(dh(&identity.private_key, &eph)?);
    material.extend(dh(&signed.private_key, &eph)?);
    if let Some(ot) = one_time {
        material.extend(dh(&ot.private_key, &eph)?)
    }
    let (rk, receive_chain) = master(&material)?;
    let sending = pair(new_private);
    let (root_key, send_chain) = root(&rk, &sending.private_key, &eph)?;
    Ok(Session {
        root_key,
        sending_chain_key: Some(send_chain),
        receiving_chain_key: Some(receive_chain),
        sending_ratchet_key_pair: sending,
        receiving_ratchet_key: Some(eph),
        send_message_number: 0,
        receive_message_number: 0,
        previous_send_chain_length: 0,
        skipped_message_keys: vec![],
    })
}

/// Produces the existing type=3 envelope. Persistence/ownership must commit next
/// together with its idempotent pending request before the frame is released.
pub fn seal_initial(
    identity: &KeyPair,
    registration_id: u32,
    bundle: &Bundle,
    plaintext: &[u8],
    ephemeral_private: [u8; 32],
    nonce: [u8; 12],
) -> Result<(Session, super::ratchet::Wire), &'static str> {
    let (session, info) = initiate(identity, registration_id, bundle, ephemeral_private)?;
    let (next, mut wire) = super::ratchet::encrypt(&session, plaintext, nonce)?;
    wire.r#type = 3;
    wire.pre_key_info = Some(info);
    Ok((next, wire))
}
pub fn open_initial(
    identity: &KeyPair,
    signed: &KeyPair,
    one_time: Option<&KeyPair>,
    wire: &super::ratchet::Wire,
    new_private: [u8; 32],
) -> Result<(Session, Zeroizing<Vec<u8>>), &'static str> {
    if wire.r#type != 3 {
        return Err("prekey_message_required");
    }
    let info = wire.pre_key_info.as_ref().ok_or("prekey_info_missing")?;
    if wire.header.ratchet_key != info.ephemeral_key {
        return Err("prekey_ratchet_mismatch");
    }
    let initial = receive(identity, signed, one_time, info, new_private)?;
    let mut established = wire.clone();
    established.r#type = 2;
    established.pre_key_info = None;
    super::ratchet::decrypt(&initial, &established, new_private)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_three_and_four_dh_sessions_and_first_messages_match() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../protocol/fixtures/x3dh.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let identity: KeyPair = serde_json::from_value(case["identity"].clone()).unwrap();
            let expected: Session = serde_json::from_value(case["next"].clone()).unwrap();
            let private = expected.sending_ratchet_key_pair.private_key.0;
            let result = match case["operation"].as_str().unwrap() {
                "initiate" => {
                    let bundle: Bundle = serde_json::from_value(case["bundle"].clone()).unwrap();
                    let (state, info) = initiate(&identity, 44, &bundle, private).unwrap();
                    assert_eq!(serde_json::to_value(info).unwrap(), case["prekeyInfo"]);
                    state
                }
                "receive" => {
                    let signed: KeyPair = serde_json::from_value(case["signed"].clone()).unwrap();
                    let otp: Option<KeyPair> = serde_json::from_value(case["otp"].clone()).unwrap();
                    let info: PreKeyInfo =
                        serde_json::from_value(case["prekeyInfo"].clone()).unwrap();
                    receive(&identity, &signed, otp.as_ref(), &info, private).unwrap()
                }
                "seal" => {
                    let bundle: Bundle = serde_json::from_value(case["bundle"].clone()).unwrap();
                    let wire: super::super::ratchet::Wire =
                        serde_json::from_value(case["wire"].clone()).unwrap();
                    let raw = B64.decode(&wire.ciphertext).unwrap();
                    let (state, actual) = seal_initial(
                        &identity,
                        44,
                        &bundle,
                        case["plaintext"].as_str().unwrap().as_bytes(),
                        private,
                        raw[..12].try_into().unwrap(),
                    )
                    .unwrap();
                    assert_eq!(serde_json::to_value(actual).unwrap(), case["wire"]);
                    state
                }
                "open" => {
                    let signed: KeyPair = serde_json::from_value(case["signed"].clone()).unwrap();
                    let otp: Option<KeyPair> = serde_json::from_value(case["otp"].clone()).unwrap();
                    let wire: super::super::ratchet::Wire =
                        serde_json::from_value(case["wire"].clone()).unwrap();
                    let (state, plain) =
                        open_initial(&identity, &signed, otp.as_ref(), &wire, private).unwrap();
                    assert_eq!(&*plain, case["plaintext"].as_str().unwrap().as_bytes());
                    state
                }
                _ => panic!("unknown fixture operation"),
            };
            assert_eq!(serde_json::to_value(result).unwrap(), case["next"]);
        }
    }
    #[test]
    fn rejects_modified_signature_missing_otp_and_low_order_keys() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../protocol/fixtures/x3dh.json")).unwrap();
        let case = &fixture["cases"][4];
        let identity: KeyPair = serde_json::from_value(case["identity"].clone()).unwrap();
        let mut bundle: Bundle = serde_json::from_value(case["bundle"].clone()).unwrap();
        bundle.signed_prekey_signature = B64.encode([0; 64]);
        assert!(initiate(&identity, 44, &bundle, [2; 32]).is_err());
        let case = &fixture["cases"][5];
        let receiver: KeyPair = serde_json::from_value(case["identity"].clone()).unwrap();
        let signed: KeyPair = serde_json::from_value(case["signed"].clone()).unwrap();
        let info: PreKeyInfo = serde_json::from_value(case["prekeyInfo"].clone()).unwrap();
        assert!(receive(&receiver, &signed, None, &info, [2; 32]).is_err());
        let mut low = info.clone();
        low.one_time_prekey_id = None;
        low.identity_key = B64.encode([0; 32]);
        assert!(receive(&receiver, &signed, None, &low, [2; 32]).is_err());
    }
}
