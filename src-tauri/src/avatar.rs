use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub const MAX_AVATAR_BYTES: usize = 5 * 1024 * 1024;
const MAX_ENCODED_AVATAR_BYTES: usize = MAX_AVATAR_BYTES.div_ceil(3) * 4;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AvatarPayload {
    pub data: String,
    pub mime_type: String,
}

impl AvatarPayload {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_AVATAR_BYTES {
            return Err(format!(
                "Avatar exceeds the {} MiB size limit",
                MAX_AVATAR_BYTES / 1024 / 1024
            ));
        }

        let (mime_type, _) = detect_image_type(bytes)
            .ok_or_else(|| "Avatar must be a PNG, JPEG, GIF, or WebP image".to_string())?;

        Ok(Self {
            data: STANDARD.encode(bytes),
            mime_type: mime_type.to_string(),
        })
    }

    /// Decodes and validates untrusted avatar data, returning its bytes and safe extension.
    pub fn decode(&self) -> Result<(Vec<u8>, &'static str), String> {
        if self.data.len() > MAX_ENCODED_AVATAR_BYTES {
            return Err("Encoded avatar exceeds the size limit".to_string());
        }

        let bytes = STANDARD
            .decode(&self.data)
            .map_err(|err| format!("Invalid avatar encoding: {err}"))?;
        if bytes.len() > MAX_AVATAR_BYTES {
            return Err("Avatar exceeds the size limit".to_string());
        }

        let (detected_mime, extension) = detect_image_type(&bytes)
            .ok_or_else(|| "Avatar is not a supported image".to_string())?;
        if self.mime_type != detected_mime {
            return Err("Avatar MIME type does not match its contents".to_string());
        }

        Ok((bytes, extension))
    }
}

fn detect_image_type(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "gif"))
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else {
        None
    }
}

/// Canonicalizes `path` and returns it only if it lies inside `dir`. The local
/// profile's photo is sent to every peer, so it must never point elsewhere.
pub async fn ensure_within_dir(path: &Path, dir: &Path) -> Result<PathBuf, String> {
    let canonical_dir = tokio::fs::canonicalize(dir)
        .await
        .map_err(|err| format!("Avatar directory {} is unavailable: {err}", dir.display()))?;
    let canonical = tokio::fs::canonicalize(path)
        .await
        .map_err(|err| format!("Photo path {} is not readable: {err}", path.display()))?;
    if canonical.starts_with(&canonical_dir) && canonical != canonical_dir {
        Ok(canonical)
    } else {
        Err(format!(
            "Photo path {} must be inside {}",
            path.display(),
            dir.display()
        ))
    }
}

/// Reads the local avatar for an outbound handshake. Missing or invalid avatars
/// are omitted so they never prevent the exchange of profile names.
pub async fn load_local_avatar<R: tauri::Runtime>(
    app: &AppHandle<R>,
    photo_path: Option<&str>,
) -> Option<AvatarPayload> {
    let requested = photo_path?;
    // Defense in depth: save_local_profile already enforces this.
    let checked = match avatars_dir(app) {
        Ok(dir) => ensure_within_dir(Path::new(requested), &dir).await,
        Err(err) => Err(err),
    };
    let path_buf = match checked {
        Ok(path) => path,
        Err(err) => {
            log::warn!("Not sending local avatar: {err}");
            return None;
        }
    };
    let path = path_buf.as_path();
    let path_display = path.display();
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(err) => {
            log::warn!("Unable to read local avatar metadata at {path_display}: {err}");
            return None;
        }
    };
    if metadata.len() > MAX_AVATAR_BYTES as u64 {
        log::warn!(
            "Local avatar at {path_display} exceeds the size limit; sending profile without it"
        );
        return None;
    }

    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) => {
            log::warn!("Unable to read local avatar at {path_display}: {err}");
            return None;
        }
    };

    match AvatarPayload::from_bytes(&bytes) {
        Ok(avatar) => Some(avatar),
        Err(err) => {
            log::warn!("Unable to send local avatar at {path_display}: {err}");
            None
        }
    }
}

const AVATAR_EXTENSIONS: [&str; 4] = ["png", "jpg", "gif", "webp"];
const CONTACT_AVATAR_PREFIX: &str = "contact-";

/// Resolves (without creating) `<app_data_dir>/avatars`.
pub fn avatars_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("avatars"))
        .map_err(|err| format!("Unable to resolve avatar directory: {err}"))
}

/// Node IDs become part of a filename, so only accept plain alphanumerics.
fn is_safe_file_stem(node_id: &str) -> bool {
    !node_id.is_empty()
        && node_id.len() <= 128
        && node_id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Writes `contact-<node_id>.<ext>` atomically (temp file + rename) and removes
/// any avatar for the same node with a different extension, so each contact has
/// at most one avatar file no matter how often it re-handshakes.
pub async fn write_contact_avatar(
    dir: &Path,
    node_id: &str,
    bytes: &[u8],
    extension: &str,
) -> Result<PathBuf, String> {
    if !is_safe_file_stem(node_id) {
        return Err(format!(
            "Refusing to build an avatar filename from node ID {node_id:?}"
        ));
    }
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|err| format!("Unable to create avatar directory {}: {err}", dir.display()))?;

    let final_path = dir.join(format!("{CONTACT_AVATAR_PREFIX}{node_id}.{extension}"));
    // The temp name keeps the contact- prefix so a crash mid-write leaves a file
    // that the startup orphan sweep removes.
    let tmp_path = dir.join(format!(
        "{CONTACT_AVATAR_PREFIX}{node_id}.{extension}.tmp-{}",
        Uuid::new_v4()
    ));
    if let Err(err) = tokio::fs::write(&tmp_path, bytes).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!(
            "Unable to write avatar {}: {err}",
            tmp_path.display()
        ));
    }
    if let Err(err) = tokio::fs::rename(&tmp_path, &final_path).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!(
            "Unable to move avatar into place at {}: {err}",
            final_path.display()
        ));
    }

    remove_contact_avatar_files(dir, node_id, Some(extension)).await;
    Ok(final_path)
}

/// Deletes `contact-<node_id>.<ext>` for every supported extension except `keep`.
pub async fn remove_contact_avatar_files(dir: &Path, node_id: &str, keep: Option<&str>) {
    if !is_safe_file_stem(node_id) {
        return;
    }
    for ext in AVATAR_EXTENSIONS {
        if Some(ext) == keep {
            continue;
        }
        let path = dir.join(format!("{CONTACT_AVATAR_PREFIX}{node_id}.{ext}"));
        match tokio::fs::remove_file(&path).await {
            Ok(()) => log::info!("Removed stale avatar {}", path.display()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => log::warn!("Unable to remove avatar {}: {err}", path.display()),
        }
    }
}

/// Saves an inbound avatar as `avatars/contact-<node_id>.<ext>` and returns the
/// path to store in the contacts table. Invalid or missing images are not
/// persisted, and any previous avatar file for the node is removed.
pub async fn save_received_avatar(
    app: &AppHandle,
    node_id: &str,
    avatar: Option<&AvatarPayload>,
) -> Option<String> {
    let dir = match avatars_dir(app) {
        Ok(dir) => dir,
        Err(err) => {
            log::warn!("{err}");
            return None;
        }
    };

    let decoded = avatar.map(AvatarPayload::decode);
    let (bytes, extension) = match decoded {
        Some(Ok(decoded)) => decoded,
        Some(Err(err)) => {
            log::warn!("Ignoring invalid received avatar: {err}");
            remove_contact_avatar_files(&dir, node_id, None).await;
            return None;
        }
        None => {
            // The contact row's photo_path becomes NULL; drop the old file too.
            remove_contact_avatar_files(&dir, node_id, None).await;
            return None;
        }
    };

    match write_contact_avatar(&dir, node_id, &bytes, extension).await {
        Ok(path) => Some(path.to_string_lossy().to_string()),
        Err(err) => {
            log::warn!("{err}");
            None
        }
    }
}

/// Deletes `avatars/contact-*` files whose name is not in `referenced` (file
/// names, not paths). Returns how many files were removed.
pub async fn remove_orphan_contact_avatars(
    dir: &Path,
    referenced: &HashSet<String>,
) -> std::io::Result<usize> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(err) => return Err(err),
    };
    let mut removed = 0;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(CONTACT_AVATAR_PREFIX) || referenced.contains(&name) {
            continue;
        }
        if !entry
            .file_type()
            .await
            .map(|t| t.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        match tokio::fs::remove_file(entry.path()).await {
            Ok(()) => removed += 1,
            Err(err) => log::warn!("Unable to remove orphan avatar {name}: {err}"),
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_HEADER: &[u8] = b"\x89PNG\r\n\x1a\n";

    #[test]
    fn avatar_roundtrip_preserves_bytes() {
        let mut bytes = PNG_HEADER.to_vec();
        bytes.extend_from_slice(b"test-image-data");

        let payload = AvatarPayload::from_bytes(&bytes).unwrap();
        assert_eq!(payload.mime_type, "image/png");
        let (decoded, extension) = payload.decode().unwrap();

        assert_eq!(decoded, bytes);
        assert_eq!(extension, "png");
    }

    #[test]
    fn avatar_rejects_unsupported_data() {
        assert!(AvatarPayload::from_bytes(b"<svg>not allowed</svg>").is_err());
    }

    #[test]
    fn avatar_rejects_mime_type_spoofing() {
        let mut payload = AvatarPayload::from_bytes(PNG_HEADER).unwrap();
        payload.mime_type = "image/jpeg".to_string();

        assert!(payload.decode().is_err());
    }

    #[test]
    fn avatar_rejects_oversized_data() {
        let bytes = vec![0; MAX_AVATAR_BYTES + 1];
        assert!(AvatarPayload::from_bytes(&bytes).is_err());
    }

    fn scratch_dir() -> PathBuf {
        std::env::temp_dir().join(format!("through-hoops-avatar-test-{}", Uuid::new_v4()))
    }

    fn file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn repeated_handshakes_leave_one_avatar_file() {
        let dir = scratch_dir();
        let node = "abc123";
        let mut png = PNG_HEADER.to_vec();
        png.extend_from_slice(b"x");
        let jpg = [0xff, 0xd8, 0xff, 0x00];

        for i in 0..100 {
            let (bytes, ext): (&[u8], &str) = if i % 2 == 0 {
                (&png, "png")
            } else {
                (&jpg, "jpg")
            };
            write_contact_avatar(&dir, node, bytes, ext).await.unwrap();
        }

        assert_eq!(file_names(&dir), vec!["contact-abc123.jpg".to_string()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn rejects_unsafe_node_id_in_filename() {
        let dir = scratch_dir();
        assert!(
            write_contact_avatar(&dir, "../evil", PNG_HEADER, "png")
                .await
                .is_err()
        );
        assert!(!dir.join("../evil.png").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn orphan_sweep_keeps_referenced_and_unrelated_files() {
        let dir = scratch_dir();
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "contact-keep.png",
            "contact-orphan.jpg",
            "contact-x.png.tmp-1",
            "profile.png",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let referenced = HashSet::from(["contact-keep.png".to_string()]);

        let removed = remove_orphan_contact_avatars(&dir, &referenced)
            .await
            .unwrap();

        assert_eq!(removed, 2);
        assert_eq!(
            file_names(&dir),
            vec!["contact-keep.png".to_string(), "profile.png".to_string()]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn photo_path_outside_avatar_dir_is_rejected() {
        let dir = scratch_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let inside = dir.join("profile.png");
        std::fs::write(&inside, PNG_HEADER).unwrap();

        assert!(ensure_within_dir(&inside, &dir).await.is_ok());
        assert!(
            ensure_within_dir(Path::new("/etc/hosts"), &dir)
                .await
                .is_err()
        );
        assert!(ensure_within_dir(&dir.join("../"), &dir).await.is_err());
        assert!(ensure_within_dir(&dir, &dir).await.is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
