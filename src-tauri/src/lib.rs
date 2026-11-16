use tauri::Manager;
use tauri_plugin_sql::{Builder as SqlBuilder, Migration, MigrationKind};

pub mod avatar;
pub mod db;
pub mod signaling;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install the Rustls Ring crypto provider");

    // SAFETY: this runs before Tauri, Tokio, or Iroh starts any worker threads.
    unsafe { std::env::set_var("RUST_BACKTRACE", "1") };

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
        },
        Migration {
            version: 2,
            description: "create_local_profile_table",
            sql: "CREATE TABLE IF NOT EXISTS local_profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                name TEXT NOT NULL,
                photo_path TEXT
            );",
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        // .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Register the SQL plugin and run the migration on "contacts.db"
        .plugin(
            SqlBuilder::default()
                .add_migrations("sqlite:contacts.db", migrations)
                .build(),
        )
        // Setup persistent Iroh node and store in managed state
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let signaling_state = signaling::init_node(app_handle)
                    .await
                    .expect("failed to initialize persistent Iroh signaling node");
                app.manage(signaling_state);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            signaling::get_my_node_id,
            signaling::send_signal,
            signaling::perform_handshake,
            db::get_local_profile,
            db::save_local_profile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
