use crate::avatar as avatars;
use std::collections::HashSet;
use std::path::PathBuf;
use std::str::FromStr;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LocalProfile {
    pub name: String,
    pub photo_path: Option<String>,
}

pub fn get_db_path(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let app_config_dir = app.path().app_config_dir()?;
    Ok(app_config_dir.join("contacts.db"))
}

pub async fn get_sqlite_pool(app: &AppHandle) -> anyhow::Result<sqlx::SqlitePool> {
    let db_path = get_db_path(app)?;
    let db_url = format!("sqlite:{}", db_path.to_string_lossy());
    let pool = sqlx::SqlitePool::connect(&db_url).await?;
    Ok(pool)
}

pub async fn query_local_profile(app: &AppHandle) -> anyhow::Result<LocalProfile> {
    let pool = get_sqlite_pool(app).await?;
    let row = sqlx::query("SELECT name, photo_path FROM local_profile WHERE id = 1")
        .fetch_optional(&pool)
        .await?;

    if let Some(r) = row {
        use sqlx::Row;
        let name: String = r.get("name");
        let photo_path: Option<String> = r.get("photo_path");
        Ok(LocalProfile { name, photo_path })
    } else {
        Ok(LocalProfile {
            name: String::new(),
            photo_path: None,
        })
    }
}

pub async fn upsert_local_profile(
    app: &AppHandle,
    name: &str,
    photo_path: Option<&str>,
) -> anyhow::Result<LocalProfile> {
    let pool = get_sqlite_pool(app).await?;
    sqlx::query("INSERT OR REPLACE INTO local_profile (id, name, photo_path) VALUES (1, $1, $2)")
        .bind(name)
        .bind(photo_path)
        .execute(&pool)
        .await?;

    Ok(LocalProfile {
        name: name.to_string(),
        photo_path: photo_path.map(|s| s.to_string()),
    })
}

pub async fn upsert_contact(
    app: &AppHandle,
    node_id: &str,
    name: &str,
    photo_path: Option<&str>,
) -> anyhow::Result<()> {
    let pool = get_sqlite_pool(app).await?;
    sqlx::query(
        "INSERT INTO contacts (iroh_node_id, name, photo_path, added_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT(iroh_node_id) DO UPDATE SET
             name = excluded.name,
             photo_path = excluded.photo_path",
    )
    .bind(node_id)
    .bind(name)
    .bind(photo_path)
    .execute(&pool)
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn get_local_profile(app: AppHandle) -> Result<LocalProfile, String> {
    query_local_profile(&app)
        .await
        .map_err(|e| format!("Failed to get local profile: {e}"))
}

#[tauri::command]
pub async fn save_local_profile(
    name: String,
    photo_path: Option<String>,
    app: AppHandle,
) -> Result<LocalProfile, String> {
    // The profile photo is sent to every peer, so only accept files inside our
    // own avatars directory (see avatar::ensure_within_dir).
    let photo_path = match photo_path.filter(|p| !p.trim().is_empty()) {
        Some(path) => {
            let dir = avatars::avatars_dir(&app)?;
            let canonical = avatars::ensure_within_dir(std::path::Path::new(&path), &dir).await?;
            Some(canonical.to_string_lossy().to_string())
        }
        None => None,
    };
    upsert_local_profile(&app, &name, photo_path.as_deref())
        .await
        .map_err(|e| format!("Failed to save local profile: {e}"))
}

/// Canonical node ID for filenames: the parsed EndpointId's string form when the
/// stored ID parses (rows added by hand may differ in case), else the raw ID.
fn canonical_node_id(node_id: &str) -> String {
    iroh::EndpointId::from_str(node_id.trim())
        .map(|id| id.to_string())
        .unwrap_or_else(|_| node_id.trim().to_string())
}

/// Deletes the contact row and its avatar file(s).
#[tauri::command]
pub async fn remove_contact(node_id: String, app: AppHandle) -> Result<(), String> {
    use sqlx::Row;

    let pool = get_sqlite_pool(&app)
        .await
        .map_err(|e| format!("Failed to open database: {e}"))?;
    let stored_photo: Option<String> =
        sqlx::query("SELECT photo_path FROM contacts WHERE iroh_node_id = $1")
            .bind(&node_id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| format!("Failed to look up contact: {e}"))?
            .and_then(|row| row.get("photo_path"));
    sqlx::query("DELETE FROM contacts WHERE iroh_node_id = $1")
        .bind(&node_id)
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to remove contact: {e}"))?;

    let dir = avatars::avatars_dir(&app)?;
    avatars::remove_contact_avatar_files(&dir, &canonical_node_id(&node_id), None).await;
    // Avatars saved before filenames were derived from the node ID used random
    // names; delete the stored one if it is a contact avatar in our directory.
    if let Some(stored) = stored_photo.map(PathBuf::from)
        && stored.parent() == Some(dir.as_path())
        && stored
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("contact-"))
        && let Err(err) = tokio::fs::remove_file(&stored).await
        && err.kind() != std::io::ErrorKind::NotFound
    {
        log::warn!("Unable to remove avatar {}: {err}", stored.display());
    }
    Ok(())
}

/// Best-effort startup sweep: deletes `avatars/contact-*` files that no contact
/// row references. Skips entirely if the contacts table can't be read, so a
/// missing or locked database never causes avatars to be deleted.
pub async fn cleanup_orphan_avatars(app: &AppHandle) {
    use sqlx::Row;

    let referenced = async {
        let pool = get_sqlite_pool(app).await?;
        let rows = sqlx::query("SELECT photo_path FROM contacts WHERE photo_path IS NOT NULL")
            .fetch_all(&pool)
            .await?;
        anyhow::Ok(
            rows.iter()
                .filter_map(|row| row.get::<Option<String>, _>("photo_path"))
                .filter_map(|p| {
                    PathBuf::from(p)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                })
                .collect::<HashSet<String>>(),
        )
    }
    .await;
    let referenced = match referenced {
        Ok(set) => set,
        Err(err) => {
            log::info!("Skipping orphan avatar cleanup: {err}");
            return;
        }
    };

    let dir = match avatars::avatars_dir(app) {
        Ok(dir) => dir,
        Err(err) => {
            log::warn!("Skipping orphan avatar cleanup: {err}");
            return;
        }
    };
    match avatars::remove_orphan_contact_avatars(&dir, &referenced).await {
        Ok(count) => log::info!("Removed {count} orphan contact avatar file(s)"),
        Err(err) => log::warn!("Orphan avatar cleanup failed: {err}"),
    }
}
