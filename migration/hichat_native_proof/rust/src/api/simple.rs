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
pub fn restore_history(
    backup_json: String,
    password: String,
    owner: String,
) -> Result<String, String> {
    hichat_client_core::history::restore_history(backup_json, password, owner)
}

pub fn update_overlay(target: String, text: String, enabled: bool) -> Result<(), String> {
    hichat_client_core::overlay::update_overlay(target, text, enabled)
}

pub fn transfer_public_key(private: Vec<u8>) -> Result<String, String> {
    let private = zeroize::Zeroizing::new(private);
    hichat_client_core::handoff::public_key(&private)
}
pub fn open_device_capsule(
    capsule: String,
    private: Vec<u8>,
    intent: String,
) -> Result<String, String> {
    let private = zeroize::Zeroizing::new(private);
    let text = hichat_client_core::handoff::open(&capsule, &private, &intent)?;
    Ok(text.to_string())
}
pub fn prepare_transferred_peer(
    snapshot: String,
    user: String,
    device: String,
    id: String,
    plaintext: String,
    nonce: Vec<u8>,
) -> Result<String, String> {
    let snapshot = zeroize::Zeroizing::new(snapshot);
    let plaintext = zeroize::Zeroizing::new(plaintext);
    hichat_client_core::handoff::prepare_peer(&snapshot, &user, &device, &id, &plaintext, &nonce)
}
pub fn verify_transferred_roster(snapshot: String, roster: String) -> Result<(), String> {
    let snapshot = zeroize::Zeroizing::new(snapshot);
    hichat_client_core::handoff::verify_roster(&snapshot, &roster)
}
pub fn protect_device_store(data: Vec<u8>, scope: String, decode: bool) -> Result<Vec<u8>, String> {
    hichat_client_core::local_protection::protect(data, scope, decode)
}
pub fn device_scope_id(scope: String) -> String {
    hichat_client_core::local_protection::scope_id(scope)
}
pub fn commit_device_store(path: String, data: Vec<u8>) -> Result<(), String> {
    hichat_client_core::local_protection::commit(path, data)
}
