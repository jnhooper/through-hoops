import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauriEnvironment } from './db';

const MOCK_LOCAL_NODE_ID = 'local-node-8fa93c20b81e47d9023fbc8102a9';

/**
 * Fetches the local Iroh node's public key / Node ID from the Rust backend.
 */
export async function getMyNodeId(): Promise<string> {
  if (!isTauriEnvironment()) {
    console.info('Running in browser preview: returning simulated Iroh node ID.');
    return MOCK_LOCAL_NODE_ID;
  }

  try {
    return await invoke<string>('get_my_node_id');
  } catch (err) {
    console.error('Failed to get local Iroh node ID:', err);
    throw err;
  }
}

/**
 * Sends a signaling payload string (e.g. WebRTC SDP/candidate) to a remote Iroh node.
 */
export async function sendSignal(remoteId: string, payload: string): Promise<void> {
  if (!isTauriEnvironment()) {
    console.info(`[Mock Signal] Sent to ${remoteId}:`, payload);
    return;
  }

  try {
    // Tauri v2 converts snake_case Rust parameters to camelCase in JavaScript (remote_id -> remoteId)
    await invoke('send_signal', {
      remoteId: remoteId.trim(),
      payload,
    });
  } catch (err) {
    console.error(`Failed to send signal to ${remoteId}:`, err);
    throw err;
  }
}

/**
 * Listens for incoming Iroh signaling messages emitted by the Rust backend.
 */
export async function listenForIncomingSignals(
  callback: (payload: string) => void
): Promise<UnlistenFn> {
  if (!isTauriEnvironment()) {
    console.info('Browser preview: registered mock incoming_signal listener.');
    return () => {};
  }

  return await listen<string>('incoming_signal', (event) => {
    callback(event.payload);
  });
}
