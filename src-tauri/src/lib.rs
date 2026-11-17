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
            sql: db::CREATE_CONTACTS_TABLE,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create_local_profile_table",
            sql: db::CREATE_LOCAL_PROFILE_TABLE,
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
            let cleanup_handle = app.handle().clone();

            // Rust owns one pool, created (with tables) before networking starts,
            // so an inbound handshake can save a contact before JS loads the DB.
            let db_path = db::get_db_path(app.handle())?;
            let pool = tauri::async_runtime::block_on(db::open_pool(&db_path))?;
            app.manage(db::Db(pool.clone()));

            // A failed node start must not crash the app: keep running with
            // signaling marked unavailable, and let Home show a banner.
            let networking = match tauri::async_runtime::block_on(signaling::init_node(app_handle))
            {
                Ok(state) => signaling::Networking::ready(state),
                Err(err) => {
                    log::error!("Failed to start networking: {err:#}");
                    signaling::Networking::unavailable(format!("{err:#}"))
                }
            };
            app.manage(networking);
            // Best-effort; runs after the schema above exists.
            tauri::async_runtime::spawn(async move {
                db::cleanup_orphan_avatars(&cleanup_handle, &pool).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            signaling::get_my_node_id,
            signaling::networking_error,
            signaling::send_signal,
            signaling::perform_handshake,
            db::get_local_profile,
            db::save_local_profile,
            db::remove_contact,
            avatar::import_local_avatar,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
