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
fn retry_delay(attempts: u64, entropy: &[u8]) -> u64 {
    let base = (1000_u64 << attempts.saturating_sub(1).min(9)).min(250000);
    base + (base / 5) * u64::from(entropy.first().copied().unwrap_or(0)) / 255
}
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
fn pending_hash(channel: &str, user: &str, plaintext: &str, files: &Value) -> String {
    if files.is_null() {
        hash(&json!([channel, user, plaintext]))
    } else {
        hash(&json!([channel, user, plaintext, files]))
    }
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
    let request_hash = pending_hash(channel, user, plaintext, &c["files"]);
    if let Some(old) = v["chatPending"]
        .as_array()
        .and_then(|a| a.iter().find(|r| r["id"] == id))
    {
        if old["hash"] != request_hash {
            return Err("pending_request_conflict".into());
        }
        return Ok(old.clone());
    }
    let (files, plaintext) = crate::attachments::prepare_message(&c["files"], plaintext, seed)?;
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
    let request = json!({"id":id,"hash":request_hash,"channel":channel,"user":user,"plaintext":plaintext,"files":files,"state":"prepared", "payload":{"encryption_version":1,"ciphertext":ciphertext,"sender_device_id":local,"e2ee_metadata":json!({"client_send_id":id}).to_string()}});
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
    receive_confirmed(v, m, seed, false)
}
fn receive_confirmed(v: &mut Value, m: &Value, seed: &[u8], confirmed: bool) -> Result<Value> {
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
    let mut archived_index = None;
    let mut keep_current = false;
    let (next, plain) = if wire.r#type == 3 {
        let (opened, keep) = open_initial_session(v, m, &wire, seed, confirmed)?;
        keep_current = keep;
        (opened.state, opened.plaintext)
    } else if wire.r#type == 2 {
        let opened = open_session(v, sender, sender_device, &wire, seed)?;
        archived_index = opened.archive;
        (opened.state, opened.plaintext)
    } else {
        return Err("unsupported_message_type".into());
    };
    let plaintext = String::from_utf8(plain.to_vec()).map_err(|_| "invalid_plaintext")?;
    let payload: Value = serde_json::from_str(&plaintext).map_err(|_| "invalid_payload")?;
    if !payload["content"].is_string() {
        return Err("invalid_payload".into());
    }
    if let Some(i) = archived_index {
        v["chatSessionArchives"][i]["state"] =
            serde_json::to_value(next).map_err(|_| "invalid_session")?;
    } else if keep_current {
        archive_session(v, sender, sender_device, next)?;
    } else {
        save_session(v, sender, sender_device, next)?;
    }
    cache(v, m, &plaintext)
}

struct OpenedSession {
    state: Session,
    plaintext: Zeroizing<Vec<u8>>,
    archive: Option<usize>,
}
fn open_session(
    v: &Value,
    user: &str,
    device: &str,
    wire: &Wire,
    seed: &[u8],
) -> Result<OpenedSession> {
    let current = session(v, user, device)?.ok_or("session_missing")?;
    let entropy = derive(seed, "receive-ratchet")?;
    let original = match crate::ratchet::decrypt(&current, wire, entropy) {
        Ok((state, plaintext)) => {
            return Ok(OpenedSession {
                state,
                plaintext,
                archive: None,
            });
        }
        Err(error) => error,
    };
    for (i, row) in v["chatSessionArchives"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        if row["user"] != user || row["device"] != device {
            continue;
        }
        let archived: Session =
            serde_json::from_value(row["state"].clone()).map_err(|_| "invalid_session")?;
        if let Ok((state, plaintext)) = crate::ratchet::decrypt(&archived, wire, entropy) {
            return Ok(OpenedSession {
                state,
                plaintext,
                archive: Some(i),
            });
        }
    }
    Err(original.into())
}
fn open_initial_session(
    v: &mut Value,
    m: &Value,
    wire: &Wire,
    seed: &[u8],
    confirmed: bool,
) -> Result<(OpenedSession, bool)> {
    let sender = text(m, "user_id")?;
    let sender_device = text(m, "sender_device_id")?;
    let reg = primary(v, "registration")?;
    let local = text(&reg, "deviceId")?;
    let mut keep_current = false;
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
    if let Some(old) = session(v, sender, sender_device)? {
        if !confirmed {
            return Err("session_reestablishment_requires_confirmation".into());
        }
        // Simultaneous first sends converge on the same initiator. Keep both
        // receive states for already persisted outbound bytes and late replies.
        keep_current = old.receiving_chain_key.is_none() && local < sender_device;
        if !keep_current {
            archive_session(v, sender, sender_device, old)?;
        }
    }
    // Pinning is committed only if authentication and the whole receive succeed.
    pin(v, sender, sender_device, &info.identity_key)?;
    let pair = |store: &str, id: u32| -> Result<KeyPair> {
        let row = rows(v, store)?
            .iter()
            .find(|r| prekey_id(&r["value"]) == id)
            .ok_or("prekey_missing")?;
        serde_json::from_value(
            json!({"publicKey":row["value"]["publicKey"],"privateKey":row["value"]["privateKey"]}),
        )
        .map_err(|_| "invalid_prekey".into())
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
        wire,
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
    let (state, plaintext) = opened;
    Ok((
        OpenedSession {
            state,
            plaintext,
            archive: None,
        },
        keep_current,
    ))
}
fn archive_session(v: &mut Value, user: &str, device: &str, state: Session) -> Result<()> {
    if v["chatSessionArchives"].is_null() {
        v["chatSessionArchives"] = json!([])
    }
    let rows = v["chatSessionArchives"]
        .as_array_mut()
        .ok_or("invalid_snapshot")?;
    if rows.len() >= 32 {
        return Err("session_archive_full".into());
    }
    rows.push(json!({"user":user,"device":device,"state":state}));
    Ok(())
}
fn review_session(v: &mut Value, c: &Value, seed: &[u8]) -> Result<Value> {
    let m = &c["message"];
    let sender = text(m, "user_id")?;
    let device = text(m, "sender_device_id")?;
    let state = session(v, sender, device)?.ok_or("session_missing")?;
    let current = hash(&serde_json::to_value(state).map_err(|_| "invalid_session")?);
    let mut trial = v.clone();
    receive_confirmed(&mut trial, m, seed, true)?;
    let now = c["now"]
        .as_u64()
        .filter(|t| *t < 8_000_000_000_000_000)
        .ok_or("invalid_review_time")?;
    let trusted = rows(&trial, "trustedIdentities")?
        .iter()
        .find(|r| r["value"]["userId"] == sender && r["value"]["deviceId"] == device)
        .ok_or("identity_missing")?;
    let identity_key = trusted["value"]["identityKey"]["__b64"]
        .as_str()
        .ok_or("invalid_identity")?
        .to_owned();
    let identity_bytes = B64.decode(&identity_key).map_err(|_| "invalid_identity")?;
    let identity_fingerprint = format!("{:x}", Sha256::digest(identity_bytes));
    let token = hash(&json!([source(m), current, primary(v, "registration")?]));
    if v["chatSessionReviews"].is_null() {
        v["chatSessionReviews"] = json!([])
    }
    let reviews = v["chatSessionReviews"]
        .as_array_mut()
        .ok_or("invalid_snapshot")?;
    reviews.retain(|r| r["expires"].as_u64().unwrap_or(0) > now && r["token"] != token);
    if reviews.len() >= 32 {
        return Err("session_review_full".into());
    }
    let summary = json!({"token":token,"user":sender,"device":device,"channel":m["dm_channel_id"],"messageId":m["id"],"fingerprint":hash(&source(m)),"identityKey":identity_key,"identityFingerprint":identity_fingerprint,"expires":now+300000});
    reviews.push(
        json!({"summary":summary,"token":token,"expires":now+300000,"current":current,"message":m}),
    );
    Ok(summary)
}
fn confirm_session(v: &mut Value, c: &Value, seed: &[u8]) -> Result<Value> {
    let token = text(c, "token")?;
    let review = v["chatSessionReviews"]
        .as_array()
        .and_then(|a| a.iter().find(|r| r["token"] == token))
        .cloned()
        .ok_or("session_review_missing")?;
    if c["approved"] != true {
        // Dismissal does not grant permission or discard the blocked candidate.
        // A later explicit review renews its deadline and state binding.
        return Ok(json!({"cancelled":true}));
    }
    let now = c["now"].as_u64().ok_or("invalid_review_time")?;
    if now >= review["expires"].as_u64().ok_or("invalid_snapshot")? {
        return Err("session_review_expired".into());
    }
    if c["peerIdentity"] != review["summary"]["identityKey"] {
        return Err("session_review_identity_mismatch".into());
    }
    let m = &review["message"];
    let state =
        session(v, text(m, "user_id")?, text(m, "sender_device_id")?)?.ok_or("session_missing")?;
    if hash(&serde_json::to_value(state).map_err(|_| "invalid_session")?) != review["current"] {
        return Err("session_review_stale".into());
    }
    let output = receive_confirmed(v, m, seed, true)?;
    v["chatSessionReviews"]
        .as_array_mut()
        .ok_or("invalid_snapshot")?
        .retain(|r| r["token"] != token);
    Ok(output)
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
                json!({"ownIdentityFingerprint":format!("{:x}",Sha256::digest(identity(&v)?.public_key.0)),"pending":v["chatPending"],"trustAlerts":v["chatTrustAlerts"],"sessionReviews":v["chatSessionReviews"].as_array().map(|a|a.iter().map(|r|r["summary"].clone()).collect::<Vec<_>>())})
            }
            Some("registration") => registration_body(&v)?,
            Some("review_session") => review_session(&mut v, &c, entropy)?,
            Some("renew_session_review") => {
                let token = text(&c, "token")?;
                let message = v["chatSessionReviews"]
                    .as_array()
                    .and_then(|a| a.iter().find(|r| r["token"] == token))
                    .map(|r| r["message"].clone())
                    .ok_or("session_review_missing")?;
                v["chatSessionReviews"]
                    .as_array_mut()
                    .ok_or("invalid_snapshot")?
                    .retain(|r| r["token"] != token);
                review_session(&mut v, &json!({"message":message,"now":c["now"]}), entropy)?
            }
            Some("confirm_session") => confirm_session(&mut v, &c, entropy)?,
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
                let retry = p["state"] == "attempted" && p["delivery"] == "idempotent-v1";
                if p["state"] != "prepared" && !retry {
                    return Err("delivery_requires_reconciliation".into());
                }
                let now = c["now"].as_u64().unwrap_or(0).min(8_000_000_000_000_000);
                if c["automatic"] == true
                    && (p["retryBlocked"] == true || p["retryAt"].as_u64().unwrap_or(0) > now)
                {
                    return Err("retry_not_due".into());
                }
                if p["files"].as_array().is_some_and(|a| !a.is_empty())
                    && p["delivery"] != "idempotent-v1"
                    && c["delivery"] != "idempotent-v1"
                {
                    return Err("attachment_idempotency_required".into());
                }
                if p["state"] == "prepared" && c["delivery"] == "idempotent-v1" {
                    p["delivery"] = json!("idempotent-v1");
                    p["payload"]["client_message_id"] = json!(id);
                }
                p["state"] = json!("attempted");
                let attempts = p["attempts"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(1)
                    .min(1000000);
                p["attempts"] = json!(attempts);
                p["retryBlocked"] = json!(false);
                // Commit a retry fence before POST, covering process death before
                // both the response and the failure scheduler can run.
                p["retryAt"] = json!(now + retry_delay(attempts, entropy));
                p.clone()
            }
            Some("retry_failure") => {
                let id = text(&c, "id")?;
                let p = v["chatPending"]
                    .as_array_mut()
                    .ok_or("pending_request_missing")?
                    .iter_mut()
                    .find(|r| r["id"] == id)
                    .ok_or("pending_request_missing")?;
                if p["state"] == "acknowledged" {
                    return Err("pending_request_acknowledged".into());
                }
                let now = c["now"]
                    .as_u64()
                    .ok_or("invalid_retry_time")?
                    .min(8_000_000_000_000_000);
                let mut attempts = p["attempts"].as_u64().unwrap_or(0).max(1);
                if p["state"] == "prepared" {
                    attempts = attempts.saturating_add(1).min(1000000);
                    p["attempts"] = json!(attempts);
                }
                let delay = retry_delay(attempts, entropy)
                    .max(c["retryAfterSeconds"].as_u64().unwrap_or(0).min(86400) * 1000);
                p["retryAt"] = json!(now + delay);
                p["retryBlocked"] = json!(c["blocked"] == true);
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
                p["files"] = Value::Null;
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
    fn simultaneous_session_confirmation_preserves_queued_bytes_and_converges() {
        let alice = fresh("alice", "a-device", 1);
        let bob = fresh("bob", "b-device", 2);
        let a = prepare_for(&alice, &bob, "simultaneous-0001", "from a", 3);
        let b = prepare_for(&bob, &alice, "simultaneous-0002", "from b", 4);
        let late = prepare_for(
            &b["snapshot"],
            &alice,
            "simultaneous-0003",
            "late old chain",
            5,
        );
        let ma = message(&a, "alice", "a-first");
        let mb = message(&b, "bob", "b-first");
        assert!(
            transition(
                &a["snapshot"].to_string(),
                &json!({"op":"receive","message":mb}).to_string(),
                &[6; 32]
            )
            .unwrap_err()
            .contains("requires_confirmation")
        );
        let ra = run(
            &a["snapshot"],
            json!({"op":"review_session","message":mb,"now":1000}),
            6,
        );
        let rb = run(
            &late["snapshot"],
            json!({"op":"review_session","message":ma,"now":1000}),
            7,
        );
        assert_eq!(ra["snapshot"]["stores"], a["snapshot"]["stores"]);
        let ca = run(
            &ra["snapshot"],
            json!({"op":"confirm_session","token":ra["output"]["token"],"peerIdentity":ra["output"]["identityKey"],"approved":true,"now":2000}),
            8,
        );
        let cb = run(
            &rb["snapshot"],
            json!({"op":"confirm_session","token":rb["output"]["token"],"peerIdentity":rb["output"]["identityKey"],"approved":true,"now":2000}),
            9,
        );
        assert_eq!(ca["snapshot"]["chatPending"], a["snapshot"]["chatPending"]);
        assert_eq!(
            cb["snapshot"]["chatPending"],
            late["snapshot"]["chatPending"]
        );
        let old = run(
            &ca["snapshot"],
            json!({"op":"receive","message":message(&late,"bob","b-late")}),
            10,
        );
        assert!(
            old["output"]["plaintext"]
                .as_str()
                .unwrap()
                .contains("late old chain")
        );
        let next = prepare_for(
            &old["snapshot"],
            &bob,
            "simultaneous-0004",
            "canonical a",
            11,
        );
        let read = run(
            &cb["snapshot"],
            json!({"op":"receive","message":message(&next,"alice","a-next")}),
            12,
        );
        let reply = prepare_for(
            &read["snapshot"],
            &alice,
            "simultaneous-0005",
            "canonical b",
            13,
        );
        let read = run(
            &next["snapshot"],
            json!({"op":"receive","message":message(&reply,"bob","b-next")}),
            14,
        );
        assert!(
            read["output"]["plaintext"]
                .as_str()
                .unwrap()
                .contains("canonical b")
        );
        let mut replay = mb;
        replay["id"] = json!("forged");
        assert_eq!(
            transition(
                &read["snapshot"].to_string(),
                &json!({"op":"review_session","message":replay,"now":3000}).to_string(),
                &[15; 32]
            )
            .unwrap_err(),
            "prekey_message_replay"
        );
    }
    #[test]
    fn session_review_is_authenticated_cancellable_expiring_and_state_bound() {
        let alice = fresh("alice", "a-device", 1);
        let bob = fresh("bob", "b-device", 2);
        let a = prepare_for(&alice, &bob, "confirm-bound-0001", "a", 3);
        let b = prepare_for(&bob, &alice, "confirm-bound-0002", "b", 4);
        let m = message(&b, "bob", "first");
        let review = run(
            &a["snapshot"],
            json!({"op":"review_session","message":m,"now":1000}),
            5,
        );
        let token = &review["output"]["token"];
        assert!(
            review["output"]["identityFingerprint"]
                .as_str()
                .unwrap()
                .len()
                == 64
        );
        assert_eq!(transition(&review["snapshot"].to_string(),&json!({"op":"confirm_session","token":token,"peerIdentity":"wrong","approved":true,"now":2000}).to_string(),&[6;32]).unwrap_err(),"session_review_identity_mismatch");
        let cancel = run(
            &review["snapshot"],
            json!({"op":"confirm_session","token":token,"approved":false,"now":2000}),
            6,
        );
        assert_eq!(cancel["snapshot"]["stores"], a["snapshot"]["stores"]);
        assert_eq!(cancel["snapshot"], review["snapshot"]);
        assert_eq!(
            transition(
                &review["snapshot"].to_string(),
                &json!({"op":"confirm_session","token":token,"peerIdentity":review["output"]["identityKey"],"approved":true,"now":301000})
                    .to_string(),
                &[7; 32]
            )
            .unwrap_err(),
            "session_review_expired"
        );
        let changed = prepare_for(
            &review["snapshot"],
            &bob,
            "confirm-bound-0003",
            "advance",
            8,
        );
        assert_eq!(
            transition(
                &changed["snapshot"].to_string(),
                &json!({"op":"confirm_session","token":token,"peerIdentity":review["output"]["identityKey"],"approved":true,"now":2000})
                    .to_string(),
                &[9; 32]
            )
            .unwrap_err(),
            "session_review_stale"
        );
        let mut forged = m;
        forged["ciphertext"] = json!("[]");
        assert!(
            transition(
                &a["snapshot"].to_string(),
                &json!({"op":"review_session","message":forged,"now":1000}).to_string(),
                &[10; 32]
            )
            .is_err()
        );
    }
    #[test]
    fn encrypted_attachments_are_durable_and_use_legacy_file_metadata() {
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
        let alice = fresh("alice", "a-device", 1);
        let bob = fresh("bob", "b-device", 2);
        let command = json!({"op":"prepare","id":"file-request-0001","channel":"channel","user":"bob","plaintext":json!({"content":"attachment","file_keys":[]}).to_string(),"bundles":[recipient(&bob)],"files":[{"name":"test.txt","mime":"text/plain","data":B64.encode(b"file bytes")} ]});
        let p = run(&alice, command.clone(), 3);
        assert_eq!(
            transition(
                &p["snapshot"].to_string(),
                &json!({"op":"attempt","id":"file-request-0001"}).to_string(),
                &[4; 32]
            )
            .unwrap_err(),
            "attachment_idempotency_required"
        );
        let duplicate = run(&p["snapshot"], command.clone(), 4);
        assert_eq!(p, duplicate);
        let received = run(
            &bob,
            json!({"op":"receive","message":message(&p,"alice","file-message")}),
            5,
        );
        let plain: Value =
            serde_json::from_str(received["output"]["plaintext"].as_str().unwrap()).unwrap();
        let meta = &plain["file_keys"][0];
        let key = B64.decode(meta["key"].as_str().unwrap()).unwrap();
        let iv = B64.decode(meta["iv"].as_str().unwrap()).unwrap();
        let encrypted = B64
            .decode(p["output"]["files"][0]["data"].as_str().unwrap())
            .unwrap();
        let bytes = Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .decrypt(Nonce::from_slice(&iv), encrypted.as_slice())
            .unwrap();
        assert_eq!(bytes, b"file bytes");
        assert_eq!(meta["filename"], "test.txt");
        assert_eq!(meta["digest"], format!("{:x}", Sha256::digest(&bytes)));
        let mut changed = command;
        changed["files"][0]["data"] = json!(B64.encode(b"different"));
        assert_eq!(
            transition(&p["snapshot"].to_string(), &changed.to_string(), &[6; 32]).unwrap_err(),
            "pending_request_conflict"
        );
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
    fn retry_schedule_survives_reopen_honors_server_delay_and_blocks_permanent_errors() {
        let a = fresh("alice", "a-device", 1);
        let b = fresh("bob", "b-device", 2);
        let prepared = prepare_for(&a, &b, "request-00000001", "hello", 3);
        let attempted = run(
            &prepared["snapshot"],
            json!({"op":"attempt","id":"request-00000001","delivery":"idempotent-v1","now":10000}),
            4,
        );
        let failed = run(
            &attempted["snapshot"],
            json!({"op":"retry_failure","id":"request-00000001","now":11000,"retryAfterSeconds":60}),
            5,
        );
        assert_eq!(failed["output"]["retryAt"], 71000);
        let early = json!({"op":"attempt","id":"request-00000001","now":70999,"automatic":true});
        assert_eq!(
            transition(
                &failed["snapshot"].to_string(),
                &early.to_string(),
                &[8; 32]
            )
            .unwrap_err(),
            "retry_not_due"
        );
        let retry = run(
            &failed["snapshot"],
            json!({"op":"attempt","id":"request-00000001","now":71000,"automatic":true}),
            9,
        );
        assert_eq!(retry["output"]["payload"], attempted["output"]["payload"]);
        assert_eq!(retry["snapshot"]["stores"], attempted["snapshot"]["stores"]);
        let paused = run(
            &retry["snapshot"],
            json!({"op":"retry_failure","id":"request-00000001","now":72000,"blocked":true}),
            10,
        );
        assert!(
            transition(
                &paused["snapshot"].to_string(),
                &json!({"op":"attempt","id":"request-00000001","now":999999,"automatic":true})
                    .to_string(),
                &[11; 32]
            )
            .is_err()
        );
        let manual = run(
            &paused["snapshot"],
            json!({"op":"attempt","id":"request-00000001","now":999999}),
            12,
        );
        assert_eq!(manual["output"]["retryBlocked"], false);
        assert_eq!(manual["output"]["payload"], attempted["output"]["payload"]);
        assert!(retry_delay(999999, &[255; 32]) <= 300000);
    }

    #[test]
    fn durable_idempotent_attempt_reuses_exact_bytes_after_reopen() {
        let alice = fresh("alice", "a-device", 1);
        let bob = fresh("bob", "b-device", 2);
        let prepared = prepare_for(&alice, &bob, "request-00000001", "hello", 3);
        let attempted = run(
            &prepared["snapshot"],
            json!({"op":"attempt","id":"request-00000001","delivery":"idempotent-v1"}),
            4,
        );
        assert_eq!(
            attempted["output"]["payload"]["client_message_id"],
            "request-00000001"
        );
        let retried = run(
            &attempted["snapshot"],
            json!({"op":"attempt","id":"request-00000001"}),
            99,
        );
        assert_eq!(retried["output"]["payload"], attempted["output"]["payload"]);
        assert_eq!(retried["output"]["attempts"], 2);
        assert_eq!(
            attempted["snapshot"]["stores"],
            prepared["snapshot"]["stores"]
        );
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
