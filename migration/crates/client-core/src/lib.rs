//! Small, platform-independent contract boundary for the Flutter proof slice.
//! Backup history is read-only: importing a backup never activates its ratchet keys.
pub mod history;
pub fn inspect_response(json: String) -> Result<String, String> {
    let response: hichat_protocol::ApiResponse =
        serde_json::from_str(&json).map_err(|_| "invalid_api_response".to_owned())?;
    if response.success {
        Ok(response
            .data
            .map_or_else(|| "null".to_owned(), |v| v.to_string()))
    } else {
        // Never replace server error codes with arbitrary error text in control flow.
        Err(if response.code.is_empty() {
            "API_ERROR".to_owned()
        } else {
            response.code
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_machine_readable_failure() {
        assert_eq!(
            inspect_response(r#"{"success":false,"error":"localized","code":"FORBIDDEN"}"#.into()),
            Err("FORBIDDEN".into())
        );
    }
    #[test]
    fn rejects_non_envelope_and_preserves_empty_list() {
        assert_eq!(
            inspect_response("[]".into()),
            Err("invalid_api_response".into())
        );
        assert_eq!(
            inspect_response(r#"{"success":true,"data":[]}"#.into()),
            Ok("[]".into())
        );
    }
}
pub mod overlay;
pub mod ratchet;
pub mod sender_key;
pub mod x3dh;

#[cfg(test)]
mod crypto_reference_tests {
    use sha2::Digest;
    #[test]
    fn fixtures_are_bound_to_the_current_reference_implementation() {
        for (source, fixture) in [
            (
                include_str!("../../../../client/src/crypto/signalProtocol.ts"),
                include_str!("../../protocol/fixtures/ratchet.json"),
            ),
            (
                include_str!("../../../../client/src/crypto/signalProtocol.ts"),
                include_str!("../../protocol/fixtures/x3dh.json"),
            ),
            (
                include_str!("../../../../client/src/crypto/senderKeyProtocol.ts"),
                include_str!("../../protocol/fixtures/sender-key.json"),
            ),
        ] {
            let json: serde_json::Value = serde_json::from_str(fixture).unwrap();
            assert_eq!(
                json["sourceSha256"],
                format!(
                    "{:x}",
                    sha2::Sha256::digest(source.replace("\r\n", "\n").as_bytes())
                )
            );
            assert_eq!(
                json["typesSha256"],
                format!(
                    "{:x}",
                    sha2::Sha256::digest(
                        include_str!("../../../../client/src/crypto/types.ts")
                            .replace("\r\n", "\n")
                            .as_bytes()
                    )
                )
            );
        }
    }
}
pub mod handoff;
pub mod local_protection;
