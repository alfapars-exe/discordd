//! Atomic DM transitions. The caller commits snapshot before exposing output.
//! Never sends plaintext as a fallback and never silently replaces a TOFU pin.
use crate::{
    ratchet::{KeyPair, Session, Wire},
    x3dh,
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::Signer;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, String>;
fn text<'a>(v: &'a Value, field: &str) -> Result<&'a str> {
    v[field]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or_else(|| format!("invalid_{field}"))
}
fn rows<'a>(v: &'a Value, store: &str) -> Result<&'a Vec<Value>> {
    v["stores"][store]
        .as_array()
        .ok_or("invalid_snapshot".into())
}
fn primary(v: &Value, store: &str) -> Result<Value> {
    rows(v, store)?
        .iter()
        .find(|r| r["key"] == "primary")
        .map(|r| r["value"].clone())
        .ok_or("invalid_snapshot".into())
}
fn put(v: &mut Value, store: &str, key: Value, value: Value) -> Result<()> {
    let a = v["stores"][store]
        .as_array_mut()
        .ok_or("invalid_snapshot")?;
    if let Some(row) = a.iter_mut().find(|r| r["key"] == key) {
        row["value"] = value;
    } else {
        a.push(json!({"key":key,"value":value}));
    }
    Ok(())
}
fn derive(seed: &[u8], label: &str) -> Result<[u8; 32]> {
    if seed.len() != 32 {
        return Err("invalid_entropy".into());
    }
    let mut out = [0; 32];
    hkdf::Hkdf::<Sha256>::new(None, seed)
        .expand(label.as_bytes(), &mut out)
        .map_err(|_| "invalid_entropy")?;
    Ok(out)
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
fn identity(v: &Value) -> Result<KeyPair> {
    serde_json::from_value(primary(v, "identity")?).map_err(|_| "invalid_identity".into())
}
fn session(v: &Value, user: &str, device: &str) -> Result<Option<Session>> {
    rows(v, "sessions")?
        .iter()
        .find(|r| r["value"]["userId"] == user && r["value"]["deviceId"] == device)
        .map(|r| {
            serde_json::from_value(r["value"]["state"].clone())
                .map_err(|_| "invalid_session".into())
        })
        .transpose()
}
fn save_session(v: &mut Value, user: &str, device: &str, state: Session) -> Result<()> {
    put(
        v,
        "sessions",
        json!(format!("{user}:{device}")),
        json!({"userId":user,"deviceId":device,"state":state}),
    )
}
fn pin(v: &mut Value, user: &str, device: &str, encoded: &str) -> Result<()> {
    let key = crate::ratchet::key(encoded).map_err(str::to_owned)?;
    let trusted = rows(v, "trustedIdentities")?;
    if let Some(row) = trusted
        .iter()
        .find(|r| r["value"]["userId"] == user && r["value"]["deviceId"] == device)
    {
        if row["value"]["identityKey"] != serde_json::to_value(&key).unwrap() {
            return Err(format!("identity_changed:{user}:{device}"));
        }
        return Ok(());
    }
    let new_device = trusted.iter().any(|r| r["value"]["userId"] == user);
    put(
        v,
        "trustedIdentities",
        json!(format!("{user}:{device}")),
        json!({"userId":user,"deviceId":device,"identityKey":key,"firstSeen":0,"verified":false}),
    )?;
    if new_device {
        if v["chatTrustAlerts"].is_null() {
            v["chatTrustAlerts"] = json!([]);
        }
        v["chatTrustAlerts"]
            .as_array_mut()
            .ok_or("invalid_snapshot")?
            .push(
                json!({"userId":user,"deviceId":device,"kind":"new_device","identityKey":encoded}),
            );
    }
    Ok(())
}
fn random_nonce(seed: &[u8], label: &str) -> Result<[u8; 12]> {
    Ok(derive(seed, label)?[..12].try_into().unwrap())
}
fn prekey_id(v: &Value) -> &Value {
    // Legacy IndexedDB uses `id`; retain reads of the earliest local chat proof.
    if v.get("id").is_some() {
        &v["id"]
    } else {
        &v["keyId"]
    }
}
fn registration_body(v: &Value) -> Result<Value> {
    let reg = primary(v, "registration")?;
    let id = identity(v)?;
    let signing: KeyPair =
        serde_json::from_value(primary(v, "signing")?).map_err(|_| "invalid_identity")?;
    let pre = &rows(v, "signedPreKeys")?.first().ok_or("invalid_prekey")?["value"];
    let prekeys: Vec<Value> = rows(v,"preKeys")?.iter().map(|r| json!({"prekey_id":prekey_id(&r["value"]),"public_key":r["value"]["publicKey"]["__b64"]})).collect();
    Ok(
        json!({"device_id":reg["deviceId"],"display_name":"HiChat Rust/Flutter","registration_id":reg["registrationId"],
        "identity_key":B64.encode(id.public_key.0),"signing_key":B64.encode(signing.public_key.0),
        "signed_prekey":pre["publicKey"]["__b64"],"signed_prekey_id":prekey_id(pre),"signed_prekey_signature":pre["signature"]["__b64"],"one_time_prekeys":prekeys}),
    )
}
fn initialize(command: &Value, seed: &[u8]) -> Result<Value> {
    let owner = text(command, "owner")?;
    let device = text(command, "device")?;
    let mut v = json!({"stores":{"registration":[],"identity":[],"signing":[],"signedPreKeys":[],"preKeys":[],"sessions":[],"metadata":[],"senderKeys":[],"trustedIdentities":[],"messageCache":[]},"portablePending":[],"preferences":{}});
    let id = x3dh::pair(derive(seed, "identity")?);
    let signing = ed25519_dalek::SigningKey::from_bytes(&derive(seed, "signing")?);
    let signed = x3dh::pair(derive(seed, "signed-prekey")?);
    put(
        &mut v,
        "identity",
        json!("primary"),
        serde_json::to_value(id).unwrap(),
    )?;
    put(
        &mut v,
        "signing",
        json!("primary"),
        json!({"privateKey":{"__b64":B64.encode(signing.to_bytes())},"publicKey":{"__b64":B64.encode(signing.verifying_key().to_bytes())}}),
    )?;
    put(
        &mut v,
        "registration",
        json!("primary"),
        json!({"userId":owner,"deviceId":device,"registrationId":u16::from_be_bytes(derive(seed,"registration")?[..2].try_into().unwrap())}),
    )?;
    put(
        &mut v,
        "signedPreKeys",
        json!(1),
        json!({"id":1,"publicKey":signed.public_key,"privateKey":signed.private_key,"signature":{"__b64":B64.encode(signing.sign(&signed.public_key.0).to_bytes())}}),
    )?;
    for n in 1..=32 {
        let pair = x3dh::pair(derive(seed, &format!("prekey:{n}"))?);
        put(
            &mut v,
            "preKeys",
            json!(n),
            json!({"id":n,"publicKey":pair.public_key,"privateKey":pair.private_key}),
        )?;
    }
    Ok(json!({"registration":registration_body(&v)?,"snapshot":v}))
}
fn bundle(b: &Value) -> Result<x3dh::Bundle> {
    serde_json::from_value(json!({"identityKey":b["identity_key"],"signingKey":b["signing_key"],"signedPrekeyId":b["signed_prekey_id"],"signedPrekey":b["signed_prekey"],"signedPrekeySignature":b["signed_prekey_signature"],"registrationId":b["registration_id"],"oneTimePrekeyId":b["one_time_prekey_id"],"oneTimePrekey":b["one_time_prekey"]}))
        .map_err(|_| "incompatible_device".into())
}
fn prepare(v: &mut Value, c: &Value, seed: &[u8]) -> Result<Value> {
    let id = text(c, "id")?;
    if id.len() < 16 {
        return Err("invalid_request_id".into());
    }
    let channel = text(c, "channel")?;
    let user = text(c, "user")?;
    let plaintext = c["plaintext"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 65536)
        .ok_or("invalid_plaintext")?;
    // The channel and recipient are part of the idempotency binding.
    let request_hash = hash(&json!([channel, user, plaintext]));
    if let Some(old) = v["chatPending"]
        .as_array()
        .and_then(|a| a.iter().find(|r| r["id"] == id))
    {
        if old["hash"] != request_hash {
            return Err("pending_request_conflict".into());
        }
        return Ok(old.clone());
    }
    let reg = primary(v, "registration")?;
    let owner = text(&reg, "userId")?;
    let local = text(&reg, "deviceId")?;
    let bundles = c["bundles"]
        .as_array()
        .filter(|a| a.len() <= 512)
        .ok_or("invalid_recipients")?;
    let mut seen = std::collections::BTreeSet::new();
    let mut envelopes = vec![];
    let mut peer_devices = 0;
    for b in bundles {
        let target_user = text(b, "user_id")?;
        let target = text(b, "device_id")?;
        if target_user != owner && target_user != user {
            return Err("recipient_scope_mismatch".into());
        }
        if target_user == owner && target == local {
            continue;
        }
        if !seen.insert((target_user, target)) {
            return Err("duplicate_recipient".into());
        }
        if target_user == user {
            peer_devices += 1;
        }
        pin(
            v,
            target_user,
            target,
            b["identity_key"].as_str().ok_or("invalid_identity")?,
        )?;
        let label = json!([target_user, target]).to_string();
        let nonce = random_nonce(seed, &format!("nonce:{label}"))?;
        let (next, mut wire) = if let Some(state) = session(v, target_user, target)? {
            crate::ratchet::encrypt(&state, plaintext.as_bytes(), nonce).map_err(str::to_owned)?
        } else {
            let registration_id = reg["registrationId"]
                .as_u64()
                .ok_or("invalid_registration")? as u32;
            x3dh::seal_initial(
                &identity(v)?,
                registration_id,
                &bundle(b)?,
                plaintext.as_bytes(),
                derive(seed, &format!("ephemeral:{label}"))?,
                nonce,
            )
            .map_err(str::to_owned)?
        };
        // Imported sessions may have an initial prekey envelope still pending.
        let key = format!("prekey_info:{target_user}:{target}");
        if let Some(meta) = rows(v, "metadata")?
            .iter()
            .find(|r| r["key"] == key && !r["value"].is_null())
        {
            wire.r#type = 3;
            wire.pre_key_info = Some(
                serde_json::from_value(meta["value"].clone())
                    .map_err(|_| "invalid_prekey_metadata")?,
            );
            put(v, "metadata", json!(key), Value::Null)?;
        }
        save_session(v, target_user, target, next)?;
        envelopes.push(json!({"sender_device_id":local,"recipient_device_id":target,"message_type":wire.r#type,"ciphertext":serde_json::to_string(&wire).unwrap()}));
    }
    if user != owner && peer_devices == 0 {
        return Err("recipient_no_keys".into());
    }
    let ciphertext = serde_json::to_string(&envelopes).map_err(|_| "invalid_envelope")?;
    if ciphertext.len() > 2_000_000 {
        return Err("fanout_message_too_large".into());
    }
    let request = json!({"id":id,"hash":request_hash,"channel":channel,"user":user,"plaintext":plaintext,"state":"prepared", "payload":{"encryption_version":1,"ciphertext":ciphertext,"sender_device_id":local,"e2ee_metadata":json!({"client_send_id":id}).to_string()}});
    if v["chatPending"].is_null() {
        v["chatPending"] = json!([]);
    }
    let pending = v["chatPending"].as_array_mut().ok_or("invalid_snapshot")?;
    if pending.len() >= 10000 {
        return Err("pending_queue_full".into());
    }
    pending.push(request.clone());
    Ok(request)
}
fn source(m: &Value) -> Value {
    json!([
        m["id"],
        m["dm_channel_id"],
        m["user_id"],
        m["sender_device_id"],
        m["ciphertext"],
        m["e2ee_metadata"],
        m["edited_at"]
    ])
}
fn legacy_cache_tag(m: &Value) -> String {
    format!(
        "dm-v1:{}",
        hash(&json!([
            m["dm_channel_id"],
            m["id"],
            m["user_id"],
            m["sender_device_id"],
            m["ciphertext"],
            m["e2ee_metadata"]
        ]))
    )
}
fn imported_plaintext(v: &Value, m: &Value) -> Result<Option<String>> {
    for row in rows(v, "messageCache")? {
        let saved = &row["value"];
        if saved["messageId"] != m["id"]
            || saved["dmChannelId"] != m["dm_channel_id"]
            || saved["channelId"] != ""
            || !saved["content"].is_string()
        {
            continue;
        }
        let attachments = m["attachments"].as_array();
        // Match the reference readDMMessageCache compatibility policy exactly.
        let old_text = saved["encryptedSourceTag"].is_null()
            && m["edited_at"].is_null()
            && attachments.is_none_or(Vec::is_empty);
        if saved["encryptedSourceTag"] != legacy_cache_tag(m) && !old_text {
            continue;
        }
        if let Some(files) = attachments {
            for (position, file) in files.iter().enumerate() {
                let index = if file["file_key_index"].is_null() {
                    position
                } else {
                    usize::try_from(
                        file["file_key_index"]
                            .as_u64()
                            .ok_or("invalid_attachment_key_index")?,
                    )
                    .map_err(|_| "invalid_attachment_key_index")?
                };
                if saved["fileKeys"]
                    .as_array()
                    .and_then(|a| a.get(index))
                    .is_none_or(Value::is_null)
                {
                    return Err("attachment_key_missing".into());
                }
            }
        }
        return Ok(Some(
            json!({"content":saved["content"],"file_keys":saved["fileKeys"]}).to_string(),
        ));
    }
    Ok(None)
}
fn cache(v: &mut Value, m: &Value, plaintext: &str) -> Result<Value> {
    if v["chatMessages"].is_null() {
        v["chatMessages"] = json!([]);
    }
    let messages = v["chatMessages"].as_array_mut().ok_or("invalid_snapshot")?;
    let cached = json!({"source":source(m),"plaintext":plaintext});
    if messages.len() >= 10000 {
        return Err("message_cache_full".into());
    }
    messages.push(cached);
    Ok(json!({"plaintext":plaintext}))
}
fn receive(v: &mut Value, m: &Value, seed: &[u8]) -> Result<Value> {
    let _ = text(m, "id")?;
    let channel = text(m, "dm_channel_id")?;
    let sender = text(m, "user_id")?;
    if let Some(old) = v["chatMessages"]
        .as_array()
        .and_then(|a| a.iter().find(|r| r["source"] == source(m)))
    {
        return Ok(json!({"plaintext":old["plaintext"]}));
    }
    if m["encryption_version"] != 1 {
        return Err("encrypted_message_required".into());
    }
    if let Some(plain) = imported_plaintext(v, m)? {
        return cache(v, m, &plain);
    }
    let reg = primary(v, "registration")?;
    let local = text(&reg, "deviceId")?;
    let sender_device = text(m, "sender_device_id")?;
    if sender_device == local {
        if sender != text(&reg, "userId")? {
            return Err("sender_scope_mismatch".into());
        }
        let request = v["chatPending"]
            .as_array()
            .and_then(|a| {
                a.iter().find(|r| {
                    r["channel"] == channel
                        && r["payload"]["ciphertext"] == m["ciphertext"]
                        && r["payload"]["e2ee_metadata"] == m["e2ee_metadata"]
                })
            })
            .cloned()
            .ok_or("sent_plaintext_unavailable")?;
        let plain = request["plaintext"].as_str().ok_or("invalid_snapshot")?;
        return cache(v, m, plain);
    }
    let envelopes: Vec<Value> = serde_json::from_str(
        m["ciphertext"]
            .as_str()
            .filter(|s| s.len() <= 2_000_000)
            .ok_or("invalid_ciphertext")?,
    )
    .map_err(|_| "invalid_envelope")?;
    let mine: Vec<&Value> = envelopes
        .iter()
        .filter(|e| e["recipient_device_id"] == local)
        .collect();
    if mine.len() != 1 {
        return Err("recipient_envelope_missing_or_ambiguous".into());
    }
    let e = mine[0];
    if e["sender_device_id"] != sender_device {
        return Err("sender_scope_mismatch".into());
    }
    let wire: Wire = serde_json::from_str(e["ciphertext"].as_str().ok_or("invalid_envelope")?)
        .map_err(|_| "invalid_wire")?;
    if e["message_type"] != wire.r#type {
        return Err("message_type_mismatch".into());
    }
    let (next, plain) = if wire.r#type == 3 {
        let info = wire.pre_key_info.as_ref().ok_or("prekey_info_missing")?;
        let handshake = hash(&json!([sender, sender_device, info.ephemeral_key]));
        if v["chatHandshakes"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(handshake)))
        {
            return Err("prekey_message_replay".into());
        }
        // In particular, an imported live session must not be rewound by an
        // old initial envelope missing from the new runtime's replay ledger.
        if session(v, sender, sender_device)?.is_some() {
            return Err("session_reestablishment_requires_confirmation".into());
        }
        // Pinning is committed only if authentication and the whole receive succeed.
        pin(v, sender, sender_device, &info.identity_key)?;
        let pair = |store: &str, id: u32| -> Result<KeyPair> {
            let row = rows(v, store)?
                .iter()
                .find(|r| prekey_id(&r["value"]) == id)
                .ok_or("prekey_missing")?;
            serde_json::from_value(json!({"publicKey":row["value"]["publicKey"],"privateKey":row["value"]["privateKey"]})).map_err(|_| "invalid_prekey".into())
        };
        let signed = pair("signedPreKeys", info.signed_prekey_id)?;
        let otp = info
            .one_time_prekey_id
            .map(|id| pair("preKeys", id))
            .transpose()?;
        let opened = x3dh::open_initial(
            &identity(v)?,
            &signed,
            otp.as_ref(),
            &wire,
            derive(seed, "receive-ratchet")?,
        )
        .map_err(str::to_owned)?;
        if v["chatHandshakes"].is_null() {
            v["chatHandshakes"] = json!([]);
        }
        v["chatHandshakes"]
            .as_array_mut()
            .ok_or("invalid_snapshot")?
            .push(json!(handshake));
        opened
    } else if wire.r#type == 2 {
        let state = session(v, sender, sender_device)?.ok_or("session_missing")?;
        crate::ratchet::decrypt(&state, &wire, derive(seed, "receive-ratchet")?)
            .map_err(str::to_owned)?
    } else {
        return Err("unsupported_message_type".into());
    };
    let plaintext = String::from_utf8(plain.to_vec()).map_err(|_| "invalid_plaintext")?;
    let payload: Value = serde_json::from_str(&plaintext).map_err(|_| "invalid_payload")?;
    if !payload["content"].is_string() {
        return Err("invalid_payload".into());
    }
    save_session(v, sender, sender_device, next)?;
    cache(v, m, &plaintext)
}

/// Commands accept entropy from the platform CSPRNG; private state is never logged.
pub fn transition(snapshot: &str, command: &str, entropy: &[u8]) -> Result<String> {
    if snapshot.len() > 96 * 1024 * 1024 || command.len() > 4 * 1024 * 1024 {
        return Err("chat_input_too_large".into());
    }
    let c: Value = serde_json::from_str(command).map_err(|_| "invalid_command")?;
    let result = if c["op"] == "initialize" {
        initialize(&c, entropy)?
    } else {
        let mut v: Value = serde_json::from_str(snapshot).map_err(|_| "invalid_snapshot")?;
        let output = match c["op"].as_str() {
            Some("inspect") => {
                json!({"pending":v["chatPending"],"trustAlerts":v["chatTrustAlerts"]})
            }
            Some("registration") => registration_body(&v)?,
            Some("prepare") => prepare(&mut v, &c, entropy)?,
            Some("receive") => receive(&mut v, &c["message"], entropy)?,
            Some("attempt") => {
                let id = text(&c, "id")?;
                let pending = v["chatPending"]
                    .as_array_mut()
                    .ok_or("pending_request_missing")?;
                let p = pending
                    .iter_mut()
                    .find(|r| r["id"] == id)
                    .ok_or("pending_request_missing")?;
                if p["state"] != "prepared" {
                    return Err("delivery_requires_reconciliation".into());
                }
                p["state"] = json!("attempted");
                p.clone()
            }
            Some("ack") => {
                let plain = receive(&mut v, &c["message"], entropy)?;
                let id = text(&c, "id")?;
                let pending = v["chatPending"]
                    .as_array_mut()
                    .ok_or("pending_request_missing")?;
                let p = pending
                    .iter_mut()
                    .find(|r| r["id"] == id)
                    .ok_or("pending_request_missing")?;
                if c["message"]["dm_channel_id"] != p["channel"]
                    || c["message"]["ciphertext"] != p["payload"]["ciphertext"]
                    || c["message"]["e2ee_metadata"] != p["payload"]["e2ee_metadata"]
                {
                    return Err("acknowledgment_mismatch".into());
                }
                p["state"] = json!("acknowledged");
                p["messageId"] = c["message"]["id"].clone();
                plain
            }
            _ => return Err("unsupported_chat_command".into()),
        };
        json!({"snapshot":v,"output":output})
    };
    let encoded = serde_json::to_string(&result).map_err(|_| "invalid_snapshot")?;
    if encoded.len() > 96 * 1024 * 1024 {
        return Err("chat_store_full".into());
    }
    Ok(encoded)
}

/// FFI wrapper uses this to scrub owned copies when the transition returns.
pub fn execute(snapshot: String, command: String, entropy: Vec<u8>) -> Result<String> {
    transition(
        &Zeroizing::new(snapshot),
        &Zeroizing::new(command),
        &Zeroizing::new(entropy),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(v: &Value, c: Value, seed: u8) -> Value {
        serde_json::from_str(&transition(&v.to_string(), &c.to_string(), &[seed; 32]).unwrap())
            .unwrap()
    }
    fn fresh(user: &str, device: &str, seed: u8) -> Value {
        run(
            &json!({}),
            json!({"op":"initialize","owner":user,"device":device}),
            seed,
        )["snapshot"]
            .clone()
    }
    fn recipient(v: &Value) -> Value {
        let mut b = registration_body(v).unwrap();
        b["user_id"] = primary(v, "registration").unwrap()["userId"].clone();
        b["one_time_prekey_id"] = b["one_time_prekeys"][0]["prekey_id"].clone();
        b["one_time_prekey"] = b["one_time_prekeys"][0]["public_key"].clone();
        b
    }
    fn prepare_for(v: &Value, peer: &Value, id: &str, content: &str, seed: u8) -> Value {
        run(
            v,
            json!({"op":"prepare","id":id,"channel":"channel","user":primary(peer,"registration").unwrap()["userId"],"plaintext":json!({"content":content,"file_keys":[]}).to_string(),"bundles":[recipient(peer)]}),
            seed,
        )
    }
    fn message(prepared: &Value, owner: &str, id: &str) -> Value {
        let mut m = prepared["output"]["payload"].clone();
        m["id"] = json!(id);
        m["dm_channel_id"] = json!("channel");
        m["user_id"] = json!(owner);
        m
    }
    #[test]
    fn new_devices_exchange_initial_messages_dh_turns_and_out_of_order_after_restart() {
        let alice = fresh("alice", "a-device", 1);
        let bob = fresh("bob", "b-device", 2);
        let first = prepare_for(&alice, &bob, "request-00000001", "İlk 👋", 3);
        let m = message(&first, "alice", "m1");
        let received = run(&bob, json!({"op":"receive","message":m}), 4);
        assert_eq!(
            serde_json::from_str::<Value>(received["output"]["plaintext"].as_str().unwrap())
                .unwrap()["content"],
            "İlk 👋"
        );
        // Re-reading the exact historical source is cache-only, never a ratchet step.
        let reread = run(
            &received["snapshot"],
            json!({"op":"receive","message":m}),
            5,
        );
        assert_eq!(received, reread);
        let reply = prepare_for(
            &received["snapshot"],
            &alice,
            "request-00000002",
            "Yanıt",
            6,
        );
        let alice_received = run(
            &first["snapshot"],
            json!({"op":"receive","message":message(&reply,"bob","m2")}),
            7,
        );
        let a2 = prepare_for(
            &alice_received["snapshot"],
            &bob,
            "request-00000003",
            "ikinci",
            8,
        );
        let a3 = prepare_for(&a2["snapshot"], &bob, "request-00000004", "üçüncü", 9);
        let late_first = run(
            &reply["snapshot"],
            json!({"op":"receive","message":message(&a3,"alice","m4")}),
            10,
        );
        let earlier = run(
            &late_first["snapshot"],
            json!({"op":"receive","message":message(&a2,"alice","m3")}),
            11,
        );
        assert!(
            earlier["output"]["plaintext"]
                .as_str()
                .unwrap()
                .contains("ikinci")
        );
        // An attacker changing the server ID must not reset the initial session.
        let mut replay = m;
        replay["id"] = json!("forged-id");
        assert_eq!(
            transition(
                &earlier["snapshot"].to_string(),
                &json!({"op":"receive","message":replay}).to_string(),
                &[12; 32]
            )
            .unwrap_err(),
            "prekey_message_replay"
        );
    }
    #[test]
    fn prepared_fanout_is_atomic_and_retries_reuse_ciphertext_without_advance() {
        let alice = fresh("alice", "a-device", 1);
        let bob = fresh("bob", "b-device", 2);
        let first = prepare_for(&alice, &bob, "request-00000001", "hello", 3);
        let again = prepare_for(&first["snapshot"], &bob, "request-00000001", "hello", 99);
        assert_eq!(first, again);
        let conflict = json!({"op":"prepare","id":"request-00000001","channel":"another","user":"bob","plaintext":json!({"content":"hello","file_keys":[]}).to_string(),"bundles":[]});
        assert_eq!(
            transition(
                &first["snapshot"].to_string(),
                &conflict.to_string(),
                &[4; 32]
            )
            .unwrap_err(),
            "pending_request_conflict"
        );
        let mut broken = recipient(&bob);
        broken["signed_prekey_signature"] = json!(B64.encode([0; 64]));
        let attempt = json!({"op":"prepare","id":"request-00000002","channel":"channel","user":"bob","plaintext":"{}","bundles":[broken]});
        assert!(transition(&alice.to_string(), &attempt.to_string(), &[4; 32]).is_err());
        assert!(rows(&alice, "sessions").unwrap().is_empty());
    }
    #[test]
    fn fanout_includes_peer_and_sibling_devices_once_and_excludes_current_device() {
        let alice = fresh("alice", "a-device", 1);
        let sibling = fresh("alice", "a-sibling", 2);
        let bob = fresh("bob", "b-device", 3);
        let b2 = fresh("bob", "b-device-2", 4);
        let prepared = run(
            &alice,
            json!({"op":"prepare","id":"request-00000001","channel":"channel","user":"bob","plaintext":"{}","bundles":[recipient(&alice),recipient(&sibling),recipient(&bob),recipient(&b2)]}),
            5,
        );
        let envelopes: Vec<Value> = serde_json::from_str(
            prepared["output"]["payload"]["ciphertext"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(envelopes.len(), 3);
        assert!(
            !envelopes
                .iter()
                .any(|e| e["recipient_device_id"] == "a-device")
        );
    }
    #[test]
    fn identity_changes_block_and_failed_authentication_cannot_pin_or_advance() {
        let alice = fresh("alice", "a-device", 1);
        let bob = fresh("bob", "b-device", 2);
        let first = prepare_for(&alice, &bob, "request-00000001", "hello", 3);
        let changed = fresh("bob", "b-device", 9);
        let cmd = json!({"op":"prepare","id":"request-00000002","channel":"channel","user":"bob","plaintext":"{}","bundles":[recipient(&changed)]});
        assert!(
            transition(&first["snapshot"].to_string(), &cmd.to_string(), &[4; 32])
                .unwrap_err()
                .starts_with("identity_changed:")
        );
        let mut forged = message(&first, "alice", "m1");
        let mut env: Vec<Value> =
            serde_json::from_str(forged["ciphertext"].as_str().unwrap()).unwrap();
        let mut wire: Value = serde_json::from_str(env[0]["ciphertext"].as_str().unwrap()).unwrap();
        wire["ciphertext"] = json!(B64.encode([0; 64]));
        env[0]["ciphertext"] = json!(wire.to_string());
        forged["ciphertext"] = json!(serde_json::to_string(&env).unwrap());
        assert!(
            transition(
                &bob.to_string(),
                &json!({"op":"receive","message":forged}).to_string(),
                &[5; 32]
            )
            .is_err()
        );
        assert!(rows(&bob, "trustedIdentities").unwrap().is_empty());
        assert!(rows(&bob, "sessions").unwrap().is_empty());
    }
    #[test]
    fn attempt_is_persisted_once_and_acknowledgment_is_bound_to_original_payload() {
        let alice = fresh("alice", "a-device", 1);
        let bob = fresh("bob", "b-device", 2);
        let prepared = prepare_for(&alice, &bob, "request-00000001", "hello", 3);
        let attempted = run(
            &prepared["snapshot"],
            json!({"op":"attempt","id":"request-00000001"}),
            4,
        );
        assert_eq!(
            transition(
                &attempted["snapshot"].to_string(),
                &json!({"op":"attempt","id":"request-00000001"}).to_string(),
                &[4; 32]
            )
            .unwrap_err(),
            "delivery_requires_reconciliation"
        );
        let m = message(&prepared, "alice", "m1");
        let ack = run(
            &attempted["snapshot"],
            json!({"op":"ack","id":"request-00000001","message":m}),
            5,
        );
        assert_eq!(ack["snapshot"]["chatPending"][0]["state"], "acknowledged");
        let mut wrong = m;
        wrong["dm_channel_id"] = json!("different");
        assert!(
            transition(
                &attempted["snapshot"].to_string(),
                &json!({"op":"ack","id":"request-00000001","message":wrong}).to_string(),
                &[6; 32]
            )
            .is_err()
        );
    }
    #[test]
    fn no_peer_keys_never_downgrades_to_plaintext() {
        let a = fresh("alice", "a-device", 1);
        assert_eq!(transition(&a.to_string(),&json!({"op":"prepare","id":"request-00000001","channel":"channel","user":"bob","plaintext":"hello","bundles":[]}).to_string(),&[2;32]).unwrap_err(),"recipient_no_keys");
    }

    #[test]
    fn imported_dm_cache_is_bound_to_source_and_never_reused_for_edits_or_other_chats() {
        let alice = fresh("alice", "a-device", 1);
        let bob = fresh("bob", "b-device", 2);
        let prepared = prepare_for(&alice, &bob, "request-00000001", "old text", 3);
        let m = message(&prepared, "alice", "m1");
        let mut imported = alice;
        put(&mut imported,"messageCache",json!("m1"),json!({"messageId":"m1","dmChannelId":"channel","channelId":"","content":"old text","encryptedSourceTag":legacy_cache_tag(&m),"fileKeys":[]})).unwrap();
        let opened = run(&imported, json!({"op":"receive","message":m}), 4);
        assert!(
            opened["output"]["plaintext"]
                .as_str()
                .unwrap()
                .contains("old text")
        );
        for field in ["ciphertext", "dm_channel_id", "user_id", "e2ee_metadata"] {
            let mut changed = m.clone();
            changed[field] = json!("tampered");
            assert!(
                transition(
                    &imported.to_string(),
                    &json!({"op":"receive","message":changed}).to_string(),
                    &[4; 32]
                )
                .is_err(),
                "{field}"
            );
        }
        imported["stores"]["messageCache"][0]["value"]
            .as_object_mut()
            .unwrap()
            .remove("encryptedSourceTag");
        assert!(
            transition(
                &imported.to_string(),
                &json!({"op":"receive","message":m}).to_string(),
                &[4; 32]
            )
            .is_ok()
        );
        let mut edited = m;
        edited["edited_at"] = json!("2026-11-01T00:00:00Z");
        assert!(
            transition(
                &imported.to_string(),
                &json!({"op":"receive","message":edited}).to_string(),
                &[4; 32]
            )
            .is_err()
        );
    }
    #[test]
    fn imported_live_session_without_replay_ledger_cannot_be_rewound_by_initial_envelope() {
        let alice = fresh("alice", "a-device", 1);
        let bob = fresh("bob", "b-device", 2);
        let first = prepare_for(&alice, &bob, "request-00000001", "hello", 3);
        let m = message(&first, "alice", "m1");
        let mut established = run(&bob, json!({"op":"receive","message":m}), 4)["snapshot"].clone();
        established
            .as_object_mut()
            .unwrap()
            .remove("chatHandshakes");
        established.as_object_mut().unwrap().remove("chatMessages");
        assert_eq!(
            transition(
                &established.to_string(),
                &json!({"op":"receive","message":m}).to_string(),
                &[5; 32]
            )
            .unwrap_err(),
            "session_reestablishment_requires_confirmation"
        );
    }
}
