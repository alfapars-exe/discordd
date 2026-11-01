//! Legacy AES-256-GCM file format. Keys travel only inside the encrypted message.
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

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
            .filter(|s| s.len() <= 1400000)
            .ok_or("file_too_large")?;
        let bytes = Zeroizing::new(B64.decode(data).map_err(|_| "invalid_file")?);
        total += bytes.len();
        if bytes.len() > 1024 * 1024 || total > 2 * 1024 * 1024 {
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
