//! Existing Go wire contracts. No new encryption format is introduced here.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApiResponse {
    pub success: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub error: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub code: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub correlation_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub op: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "d",
        deserialize_with = "present_value"
    )]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "is_zero_i64")]
    pub seq: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub server_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub voice_epoch: String,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub voice_revision: u64,
}
fn is_zero_i64(v: &i64) -> bool {
    *v == 0
}
fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
fn is_zero_u64(v: &u64) -> bool {
    *v == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn go_omission_and_empty_collection_contracts() {
        for wire in [
            json!({"success":true,"data":null}),
            json!({"success":true}),
            json!({"success":true,"data":[]}),
            json!({"success":false,"error":"Forbidden","code":"FORBIDDEN","correlation_id":"req-1"}),
        ] {
            let response: ApiResponse = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(response).unwrap(), wire);
        }
    }

    #[test]
    fn go_event_omits_zero_fields_but_preserves_voice_revision() {
        for wire in [
            json!({"op":"heartbeat"}),
            json!({"op":"ready","d":{},"seq":1,"server_id":"server-1","voice_epoch":"epoch-1","voice_revision":9007199254740993_u64}),
        ] {
            let event: Event = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(event).unwrap(), wire);
        }
    }
}
