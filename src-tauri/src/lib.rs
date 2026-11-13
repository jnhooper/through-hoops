use tauri::Manager;
use tauri_plugin_sql::{Builder as SqlBuilder, Migration, MigrationKind};

pub mod signaling;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Define the database schema creation
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_contacts_table",
            sql: "CREATE TABLE IF NOT EXISTS contacts (
                iroh_node_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                photo_path TEXT,
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_called_at DATETIME
            );",
            kind: MigrationKind::Up,
        }
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        // Register the filesystem plugin
        .plugin(tauri_plugin_fs::init())
        // Register the SQL plugin and run the migration on "contacts.db"
        .plugin(
            SqlBuilder::default()
                .add_migrations("sqlite:contacts.db", migrations)
                .build()
        )
        // Setup in-memory Iroh node and store in managed state
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let signaling_state = signaling::init_node(app_handle)
                    .await
                    .expect("failed to initialize in-memory Iroh signaling node");
                app.manage(signaling_state);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            signaling::get_my_node_id,
            signaling::send_signal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
