const SERVICE: &str = "FilePad";

pub fn put(account: &str, secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, account).map_err(|_| "The credential store isn't available.".to_string())?;
    entry.set_password(secret).map_err(|_| "Can't store that secret.".to_string())
}

pub fn get(account: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(SERVICE, account).map_err(|_| "The credential store isn't available.".to_string())?;
    entry.get_password().map_err(|_| "Can't read the saved secret. Connect again.".to_string())
}

pub fn delete(account: &str) {
    if let Ok(entry) = keyring::Entry::new(SERVICE, account) {
        let _ = entry.delete_credential();
    }
}
