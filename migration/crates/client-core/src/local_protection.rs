//! Windows per-user DPAPI protection for the local target vault. No UI prompts.
pub fn protect(data: Vec<u8>, scope: String, decode: bool) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        use sha2::Digest;
        use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};
        let data = zeroize::Zeroizing::new(data);
        if data.len() > 96 * 1024 * 1024 {
            return Err("vault_too_large".into());
        }
        let mut entropy = sha2::Sha256::digest(scope.as_bytes());
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let extra = CRYPT_INTEGER_BLOB {
            cbData: 32,
            pbData: entropy.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let ok = unsafe {
            if decode {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    &extra,
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    &extra,
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if ok == 0 {
            return Err("vault_protection_failed".into());
        }
        let result =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe {
            if decode {
                std::ptr::write_bytes(output.pbData, 0, output.cbData as usize)
            }
            LocalFree(output.pbData as _);
        }
        Ok(result)
    }
    #[cfg(not(windows))]
    {
        let _ = (data, scope, decode);
        Err("native_vault_requires_platform_keystore".into())
    }
}
pub fn scope_id(scope: String) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(scope.as_bytes()))
}

/// Caller holds the vault's OS lock. Only already-protected bytes reach disk.
pub fn commit(path: String, data: Vec<u8>) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::{io::Write, os::windows::ffi::OsStrExt};
        use windows_sys::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };
        if data.len() > 96 * 1024 * 1024 || path.contains('\0') {
            return Err("invalid_vault_write".into());
        }
        let destination = std::path::PathBuf::from(path);
        let temporary = destination.with_extension("sealed.tmp");
        let mut file = std::fs::File::create(&temporary).map_err(|_| "vault_write_failed")?;
        file.write_all(&data)
            .and_then(|_| file.sync_all())
            .map_err(|_| "vault_write_failed")?;
        drop(file);
        let wide = |p: &std::path::Path| {
            p.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<u16>>()
        };
        let from = wide(&temporary);
        let to = wide(&destination);
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err("vault_commit_failed".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (path, data);
        Err("native_vault_requires_platform_keystore".into())
    }
}
