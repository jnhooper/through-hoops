use crate::db;
use anyhow::{Context, Result};
use iroh::endpoint::presets;
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointId, SecretKey};
use std::str::FromStr;
use tauri::{AppHandle, Emitter, Manager, State};

pub const SIGNALING_ALPN: &[u8] = b"/p2p-video-chat/signaling/0";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HandshakePayload {
    #[serde(rename = "type")]
    pub msg_type: String, // "handshake"
    pub node_id: String,
    pub name: String,
    pub photo_path: Option<String>,
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
}

impl ProtocolHandler for SignalingProtocolHandler {
    async fn accept(
        &self,
        connection: iroh::endpoint::Connection,
    ) -> std::result::Result<(), AcceptError> {
        let app = self.app_handle.clone();
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
                                tokio::spawn(async move {
                                    if let Ok(bytes) = recv.read_to_end(10 * 1024 * 1024).await {
                                        let payload = String::from_utf8_lossy(&bytes).to_string();
                                        log::info!("Received bi stream signal ({} bytes) from {peer}", payload.len());

                                        if let Ok(handshake) = serde_json::from_slice::<HandshakePayload>(&bytes)
                                            && handshake.msg_type == "handshake"
                                        {
                                            log::info!("Received handshake from peer {}: {}", peer, handshake.name);
                                            if let Ok(my_profile) = db::query_local_profile(&app_inner).await {
                                                let my_name = if my_profile.name.trim().is_empty() {
                                                    "Anonymous".to_string()
                                                } else {
                                                    my_profile.name.trim().to_string()
                                                };
                                                let reply = HandshakePayload {
                                                    msg_type: "handshake".to_string(),
                                                    node_id: peer.clone(),
                                                    name: my_name,
                                                    photo_path: my_profile.photo_path,
                                                };
                                                if let Ok(reply_bytes) = serde_json::to_vec(&reply) {
                                                    let _ = send.write_all(&reply_bytes).await;
                                                    let _ = send.finish();
                                                }
                                            }
                                        }

                                        if let Err(err) = app_inner.emit("incoming_signal", &payload) {
                                            log::error!("Failed to emit incoming_signal event: {err}");
                                        }
                                    }
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
                            Ok(mut recv) => {
                                let app_inner = app.clone();
                                let peer = remote_id.clone();
                                tokio::spawn(async move {
                                    match recv.read_to_end(10 * 1024 * 1024).await {
                                        Ok(bytes) => {
                                            let payload = String::from_utf8_lossy(&bytes).to_string();
                                            log::info!("Received signal ({} bytes) from {peer}", payload.len());
                                            if let Err(err) = app_inner.emit("incoming_signal", &payload) {
                                                log::error!("Failed to emit incoming_signal event: {err}");
                                            }
                                        }
                                        Err(err) => {
                                            log::warn!("Error reading incoming signaling stream: {err}");
                                        }
                                    }
                                });
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
        .secret_key(secret_key)
        .bind()
        .await
        .context("Failed to bind Iroh endpoint")?;

    log::info!("Iroh node bound with persistent Node ID: {}", endpoint.id());

    let router = Router::builder(endpoint.clone())
        .accept(SIGNALING_ALPN, SignalingProtocolHandler { app_handle })
        .spawn();

    Ok(SignalingState {
        endpoint,
        _router: router,
    })
}

#[tauri::command]
pub async fn get_my_node_id(
    state: State<'_, SignalingState>,
) -> std::result::Result<String, String> {
    Ok(state.endpoint.id().to_string())
}

#[tauri::command]
pub async fn send_signal(
    remote_id: String,
    payload: String,
    state: State<'_, SignalingState>,
) -> std::result::Result<(), String> {
    let endpoint_id = EndpointId::from_str(&remote_id)
        .map_err(|e| format!("Invalid remote Iroh node ID: {e}"))?;

    let conn = state
        .endpoint
        .connect(endpoint_id, SIGNALING_ALPN)
        .await
        .map_err(|e| format!("Failed to connect to remote node {remote_id}: {e}"))?;

    let mut send = conn
        .open_uni()
        .await
        .map_err(|e| format!("Failed to open stream to remote node: {e}"))?;

    send.write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("Failed to write payload to stream: {e}"))?;

    send.finish()
        .map_err(|e| format!("Failed to finish stream: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn perform_handshake(
    remote_id: String,
    app: AppHandle,
    state: State<'_, SignalingState>,
) -> std::result::Result<HandshakeResult, String> {
    let profile = db::query_local_profile(&app)
        .await
        .map_err(|e| format!("Failed to read local profile: {e}"))?;

    let my_name = if profile.name.trim().is_empty() {
        "Anonymous".to_string()
    } else {
        profile.name.trim().to_string()
    };

    let my_node_id = state.endpoint.id().to_string();

    let handshake_payload = HandshakePayload {
        msg_type: "handshake".to_string(),
        node_id: my_node_id,
        name: my_name,
        photo_path: profile.photo_path,
    };

    let payload_bytes = serde_json::to_vec(&handshake_payload)
        .map_err(|e| format!("Failed to serialize handshake payload: {e}"))?;

    let endpoint_id = EndpointId::from_str(&remote_id)
        .map_err(|e| format!("Invalid remote Iroh node ID: {e}"))?;

    let conn = state
        .endpoint
        .connect(endpoint_id, SIGNALING_ALPN)
        .await
        .map_err(|e| format!("Failed to connect to remote node {remote_id}: {e}"))?;

    match conn.open_bi().await {
        Ok((mut send, mut recv)) => {
            send.write_all(&payload_bytes)
                .await
                .map_err(|e| format!("Failed to send handshake: {e}"))?;
            send.finish()
                .map_err(|e| format!("Failed to finish handshake stream: {e}"))?;

            let resp_bytes = recv.read_to_end(10 * 1024 * 1024).await;
            let (remote_name, remote_photo_path) = match resp_bytes {
                Ok(bytes) if !bytes.is_empty() => {
                    if let Ok(resp_payload) = serde_json::from_slice::<HandshakePayload>(&bytes) {
                        (Some(resp_payload.name), resp_payload.photo_path)
                    } else {
                        (None, None)
                    }
                }
                _ => (None, None),
            };

            Ok(HandshakeResult {
                remote_node_id: remote_id,
                remote_name,
                remote_photo_path,
            })
        }
        Err(_) => {
            let mut send = conn
                .open_uni()
                .await
                .map_err(|e| format!("Failed to open uni stream to remote node: {e}"))?;

            send.write_all(&payload_bytes)
                .await
                .map_err(|e| format!("Failed to write handshake payload: {e}"))?;

            send.finish()
                .map_err(|e| format!("Failed to finish handshake stream: {e}"))?;

            Ok(HandshakeResult {
                remote_node_id: remote_id,
                remote_name: None,
                remote_photo_path: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secret_key_roundtrip() {
        let key = SecretKey::generate();
        let bytes = key.to_bytes();
        assert_eq!(bytes.len(), 32);

        let restored = SecretKey::from(bytes);
        assert_eq!(key.public(), restored.public());
    }
}
