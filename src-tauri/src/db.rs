use std::path::PathBuf;
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
    upsert_local_profile(&app, &name, photo_path.as_deref())
        .await
        .map_err(|e| format!("Failed to save local profile: {e}"))
}
