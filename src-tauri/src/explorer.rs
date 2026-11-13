use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// Folder path from a later launch, including one that arrived before the window was ready.
static LAUNCHED: Mutex<Option<String>> = Mutex::new(None);

const VERB: &str = "FilePad";
const DIRECTORY: &str = r"Software\Classes\Directory\shell";
const DRIVE: &str = r"Software\Classes\Drive\shell";
const WIN_E: &str = r"Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command";
const WIN_E_ROOT: &str = r"Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderAppStatus {
    pub supported: bool,
    pub enabled: bool,
}

pub fn remember_launch_args() {
    if let Some(path) = folder_from_args(std::env::args()) {
        note_launched(path);
    }
}

pub fn note_launched(path: String) {
    if let Ok(mut slot) = LAUNCHED.lock() {
        *slot = Some(path);
    }
}

pub fn take_launched() -> Option<String> {
    LAUNCHED.lock().ok().and_then(|mut slot| slot.take())
}

/// A directory argument Windows passed when a folder was opened.
pub fn folder_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().enumerate().find_map(|(index, arg)| {
        if index == 0 {
            return None;
        }
        existing_dir(arg.as_ref())
    })
}

/// Open and Save dialogs use the same folder verb as the desktop. Hand those
/// clicks back to File Explorer so the dialog is not replaced by FilePad.
pub fn yield_folder_to_explorer() -> bool {
    let Some(path) = folder_from_args(std::env::args()) else {
        return false;
    };
    if !foreground_is_file_dialog() {
        return false;
    }
    let _ = std::process::Command::new("explorer.exe").arg(path).spawn();
    true
}

/// Keep a folder registration ahead of other verbs that pin themselves to the top.
pub fn maintain_folder_app() {
    #[cfg(windows)]
    if folder_app_enabled() {
        let _ = pin_verb(DIRECTORY);
        let _ = pin_verb(DRIVE);
        notify_shell();
    }
}

pub fn folder_app_status() -> FolderAppStatus {
    FolderAppStatus {
        supported: cfg!(windows),
        enabled: folder_app_enabled(),
    }
}

pub fn set_folder_app(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if enabled {
            install().map_err(|_| "Can't change which app opens folders.".to_string())
        } else {
            remove().map_err(|_| "Can't change which app opens folders.".to_string())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Opening folders from the desktop is a Windows setting.".into())
    }
}

fn folder_app_enabled() -> bool {
    #[cfg(windows)]
    {
        let Ok(exe) = exe_path() else {
            return false;
        };
        verb_matches(DIRECTORY, &exe) && verb_matches(DRIVE, &exe) && win_e_matches(&exe)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn existing_dir(raw: &str) -> Option<String> {
    let text = raw.trim().trim_matches('"');
    if text.is_empty() || text.starts_with('-') {
        return None;
    }
    let path = PathBuf::from(text);
    if !path.is_dir() {
        return None;
    }
    Some(display_dir(&path))
}

fn display_dir(path: &Path) -> String {
    let text = plain_path(path);
    if drive_root(&text) {
        let letter = text.chars().next().unwrap_or('C');
        return format!("{letter}:\\");
    }
    text.trim_end_matches(['\\', '/']).to_string()
}

fn drive_root(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(letter) = chars.next() else {
        return false;
    };
    letter.is_ascii_alphabetic() && chars.next() == Some(':') && chars.all(|ch| ch == '\\' || ch == '/')
}

fn plain_path(path: &Path) -> String {
    let text = path.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn command_points_here(command: &str, exe: &str) -> bool {
    let exe = exe.to_lowercase();
    !exe.is_empty() && command.split('"').map(|part| part.trim().to_lowercase()).any(|part| part == exe)
}

#[cfg(windows)]
fn foreground_is_file_dialog() -> bool {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetForegroundWindow};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() || class_name(hwnd) != "#32770" {
            return false;
        }
        let mut found = false;
        let _ = EnumChildWindows(Some(hwnd), Some(see_shell_view), LPARAM(&mut found as *mut bool as isize));
        found
    }
}

#[cfg(not(windows))]
fn foreground_is_file_dialog() -> bool {
    false
}

#[cfg(windows)]
unsafe extern "system" fn see_shell_view(hwnd: windows::Win32::Foundation::HWND, param: windows::Win32::Foundation::LPARAM) -> windows_core::BOOL {
    let class = class_name(hwnd);
    if class == "SHELLDLL_DefView" || class == "DUIViewWndClassName" {
        let flag = param.0 as *mut bool;
        if !flag.is_null() {
            unsafe { *flag = true };
        }
        return windows_core::BOOL(0);
    }
    windows_core::BOOL(1)
}

#[cfg(windows)]
fn class_name(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let mut buf = [0u16; 256];
    let count = unsafe { GetClassNameW(hwnd, &mut buf) };
    if count <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..count as usize])
}

#[cfg(windows)]
fn exe_path() -> Result<String, String> {
    let path = std::env::current_exe().map_err(|_| "Can't find FilePad.")?;
    Ok(plain_path(&path))
}

#[cfg(windows)]
fn install() -> Result<(), String> {
    let exe = exe_path()?;
    let installed = (|| {
        write_verb(DIRECTORY, &exe)?;
        write_verb(DRIVE, &exe)?;
        write_win_e(&exe)
    })();
    if let Err(err) = installed {
        let _ = remove();
        return Err(err);
    }
    notify_shell();
    Ok(())
}

#[cfg(windows)]
fn remove() -> Result<(), String> {
    remove_verb(DIRECTORY)?;
    remove_verb(DRIVE)?;
    remove_win_e()?;
    notify_shell();
    Ok(())
}

#[cfg(windows)]
fn verb_matches(root: &str, exe: &str) -> bool {
    read_default(root).as_deref() == Some(VERB) && read_default(&format!(r"{root}\{VERB}\command")).is_some_and(|command| command_points_here(&command, exe))
}

#[cfg(windows)]
fn win_e_matches(exe: &str) -> bool {
    read_default(WIN_E).is_some_and(|command| command_points_here(&command, exe)) && read_named(WIN_E, "DelegateExecute").as_deref() == Some("")
}

#[cfg(windows)]
fn write_verb(root: &str, exe: &str) -> Result<(), String> {
    {
        let shell = create_key(root)?;
        set_sz(shell.0, None, VERB)?;
    }
    {
        let verb = create_key(&format!(r"{root}\{VERB}"))?;
        set_sz(verb.0, None, "Open in FilePad")?;
        set_sz(verb.0, Some("Icon"), &format!("{exe},0"))?;
    }
    let command = create_key(&format!(r"{root}\{VERB}\command"))?;
    set_sz(command.0, None, &format!("\"{exe}\" \"%1\""))?;
    // NordVPN Meshnet pins its own verb with Position=Top. Windows then runs that
    // verb on a double-click whenever a folder app is the default. Pin ours and
    // unpin the others so the click reaches FilePad.
    pin_verb(root)
}

#[cfg(windows)]
fn write_win_e(exe: &str) -> Result<(), String> {
    let key = create_key(WIN_E)?;
    set_sz(key.0, None, &format!("\"{exe}\""))?;
    set_sz(key.0, Some("DelegateExecute"), "")
}

#[cfg(windows)]
fn remove_verb(root: &str) -> Result<(), String> {
    delete_tree(&format!(r"{root}\{VERB}"))?;
    if let Some(key) = open_key(root, true) {
        if read_value(key.0, None).as_deref() == Some(VERB) {
            delete_value(key.0, None)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn pin_verb(root: &str) -> Result<(), String> {
    {
        let verb = create_key(&format!(r"{root}\{VERB}"))?;
        set_sz(verb.0, Some("Position"), "Top")?;
    }
    let Some(shell) = open_key(root, true) else {
        return Ok(());
    };
    let mut index = 0u32;
    loop {
        let mut name = [0u16; 256];
        let mut len = name.len() as u32;
        let err = unsafe {
            windows::Win32::System::Registry::RegEnumKeyExW(
                shell.0,
                index,
                Some(windows::core::PWSTR(name.as_mut_ptr())),
                &mut len,
                None,
                None,
                None,
                None,
            )
        };
        if err == windows::Win32::Foundation::ERROR_NO_MORE_ITEMS {
            break;
        }
        if err.is_err() {
            break;
        }
        index += 1;
        let verb = String::from_utf16_lossy(&name[..len as usize]);
        if verb.eq_ignore_ascii_case(VERB) {
            continue;
        }
        let path = format!(r"{root}\{verb}");
        if read_named(&path, "Position").as_deref() == Some("Top") {
            if let Some(key) = open_key(&path, true) {
                delete_value(key.0, Some("Position"))?;
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn remove_win_e() -> Result<(), String> {
    let command = read_default(WIN_E).unwrap_or_default();
    if command.to_lowercase().contains("filepad") {
        delete_tree(WIN_E_ROOT)?;
    }
    Ok(())
}

#[cfg(windows)]
fn notify_shell() {
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
}

#[cfg(windows)]
struct Key(windows::Win32::System::Registry::HKEY);

#[cfg(windows)]
impl Drop for Key {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = windows::Win32::System::Registry::RegCloseKey(self.0);
            }
        }
    }
}

#[cfg(windows)]
fn create_key(subkey: &str) -> Result<Key, String> {
    use windows::Win32::System::Registry::{RegCreateKeyW, HKEY_CURRENT_USER};
    use windows::core::PCWSTR;
    let wide = wide(subkey);
    let mut key = windows::Win32::System::Registry::HKEY(std::ptr::null_mut());
    unsafe { RegCreateKeyW(HKEY_CURRENT_USER, PCWSTR(wide.as_ptr()), &mut key) }.ok().map_err(|_| "Can't change which app opens folders.".to_string())?;
    Ok(Key(key))
}

#[cfg(windows)]
fn open_key(subkey: &str, write: bool) -> Option<Key> {
    use windows::Win32::System::Registry::{RegOpenKeyExW, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use windows::core::PCWSTR;
    let wide = wide(subkey);
    let access = if write { KEY_READ | KEY_WRITE } else { KEY_READ };
    let mut key = windows::Win32::System::Registry::HKEY(std::ptr::null_mut());
    let err = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(wide.as_ptr()), None, access, &mut key) };
    if err.is_err() {
        return None;
    }
    Some(Key(key))
}

#[cfg(windows)]
fn set_sz(key: windows::Win32::System::Registry::HKEY, name: Option<&str>, value: &str) -> Result<(), String> {
    use windows::Win32::System::Registry::{RegSetValueExW, REG_SZ};
    use windows::core::PCWSTR;
    let name_wide = name.map(wide);
    let name_pc = name_wide.as_ref().map(|item| PCWSTR(item.as_ptr())).unwrap_or_else(default_name);
    let data = wide(value);
    let bytes = unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 2) };
    unsafe { RegSetValueExW(key, name_pc, Some(0), REG_SZ, Some(bytes)) }.ok().map_err(|_| "Can't change which app opens folders.".to_string())
}

#[cfg(windows)]
fn read_default(subkey: &str) -> Option<String> {
    read_named_opt(subkey, None)
}

#[cfg(windows)]
fn read_named(subkey: &str, name: &str) -> Option<String> {
    read_named_opt(subkey, Some(name))
}

#[cfg(windows)]
fn read_named_opt(subkey: &str, name: Option<&str>) -> Option<String> {
    let key = open_key(subkey, false)?;
    read_value(key.0, name)
}

#[cfg(windows)]
fn read_value(key: windows::Win32::System::Registry::HKEY, name: Option<&str>) -> Option<String> {
    use windows::Win32::System::Registry::{RegQueryValueExW, REG_SZ, REG_VALUE_TYPE};
    use windows::core::PCWSTR;
    let name_wide = name.map(wide);
    let name_pc = name_wide.as_ref().map(|item| PCWSTR(item.as_ptr())).unwrap_or_else(default_name);
    unsafe {
        let mut size = 0u32;
        let mut kind = REG_VALUE_TYPE(0);
        let probe = RegQueryValueExW(key, name_pc, None, Some(&mut kind), None, Some(&mut size));
        if (probe.is_err() && probe.0 != 234) || size < 2 {
            return None;
        }
        let mut buf = vec![0u8; size as usize + 2];
        let mut got = size;
        if RegQueryValueExW(key, name_pc, None, Some(&mut kind), Some(buf.as_mut_ptr()), Some(&mut got)).is_err() || kind != REG_SZ {
            return None;
        }
        let count = (got as usize / 2).min(buf.len() / 2);
        let words = std::slice::from_raw_parts(buf.as_ptr() as *const u16, count);
        let end = words.iter().position(|unit| *unit == 0).unwrap_or(words.len());
        Some(String::from_utf16_lossy(&words[..end]))
    }
}

#[cfg(windows)]
fn delete_value(key: windows::Win32::System::Registry::HKEY, name: Option<&str>) -> Result<(), String> {
    use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows::Win32::System::Registry::RegDeleteValueW;
    use windows::core::PCWSTR;
    let name_wide = name.map(wide);
    let name_pc = name_wide.as_ref().map(|item| PCWSTR(item.as_ptr())).unwrap_or_else(default_name);
    let err = unsafe { RegDeleteValueW(key, name_pc) };
    if err.is_ok() || err == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    Err("Can't change which app opens folders.".into())
}

#[cfg(windows)]
fn delete_tree(subkey: &str) -> Result<(), String> {
    use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows::Win32::System::Registry::{RegDeleteTreeW, HKEY_CURRENT_USER};
    use windows::core::PCWSTR;
    let wide = wide(subkey);
    let err = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(wide.as_ptr())) };
    if err.is_ok() || err == ERROR_FILE_NOT_FOUND || err.0 == 3 {
        return Ok(());
    }
    Err("Can't change which app opens folders.".into())
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn default_name() -> windows::core::PCWSTR {
    static EMPTY: u16 = 0;
    windows::core::PCWSTR(&EMPTY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_argument_is_a_real_directory() {
        let dir = std::env::temp_dir();
        let text = dir.display().to_string();
        let found = folder_from_args(["filepad.exe", "--from-shell", text.as_str()]).expect("folder");
        assert!(Path::new(&found).is_dir());
        assert!(folder_from_args(["filepad.exe", "--mcp"]).is_none());
        assert!(folder_from_args(["filepad.exe", r"C:\no\such\filepad\folder"]).is_none());
    }

    #[test]
    fn quoted_folder_argument_is_accepted() {
        let dir = std::env::temp_dir();
        let quoted = format!("\"{}\"", dir.display());
        assert!(folder_from_args(["filepad.exe", quoted.as_str()]).is_some());
    }

    #[cfg(windows)]
    #[test]
    fn drive_root_keeps_its_slash() {
        if !Path::new(r"C:\").is_dir() {
            return;
        }
        assert_eq!(folder_from_args(["filepad.exe", r"C:\"]).as_deref(), Some(r"C:\"));
    }

    #[test]
    fn command_match_uses_the_quoted_program() {
        assert!(command_points_here(r#""C:\FilePad\filepad.exe" "%1""#, r"C:\FilePad\filepad.exe"));
        assert!(!command_points_here(r#""C:\Other\filepad.exe" "%1""#, r"C:\FilePad\filepad.exe"));
    }

    #[cfg(windows)]
    #[test]
    fn verb_roundtrip_uses_a_private_key() {
        let root = r"Software\FilePadFolderAppTest";
        let _guard = TreeGuard(root);
        let exe = r"C:\FilePad\filepad.exe";
        write_verb(root, exe).unwrap();
        assert!(verb_matches(root, exe));
        assert_eq!(read_named(&format!(r"{root}\FilePad"), "Position").as_deref(), Some("Top"));
        {
            let other = create_key(&format!(r"{root}\NordVPN-file-share")).unwrap();
            set_sz(other.0, Some("Position"), "Top").unwrap();
        }
        write_verb(root, exe).unwrap();
        assert!(read_named(&format!(r"{root}\NordVPN-file-share"), "Position").is_none());
        assert!(!verb_matches(root, r"C:\Other\filepad.exe"));
        {
            let key = create_key(&format!(r"{root}\win")).unwrap();
            set_sz(key.0, Some("DelegateExecute"), "").unwrap();
        }
        assert_eq!(read_named(&format!(r"{root}\win"), "DelegateExecute").as_deref(), Some(""));
        remove_verb(root).unwrap();
        assert!(!verb_matches(root, exe));
        assert!(read_default(root).is_none());
    }

    #[cfg(windows)]
    struct TreeGuard(&'static str);

    #[cfg(windows)]
    impl Drop for TreeGuard {
        fn drop(&mut self) {
            let _ = delete_tree(self.0);
        }
    }
}
