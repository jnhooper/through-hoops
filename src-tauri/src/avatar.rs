use base64::{Engine as _, engine::general_purpose::STANDARD};
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

/// Reads the local avatar for an outbound handshake. Missing or invalid avatars
/// are omitted so they never prevent the exchange of profile names.
pub async fn load_local_avatar(photo_path: Option<&str>) -> Option<AvatarPayload> {
    let path = photo_path?;
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(err) => {
            log::warn!("Unable to read local avatar metadata at {path}: {err}");
            return None;
        }
    };
    if metadata.len() > MAX_AVATAR_BYTES as u64 {
        log::warn!("Local avatar at {path} exceeds the size limit; sending profile without it");
        return None;
    }

    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) => {
            log::warn!("Unable to read local avatar at {path}: {err}");
            return None;
        }
    };

    match AvatarPayload::from_bytes(&bytes) {
        Ok(avatar) => Some(avatar),
        Err(err) => {
            log::warn!("Unable to send local avatar at {path}: {err}");
            None
        }
    }
}

/// Saves an inbound avatar under a generated local filename and returns the path
/// to store in the contacts table. Invalid images are ignored, not persisted.
pub async fn save_received_avatar(
    app: &AppHandle,
    avatar: Option<&AvatarPayload>,
) -> Option<String> {
    let avatar = avatar?;
    let (bytes, extension) = match avatar.decode() {
        Ok(decoded) => decoded,
        Err(err) => {
            log::warn!("Ignoring invalid received avatar: {err}");
            return None;
        }
    };

    let avatars_dir = match app.path().app_data_dir() {
        Ok(dir) => dir.join("avatars"),
        Err(err) => {
            log::warn!("Unable to resolve avatar directory: {err}");
            return None;
        }
    };
    if let Err(err) = tokio::fs::create_dir_all(&avatars_dir).await {
        log::warn!(
            "Unable to create avatar directory {}: {err}",
            avatars_dir.display()
        );
        return None;
    }

    let path = avatars_dir.join(format!("contact-{}.{}", Uuid::new_v4(), extension));
    if let Err(err) = tokio::fs::write(&path, bytes).await {
        log::warn!(
            "Unable to save received avatar at {}: {err}",
            path.display()
        );
        return None;
    }

    Some(path.to_string_lossy().to_string())
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
}
