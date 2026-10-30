//! Small, platform-independent contract boundary for the Flutter proof slice.
//! Decryption and persistent ratchet ownership are intentionally not implemented yet.
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
