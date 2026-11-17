import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignalMessage } from '../types/signaling';

// Run as if inside Tauri, and capture the handler registered with listen().
vi.mock('./db', () => ({ isTauriEnvironment: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

type Handler = (event: { payload: unknown }) => void;
const registered: { name: string; handler: Handler; unlisten: () => void }[] = [];
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    const unlisten = vi.fn();
    registered.push({ name, handler, unlisten });
    return unlisten;
  }),
}));

import {
  bufferCandidate,
  clearBufferedCandidates,
  isFromPeer,
  listenForIncomingSignals,
  parseIncomingSignal,
  takeBufferedCandidates,
} from './signaling';

const PEER = 'ABCDEF0123456789';
const cand = (n: number): RTCIceCandidateInit => ({ candidate: `candidate:${n}`, sdpMid: '0' });

describe('candidate buffer', () => {
  beforeEach(() => {
    takeBufferedCandidates(PEER);
    takeBufferedCandidates('other');
  });

  it('returns buffered candidates in order, then empties', () => {
    bufferCandidate(PEER, cand(1));
    bufferCandidate(PEER, cand(2));

    expect(takeBufferedCandidates(PEER)).toEqual([cand(1), cand(2)]);
    expect(takeBufferedCandidates(PEER)).toEqual([]);
  });

  it('keys are case-insensitive and trimmed', () => {
    bufferCandidate(PEER, cand(1));
    bufferCandidate(` ${PEER.toLowerCase()} `, cand(2));

    expect(takeBufferedCandidates(PEER.toLowerCase())).toEqual([cand(1), cand(2)]);
  });

  it('keeps senders separate', () => {
    bufferCandidate(PEER, cand(1));
    bufferCandidate('other', cand(2));

    expect(takeBufferedCandidates('other')).toEqual([cand(2)]);
    expect(takeBufferedCandidates(PEER)).toEqual([cand(1)]);
  });

  it('clear discards without returning, case-insensitively', () => {
    bufferCandidate(PEER, cand(1));
    clearBufferedCandidates(PEER.toLowerCase());

    expect(takeBufferedCandidates(PEER)).toEqual([]);
  });

  it('take on an unknown sender returns an empty list', () => {
    expect(takeBufferedCandidates('nobody')).toEqual([]);
  });
});

describe('isFromPeer', () => {
  const signal = (sender?: string): SignalMessage => ({ type: 'offer', sender });

  it('matches case-insensitively', () => {
    expect(isFromPeer(signal(PEER), PEER.toLowerCase())).toBe(true);
  });

  it('rejects a different peer', () => {
    expect(isFromPeer(signal('someone-else'), PEER)).toBe(false);
  });

  it('rejects missing sender or missing peer id', () => {
    expect(isFromPeer(signal(undefined), PEER)).toBe(false);
    expect(isFromPeer(signal(PEER), '')).toBe(false);
    expect(isFromPeer(signal(PEER), null)).toBe(false);
    expect(isFromPeer(signal(PEER), undefined)).toBe(false);
  });
});

describe('parseIncomingSignal', () => {
  it('overwrites a self-declared sender with the authenticated one', () => {
    const signal = parseIncomingSignal({
      from: 'real-peer',
      payload: JSON.stringify({ type: 'hangup', sender: 'forged-peer', reason: 'ended' }),
    });

    expect(signal).toEqual({ type: 'hangup', sender: 'real-peer', reason: 'ended' });
  });

  it('sets sender even when the payload has none', () => {
    const signal = parseIncomingSignal({
      from: 'real-peer',
      payload: JSON.stringify({ type: 'ring' }),
    });

    expect(signal?.sender).toBe('real-peer');
  });

  it.each([
    ['not JSON', 'not json {'],
    ['a JSON string', '"offer"'],
    ['null', 'null'],
    ['an array', '[{"type":"offer"}]'],
    ['an object with no type', '{"sdp":"x"}'],
    ['an object with a non-string type', '{"type":5}'],
  ])('drops a payload that is %s', (_label, payload) => {
    expect(parseIncomingSignal({ from: 'p', payload })).toBeNull();
  });
});

describe('listenForIncomingSignals', () => {
  beforeEach(() => {
    registered.length = 0;
  });

  it('listens on incoming_signal and delivers parsed signals with the authenticated sender', async () => {
    const callback = vi.fn();
    await listenForIncomingSignals(callback);

    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('incoming_signal');

    registered[0].handler({
      payload: {
        from: 'real-peer',
        payload: JSON.stringify({ type: 'offer', sdp: 'v=0', sender: 'forged-peer' }),
      },
    });

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({ type: 'offer', sdp: 'v=0', sender: 'real-peer' });
  });

  it('silently drops malformed payloads', async () => {
    const callback = vi.fn();
    await listenForIncomingSignals(callback);

    registered[0].handler({ payload: { from: 'p', payload: 'garbage' } });
    registered[0].handler({ payload: { from: 'p', payload: '{"no":"type"}' } });

    expect(callback).not.toHaveBeenCalled();
  });

  it('returns the unlisten function so callers can tear down', async () => {
    const unlisten = await listenForIncomingSignals(vi.fn());

    expect(unlisten).toBe(registered[0].unlisten);
  });
});
