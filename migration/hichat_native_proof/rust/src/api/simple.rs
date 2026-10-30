#[flutter_rust_bridge::frb(sync)]
pub fn greet(name: String) -> String {
    match hichat_client_core::inspect_response(name) {
        Ok(data) => format!("OK: {data}"),
        Err(code) => format!("ERROR: {code}"),
    }
}
#[flutter_rust_bridge::frb(init)]
pub fn init_app() {
    flutter_rust_bridge::setup_default_user_utils();
}
