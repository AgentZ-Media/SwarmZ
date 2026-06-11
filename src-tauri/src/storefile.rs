//! Crash-safety net for the persisted store file (`swarmz.json`). The store
//! plugin writes it with a plain `fs::write` (no temp+rename) and silently
//! treats an unreadable file as empty — the app would then seed defaults and
//! overwrite it within seconds of launch: a silent factory reset losing
//! settings, usage history, workspaces, the session-restore snapshot and all
//! custom commands. This runs in `setup`, before the webview can touch the
//! store:
//!
//! - readable + valid JSON object → refresh `swarmz.json.bak`
//! - corrupt/truncated (power loss, disk-full mid-write) → move the evidence
//!   aside as `swarmz.json.corrupt-<ts>` and restore the last `.bak`

use std::fs;
use std::path::Path;

const STORE: &str = "swarmz.json";
const BACKUP: &str = "swarmz.json.bak";

fn is_valid_store(bytes: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(bytes).is_ok()
}

pub fn rescue(dir: &Path) {
    let store = dir.join(STORE);
    let bak = dir.join(BACKUP);
    match fs::read(&store) {
        Ok(bytes) if is_valid_store(&bytes) => {
            // good copy → refresh the backup, atomically (temp + rename) so
            // a crash *here* can never leave a torn backup either
            let tmp = dir.join(format!("{BACKUP}.tmp"));
            if fs::write(&tmp, &bytes).is_ok() {
                let _ = fs::rename(&tmp, &bak);
            }
        }
        Ok(_) => {
            // corrupt → keep the evidence, then fall back to the last good
            // backup (losing at most the changes since the previous launch)
            let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
            let _ = fs::rename(&store, dir.join(format!("{STORE}.corrupt-{ts}")));
            if let Ok(bak_bytes) = fs::read(&bak) {
                if is_valid_store(&bak_bytes) {
                    let _ = fs::write(&store, &bak_bytes);
                }
            }
        }
        // missing file = first launch — nothing to rescue
        Err(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        // timestamp + counter: parallel tests can start in the same clock
        // tick, and a shared dir makes them destroy each other's fixtures
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "swarmz-store-test-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn valid_store_refreshes_backup() {
        let dir = temp_dir();
        fs::write(dir.join(STORE), br#"{"settings":{"a":1}}"#).unwrap();
        rescue(&dir);
        assert_eq!(
            fs::read(dir.join(BACKUP)).unwrap(),
            br#"{"settings":{"a":1}}"#
        );
        // store untouched
        assert!(fs::read(dir.join(STORE)).is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_store_is_preserved_and_restored_from_backup() {
        let dir = temp_dir();
        fs::write(dir.join(BACKUP), br#"{"settings":{"a":1}}"#).unwrap();
        // truncated write, e.g. disk-full mid-save
        fs::write(dir.join(STORE), br#"{"settings":{"a"#).unwrap();
        rescue(&dir);
        // restored from backup …
        assert_eq!(
            fs::read(dir.join(STORE)).unwrap(),
            br#"{"settings":{"a":1}}"#
        );
        // … and the corrupt file kept as evidence
        let corrupt_kept = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().starts_with("swarmz.json.corrupt-"));
        assert!(corrupt_kept);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_store_without_backup_is_only_moved_aside() {
        let dir = temp_dir();
        fs::write(dir.join(STORE), b"\0\0\0").unwrap();
        rescue(&dir);
        // no backup to restore — the app starts fresh, but the evidence stays
        assert!(!dir.join(STORE).exists());
        let corrupt_kept = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().starts_with("swarmz.json.corrupt-"));
        assert!(corrupt_kept);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_store_is_a_noop() {
        let dir = temp_dir();
        rescue(&dir);
        assert!(!dir.join(STORE).exists());
        assert!(!dir.join(BACKUP).exists());
        fs::remove_dir_all(&dir).ok();
    }
}
