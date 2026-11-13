use std::str::FromStr;
use iroh::endpoint::presets;
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointId};
use tauri::{AppHandle, Emitter, State};

pub const SIGNALING_ALPN: &[u8] = b"/p2p-video-chat/signaling/0";

#[derive(Clone, Debug)]
pub struct SignalingProtocolHandler {
    app_handle: AppHandle,
}

impl ProtocolHandler for SignalingProtocolHandler {
    async fn accept(&self, connection: iroh::endpoint::Connection) -> Result<(), AcceptError> {
        let app = self.app_handle.clone();
        tokio::spawn(async move {
            let remote_id = connection.remote_id().to_string();
            log::info!("Accepted Iroh connection from {remote_id}");

            loop {
                match connection.accept_uni().await {
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
                        log::debug!("Iroh connection closed with {remote_id}: {err}");
                        break;
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

pub async fn init_node(app_handle: AppHandle) -> Result<SignalingState, Box<dyn std::error::Error + Send + Sync>> {
    let endpoint = Endpoint::builder(presets::N0).bind().await?;
    let router = Router::builder(endpoint.clone())
        .accept(SIGNALING_ALPN, SignalingProtocolHandler { app_handle })
        .spawn();

    Ok(SignalingState {
        endpoint,
        _router: router,
    })
}

#[tauri::command]
pub async fn get_my_node_id(state: State<'_, SignalingState>) -> Result<String, String> {
    Ok(state.endpoint.id().to_string())
}

#[tauri::command]
pub async fn send_signal(
    remote_id: String,
    payload: String,
    state: State<'_, SignalingState>,
) -> Result<(), String> {
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
