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

// Runs on the bridge worker pool; PBKDF2 must never block Flutter's UI thread.
pub fn restore_history(backup_json: String, password: String, owner: String) -> Result<String, String> {
    hichat_client_core::history::restore_history(backup_json, password, owner)
}
