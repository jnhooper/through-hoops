import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauriEnvironment } from './db';
import type { SignalMessage } from '../types/signaling';

const MOCK_LOCAL_NODE_ID = 'local-node-8fa93c20b81e47d9023fbc8102a9';

// The caller trickles ICE candidates as soon as it creates its offer, usually
// while the callee is still on the incoming-call screen (or waiting on the
// camera permission prompt) and has no RTCPeerConnection to add them to.
// Dropping them leaves the callee unable to punch through NAT, so buffer them
// per sender until ActiveCall drains them.
const bufferedCandidates = new Map<string, RTCIceCandidateInit[]>();

export function bufferCandidate(sender: string, candidate: RTCIceCandidateInit): void {
  const key = sender.trim().toLowerCase();
  const list = bufferedCandidates.get(key) ?? [];
  list.push(candidate);
  bufferedCandidates.set(key, list);
}

export function takeBufferedCandidates(sender: string): RTCIceCandidateInit[] {
  const key = sender.trim().toLowerCase();
  const list = bufferedCandidates.get(key) ?? [];
  bufferedCandidates.delete(key);
  return list;
}

export function clearBufferedCandidates(sender: string): void {
  bufferedCandidates.delete(sender.trim().toLowerCase());
}

/** True when the signal's (authenticated) sender is `peerId`, ignoring case. */
export function isFromPeer(signal: SignalMessage, peerId: string | null | undefined): boolean {
  if (!signal.sender || !peerId) return false;
  return signal.sender.trim().toLowerCase() === peerId.trim().toLowerCase();
}

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

/** Envelope emitted by Rust: `from` is the iroh-authenticated peer ID. */
export interface IncomingSignalEnvelope {
  from: string;
  payload: string;
}

/**
 * Parses an incoming envelope into a SignalMessage whose `sender` is the
 * authenticated peer ID. Any self-declared `sender` in the payload is
 * overwritten. Returns null for payloads that are not JSON objects with a type.
 */
export function parseIncomingSignal(envelope: IncomingSignalEnvelope): SignalMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope.payload);
  } catch {
    console.debug('[signaling] Dropping non-JSON signal from', envelope.from);
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== 'string'
  ) {
    console.debug('[signaling] Dropping signal without a type from', envelope.from);
    return null;
  }
  return { ...(parsed as SignalMessage), sender: envelope.from };
}

/**
 * Listens for incoming Iroh signaling messages emitted by the Rust backend.
 * The callback receives only well-formed signals, with `sender` set to the
 * authenticated peer ID.
 */
export async function listenForIncomingSignals(
  callback: (signal: SignalMessage) => void
): Promise<UnlistenFn> {
  if (!isTauriEnvironment()) {
    console.info('Browser preview: registered mock incoming_signal listener.');
    return () => {};
  }

  return await listen<IncomingSignalEnvelope>('incoming_signal', (event) => {
    const signal = parseIncomingSignal(event.payload);
    if (signal) callback(signal);
  });
}
