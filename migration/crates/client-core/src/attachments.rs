//! Legacy AES-256-GCM file format. Keys travel only inside the encrypted message.
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const MAX_FILE_BYTES: usize = 25 * 1024 * 1024 - 16;

pub fn decrypt(meta: &Value, data: &Value) -> Result<Value, String> {
    let size = meta["originalSize"]
        .as_u64()
        .filter(|&n| n <= MAX_FILE_BYTES as u64)
        .ok_or("invalid_file_size")? as usize;
    let decode = |value: &Value, expected: usize| {
        let encoded = value
            .as_str()
            .filter(|s| s.len() == expected.div_ceil(3) * 4)
            .ok_or("invalid_attachment_encoding")?;
        let bytes = Zeroizing::new(
            B64.decode(encoded)
                .map_err(|_| "invalid_attachment_encoding")?,
        );
        if bytes.len() != expected {
            return Err("invalid_attachment_size");
        }
        Ok(bytes)
    };
    let key = decode(&meta["key"], 32)?;
    let iv = decode(&meta["iv"], 12)?;
    let ciphertext = decode(data, size + 16)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "invalid_key")?;
    let plain = Zeroizing::new(
        cipher
            .decrypt(Nonce::from_slice(&iv), ciphertext.as_slice())
            .map_err(|_| "file_authentication_failed")?,
    );
    if meta["digest"].as_str() != Some(&format!("{:x}", Sha256::digest(plain.as_slice()))) {
        return Err("file_integrity_failed".into());
    }
    Ok(json!(B64.encode(plain.as_slice())))
}

pub fn prepare(files: &Value, seed: &[u8]) -> Result<(Vec<Value>, Vec<Value>), String> {
    let Some(files) = files.as_array() else {
        if files.is_null() {
            return Ok((vec![], vec![]));
        }
        return Err("invalid_files".into());
    };
    if files.len() > 10 {
        return Err("too_many_files".into());
    }
    let mut total = 0;
    let mut encrypted = vec![];
    let mut metadata = vec![];
    for (i, file) in files.iter().enumerate() {
        let data = file["data"]
            .as_str()
            .filter(|s| s.len() <= MAX_FILE_BYTES.div_ceil(3) * 4)
            .ok_or("file_too_large")?;
        let bytes = Zeroizing::new(B64.decode(data).map_err(|_| "invalid_file")?);
        total += bytes.len();
        if bytes.len() > MAX_FILE_BYTES || total > MAX_FILE_BYTES {
            return Err("file_too_large".into());
        }
        let name = file["name"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 512)
            .ok_or("invalid_filename")?;
        let mime = file["mime"]
            .as_str()
            .filter(|s| s.len() <= 128)
            .ok_or("invalid_mime")?;
        let mut key = Zeroizing::new([0u8; 32]);
        let mut iv = [0u8; 12];
        let hkdf = hkdf::Hkdf::<Sha256>::new(None, seed);
        hkdf.expand(format!("file-key:{i}").as_bytes(), key.as_mut())
            .map_err(|_| "invalid_entropy")?;
        hkdf.expand(format!("file-iv:{i}").as_bytes(), &mut iv)
            .map_err(|_| "invalid_entropy")?;
        let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "invalid_key")?;
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&iv), bytes.as_slice())
            .map_err(|_| "file_encrypt_failed")?;
        encrypted.push(json!({"name":format!("encrypted_{i}.bin"),"data":B64.encode(ciphertext)}));
        metadata.push(json!({"key":B64.encode(key.as_ref()),"iv":B64.encode(iv),"filename":name,"mimeType":mime,"originalSize":bytes.len(),"digest":format!("{:x}",Sha256::digest(bytes.as_slice()))}));
    }
    Ok((encrypted, metadata))
}

pub fn prepare_message(
    files: &Value,
    plaintext: &str,
    seed: &[u8],
) -> Result<(Vec<Value>, String), String> {
    let (encrypted, metadata) = prepare(files, seed)?;
    if encrypted.is_empty() {
        return Ok((encrypted, plaintext.to_owned()));
    }
    let mut payload: Value = serde_json::from_str(plaintext).map_err(|_| "invalid_payload")?;
    if !payload["content"].is_string() {
        return Err("invalid_payload".into());
    }
    payload["file_keys"] = json!(metadata);
    Ok((encrypted, payload.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_ciphertext_and_metadata_before_returning_plaintext() {
        let data = B64.encode(b"attachment");
        let (files, metadata) = prepare(
            &json!([{"name":"report.txt","mime":"text/plain","data":data}]),
            &[7; 32],
        )
        .unwrap();
        let mut meta = metadata[0].clone();
        assert_eq!(decrypt(&meta, &files[0]["data"]).unwrap(), json!(data));
        let invalid = json!(B64.encode([0; 26]));
        assert_eq!(
            decrypt(&meta, &invalid).unwrap_err(),
            "file_authentication_failed"
        );
        meta["digest"] = json!("wrong");
        assert_eq!(
            decrypt(&meta, &files[0]["data"]).unwrap_err(),
            "file_integrity_failed"
        );
        meta["originalSize"] = json!(MAX_FILE_BYTES + 1);
        assert_eq!(
            decrypt(&meta, &files[0]["data"]).unwrap_err(),
            "invalid_file_size"
        );
    }
}
