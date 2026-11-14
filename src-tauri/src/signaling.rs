use crate::{
    avatar::{AvatarPayload, load_local_avatar, save_received_avatar},
    db,
};
use anyhow::{Context, Result};
use iroh::endpoint::presets;
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointId, SecretKey};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use std::collections::HashMap;
use std::str::FromStr;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::RwLock;

pub const SIGNALING_ALPN: &[u8] = b"/p2p-video-chat/signaling/0";
const MAX_HANDSHAKE_BYTES: usize = 8 * 1024 * 1024;
const SIGNAL_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HandshakePayload {
    #[serde(rename = "type")]
    pub msg_type: String, // "handshake"
    pub node_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub photo: Option<AvatarPayload>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HandshakeResult {
    pub remote_node_id: String,
    pub remote_name: Option<String>,
    pub remote_photo_path: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SignalingProtocolHandler {
    app_handle: AppHandle,
    local_node_id: String,
}

fn normalized_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "Anonymous".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

async fn local_handshake(app: &AppHandle, node_id: String) -> Result<HandshakePayload, String> {
    let profile = db::query_local_profile(app)
        .await
        .map_err(|err| format!("Failed to read local profile: {err}"))?;
    let photo = load_local_avatar(profile.photo_path.as_deref()).await;

    Ok(HandshakePayload {
        msg_type: "handshake".to_string(),
        node_id,
        name: normalized_name(&profile.name),
        photo,
    })
}

async fn save_incoming_contact(app: &AppHandle, remote_id: &str, handshake: &HandshakePayload) {
    // The connection authenticates the peer ID; never trust the self-declared payload ID.
    let photo_path = save_received_avatar(app, handshake.photo.as_ref()).await;
    let name = normalized_name(&handshake.name);

    match db::upsert_contact(app, remote_id, &name, photo_path.as_deref()).await {
        Ok(()) => {
            log::info!("Added or updated contact for peer {remote_id}");
            if let Err(err) = app.emit("contacts_changed", ()) {
                log::error!("Failed to emit contacts_changed event: {err}");
            }
        }
        Err(err) => log::error!("Failed to save contact for peer {remote_id}: {err}"),
    }
}

async fn forward_uni_signal<R: tauri::Runtime>(
    app: AppHandle<R>,
    peer: String,
    mut recv: iroh::endpoint::RecvStream,
) {
    match recv.read_to_end(10 * 1024 * 1024).await {
        Ok(bytes) => {
            let payload = String::from_utf8_lossy(&bytes).to_string();
            log::info!("Received signal ({} bytes) from {peer}", payload.len());
            if let Err(err) = app.emit("incoming_signal", &payload) {
                log::error!("Failed to emit incoming_signal event: {err}");
            }
        }
        Err(err) => log::warn!("Error reading incoming signaling stream: {err}"),
    }
}

impl ProtocolHandler for SignalingProtocolHandler {
    async fn accept(
        &self,
        connection: iroh::endpoint::Connection,
    ) -> std::result::Result<(), AcceptError> {
        let app = self.app_handle.clone();
        let local_node_id = self.local_node_id.clone();
        tokio::spawn(async move {
            let remote_id = connection.remote_id().to_string();
            log::info!("Accepted Iroh connection from {remote_id}");

            loop {
                tokio::select! {
                    bi_res = connection.accept_bi() => {
                        match bi_res {
                            Ok((mut send, mut recv)) => {
                                let app_inner = app.clone();
                                let peer = remote_id.clone();
                                let local_id = local_node_id.clone();
                                tokio::spawn(async move {
                                    let bytes = match recv.read_to_end(MAX_HANDSHAKE_BYTES).await {
                                        Ok(bytes) => bytes,
                                        Err(err) => {
                                            log::warn!("Error reading incoming bi stream: {err}");
                                            return;
                                        }
                                    };
                                    log::info!("Received bi stream signal ({} bytes) from {peer}", bytes.len());

                                    if let Ok(handshake) = serde_json::from_slice::<HandshakePayload>(&bytes)
                                        && handshake.msg_type == "handshake"
                                    {
                                        log::info!("Received handshake from peer {}: {}", peer, handshake.name);
                                        save_incoming_contact(&app_inner, &peer, &handshake).await;

                                        match local_handshake(&app_inner, local_id).await {
                                            Ok(reply) => match serde_json::to_vec(&reply) {
                                                Ok(reply_bytes) => {
                                                    if let Err(err) = send.write_all(&reply_bytes).await {
                                                        log::warn!("Failed to send handshake reply to {peer}: {err}");
                                                    }
                                                }
                                                Err(err) => log::error!("Failed to serialize handshake reply: {err}"),
                                            },
                                            Err(err) => log::error!("Failed to build handshake reply: {err}"),
                                        }
                                        let _ = send.finish();
                                        return;
                                    }

                                    let payload = String::from_utf8_lossy(&bytes).to_string();
                                    if let Err(err) = app_inner.emit("incoming_signal", &payload) {
                                        log::error!("Failed to emit incoming_signal event: {err}");
                                    }
                                    let _ = send.finish();
                                });
                            }
                            Err(err) => {
                                log::debug!("Bi stream accept ended for {remote_id}: {err}");
                                break;
                            }
                        }
                    }
                    uni_res = connection.accept_uni() => {
                        match uni_res {
                            Ok(recv) => {
                                let app_inner = app.clone();
                                let peer = remote_id.clone();
                                tokio::spawn(forward_uni_signal(app_inner, peer, recv));
                            }
                            Err(err) => {
                                log::debug!("Uni stream accept ended for {remote_id}: {err}");
                                break;
                            }
                        }
                    }
                }
            }
        });

        Ok(())
    }
}

pub struct SignalingState {
    pub endpoint: Endpoint,
    pub connections: RwLock<HashMap<EndpointId, iroh::endpoint::Connection>>,
    pub _router: Router,
}

/// Loads an existing 32-byte secret key from `<app_data_dir>/node_secret.key`,
/// or generates a new one and saves it so the Node ID remains persistent.
async fn load_or_create_secret_key(app_handle: &AppHandle) -> Result<SecretKey> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .context("Failed to resolve app data directory")?;

    let key_file = app_data_dir.join("node_secret.key");

    if tokio::fs::try_exists(&key_file).await.unwrap_or(false) {
        let bytes = tokio::fs::read(&key_file).await.with_context(|| {
            format!("Failed to read secret key file from {}", key_file.display())
        })?;

        let key_bytes: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
            anyhow::anyhow!(
                "Invalid secret key file: expected 32 bytes, got {}",
                bytes.len()
            )
        })?;

        log::info!(
            "Loaded persistent Iroh secret key from {}",
            key_file.display()
        );
        Ok(SecretKey::from(key_bytes))
    } else {
        log::info!("No existing node secret key found. Generating a new persistent identity...");
        let secret_key = SecretKey::generate();

        tokio::fs::create_dir_all(&app_data_dir)
            .await
            .with_context(|| format!("Failed to create directory {}", app_data_dir.display()))?;

        tokio::fs::write(&key_file, secret_key.to_bytes())
            .await
            .with_context(|| format!("Failed to write secret key to {}", key_file.display()))?;

        log::info!(
            "Generated and saved new Iroh secret key to {}",
            key_file.display()
        );
        Ok(secret_key)
    }
}

pub async fn init_node(app_handle: AppHandle) -> Result<SignalingState> {
    let secret_key = load_or_create_secret_key(&app_handle).await?;

    let endpoint = Endpoint::builder(presets::N0)
        .address_lookup(MdnsAddressLookup::builder())
        .secret_key(secret_key)
        .bind()
        .await
        .context("Failed to bind Iroh endpoint")?;

    log::info!("Iroh node bound with persistent Node ID: {}", endpoint.id());

    let local_node_id = endpoint.id().to_string();
    let router = Router::builder(endpoint.clone())
        .accept(
            SIGNALING_ALPN,
            SignalingProtocolHandler {
                app_handle,
                local_node_id,
            },
        )
        .spawn();

    Ok(SignalingState {
        endpoint,
        connections: RwLock::new(HashMap::new()),
        _router: router,
    })
}

#[tauri::command]
pub async fn get_my_node_id(
    state: State<'_, SignalingState>,
) -> std::result::Result<String, String> {
    Ok(state.endpoint.id().to_string())
}

async fn get_or_create_connection(
    state: &SignalingState,
    endpoint_id: EndpointId,
    remote_id: &str,
) -> std::result::Result<iroh::endpoint::Connection, String> {
    let cached = state.connections.read().await.get(&endpoint_id).cloned();
    if let Some(conn) = cached {
        if conn.close_reason().is_none() {
            return Ok(conn);
        }
        state.connections.write().await.remove(&endpoint_id);
    }

    let conn = match tokio::time::timeout(
        SIGNAL_TIMEOUT,
        state.endpoint.connect(endpoint_id, SIGNALING_ALPN),
    )
    .await
    {
        Ok(Ok(conn)) => conn,
        Ok(Err(err)) => {
            tracing::warn!(peer = %remote_id, error = %err, "Peer unreachable during signaling dial");
            return Err(format!(
                "Failed to connect to remote node {remote_id}: {err}"
            ));
        }
        Err(_) => {
            tracing::warn!(peer = %remote_id, "Peer unreachable: signaling dial timed out");
            return Err(format!(
                "Peer {remote_id} is unreachable: connection timed out after 3 seconds"
            ));
        }
    };

    // Another signal may have dialed the same peer concurrently. Prefer an
    // already-pooled live connection instead of replacing it unnecessarily.
    let mut connections = state.connections.write().await;
    if let Some(existing) = connections.get(&endpoint_id)
        && existing.close_reason().is_none()
    {
        return Ok(existing.clone());
    }
    connections.insert(endpoint_id, conn.clone());
    Ok(conn)
}

#[tauri::command]
pub async fn send_signal(
    remote_id: String,
    payload: String,
    state: State<'_, SignalingState>,
) -> std::result::Result<(), String> {
    let endpoint_id = EndpointId::from_str(&remote_id)
        .map_err(|e| format!("Invalid remote Iroh node ID: {e}"))?;
    let conn = get_or_create_connection(&state, endpoint_id, &remote_id).await?;

    let (mut send, _recv) = tokio::time::timeout(SIGNAL_TIMEOUT, conn.open_bi())
        .await
        .map_err(|_| format!("Timed out opening stream to remote node {remote_id}"))?
        .map_err(|e| format!("Failed to open stream to remote node: {e}"))?;

    send.write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("Failed to write payload to stream: {e}"))?;
    send.finish()
        .map_err(|e| format!("Failed to finish stream: {e}"))?;

    // The pooled connection stays alive after this stream finishes, allowing the
    // next ICE candidate or call-control message to reuse it without another dial.
    Ok(())
}

#[tauri::command]
pub async fn perform_handshake(
    remote_id: String,
    app: AppHandle,
    state: State<'_, SignalingState>,
) -> std::result::Result<HandshakeResult, String> {
    let endpoint_id = EndpointId::from_str(&remote_id)
        .map_err(|err| format!("Invalid remote Iroh node ID: {err}"))?;
    if endpoint_id == state.endpoint.id() {
        return Err("You cannot add your own node as a contact".to_string());
    }

    let handshake_payload = local_handshake(&app, state.endpoint.id().to_string()).await?;
    let payload_bytes = serde_json::to_vec(&handshake_payload)
        .map_err(|err| format!("Failed to serialize handshake payload: {err}"))?;

    let conn = state
        .endpoint
        .connect(endpoint_id, SIGNALING_ALPN)
        .await
        .map_err(|err| format!("Failed to connect to remote node {remote_id}: {err}"))?;
    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|err| format!("Failed to open handshake stream: {err}"))?;

    send.write_all(&payload_bytes)
        .await
        .map_err(|err| format!("Failed to send handshake: {err}"))?;
    send.finish()
        .map_err(|err| format!("Failed to finish handshake stream: {err}"))?;

    let response_bytes = recv
        .read_to_end(MAX_HANDSHAKE_BYTES)
        .await
        .map_err(|err| format!("Failed to read handshake response: {err}"))?;
    let response = serde_json::from_slice::<HandshakePayload>(&response_bytes)
        .map_err(|err| format!("Invalid handshake response: {err}"))?;
    if response.msg_type != "handshake" {
        return Err("Peer returned an invalid handshake response".to_string());
    }

    let remote_photo_path = save_received_avatar(&app, response.photo.as_ref()).await;
    Ok(HandshakeResult {
        remote_node_id: remote_id,
        remote_name: Some(normalized_name(&response.name)),
        remote_photo_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tauri::Listener;

    #[derive(Clone, Debug)]
    struct MockSignalHandler {
        app: AppHandle<tauri::test::MockRuntime>,
    }

    impl ProtocolHandler for MockSignalHandler {
        async fn accept(
            &self,
            connection: iroh::endpoint::Connection,
        ) -> std::result::Result<(), AcceptError> {
            let app = self.app.clone();
            tokio::spawn(async move {
                if let Ok(recv) = connection.accept_uni().await {
                    forward_uni_signal(app, "test-peer".to_string(), recv).await;
                }
            });
            Ok(())
        }
    }

    #[test]
    fn test_secret_key_roundtrip() {
        let key = SecretKey::generate();
        let bytes = key.to_bytes();
        assert_eq!(bytes.len(), 32);

        let restored = SecretKey::from(bytes);
        assert_eq!(key.public(), restored.public());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn uni_signal_emits_incoming_call_event() {
        tokio::time::timeout(Duration::from_secs(20), async {
            let app = tauri::test::mock_app();
            let receiver = Endpoint::builder(presets::N0).bind().await.unwrap();
            let _router = Router::builder(receiver.clone())
                .accept(
                    SIGNALING_ALPN,
                    MockSignalHandler {
                        app: app.handle().clone(),
                    },
                )
                .spawn();

            let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
            app.handle().once("incoming_signal", move |event| {
                let payload = serde_json::from_str::<String>(event.payload()).unwrap();
                let _ = event_tx.send(payload);
            });

            let sender = Endpoint::builder(presets::N0).bind().await.unwrap();
            let payload = serde_json::json!({
                "type": "offer",
                "sdp": "test-offer",
                "sender": sender.id().to_string(),
            })
            .to_string();
            let connection = sender
                .connect(receiver.addr(), SIGNALING_ALPN)
                .await
                .unwrap();
            let mut stream = connection.open_uni().await.unwrap();
            stream.write_all(payload.as_bytes()).await.unwrap();
            stream.finish().unwrap();

            let received = tokio::time::timeout(Duration::from_secs(5), event_rx.recv())
                .await
                .expect("receiver did not emit incoming_signal");
            assert_eq!(received.as_deref(), Some(payload.as_str()));
        })
        .await
        .expect("two-node signaling test timed out");
    }
}
