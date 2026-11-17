import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  PhoneOff,
  ArrowLeft,
  Monitor,
  ShieldCheck,
  Signal,
  Volume2,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import type { Contact } from '../types/contact';
import type { HangupReason, SignalMessage } from '../types/signaling';
import {
  getMyNodeId,
  sendSignal,
  listenForIncomingSignals,
  takeBufferedCandidates,
  clearBufferedCandidates,
} from '../services/signaling';

interface ActiveCallProps {
  contact: Contact | null;
  onEndCall: () => void;
  isIncoming?: boolean;
  initialSignal?: SignalMessage | null;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function describeCandidate(candidate: RTCIceCandidateInit): string {
  const raw = candidate.candidate || '';
  const type = raw.match(/\btyp\s+(\w+)/)?.[1] || 'unknown';
  const protocol = raw.match(/\b(udp|tcp)\b/i)?.[1].toUpperCase() || 'unknown';
  // candidate:<foundation> <component> <protocol> <priority> <address> <port> typ ...
  const address = raw.split(/\s+/)[4] || 'unknown';
  const mdns = address.endsWith('.local') ? ' [mDNS-obfuscated]' : '';
  return `${type}/${protocol} ${address}${mdns}`;
}

// Logs which candidate pair ICE selected or, on failure, every pair it tried.
async function logIcePairs(pc: RTCPeerConnection, label: string): Promise<void> {
  try {
    const stats = await pc.getStats();
    const byId = new Map<string, Record<string, unknown>>();
    stats.forEach((s) => byId.set(s.id, s as Record<string, unknown>));
    const fmt = (id: unknown) => {
      const c = byId.get(String(id));
      return c ? `${c.candidateType}/${c.protocol} ${c.address ?? c.ip}:${c.port}` : '?';
    };
    let pairCount = 0;
    stats.forEach((s) => {
      if (s.type !== 'candidate-pair') return;
      pairCount += 1;
      const p = s as Record<string, unknown>;
      console.info(
        `[DEBUG-ice] ${label} pair ${fmt(p.localCandidateId)} -> ${fmt(p.remoteCandidateId)} state=${p.state} nominated=${p.nominated}`
      );
    });
    if (pairCount === 0) console.info(`[DEBUG-ice] ${label}: no candidate pairs in stats`);
  } catch (err) {
    console.warn('[DEBUG-ice] getStats failed:', err);
  }
}

export const ActiveCall: React.FC<ActiveCallProps> = ({
  contact,
  onEndCall,
  isIncoming = false,
  initialSignal = null,
}) => {
  const [seconds, setSeconds] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<
    'initializing' | 'connecting' | 'connected' | 'disconnected' | 'failed'
  >('initializing');
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [remoteNodeId, setRemoteNodeId] = useState<string>(
    contact?.iroh_node_id || initialSignal?.sender || ''
  );

  // Video element references
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  // WebRTC references
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const myNodeIdRef = useRef<string>('');
  const remoteNodeIdRef = useRef<string>(contact?.iroh_node_id || initialSignal?.sender || '');
  const iceCandidatesQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const seenRemoteCandidatesRef = useRef<Set<string>>(new Set());
  const isCallEndedRef = useRef<boolean>(false);
  const hasSentHangupRef = useRef<boolean>(false);
  const hasConnectedRef = useRef<boolean>(false);
  const initializationIdRef = useRef(0);
  const disconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Timer
  useEffect(() => {
    const interval = setInterval(() => {
      setSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatDuration = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const clearDisconnectTimeout = useCallback(() => {
    if (disconnectTimeoutRef.current) {
      clearTimeout(disconnectTimeoutRef.current);
      disconnectTimeoutRef.current = null;
    }
  }, []);

  // Resource-only teardown is also used by React's effect cleanup. It never signals.
  const cleanup = useCallback(() => {
    isCallEndedRef.current = true;
    clearDisconnectTimeout();

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {
          console.warn('Error stopping local track:', e);
        }
      });
      localStreamRef.current = null;
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {
          console.warn('Error stopping screen track:', e);
        }
      });
      screenStreamRef.current = null;
    }

    if (pcRef.current) {
      const pc = pcRef.current;
      pc.getSenders().forEach((sender) => {
        try {
          sender.track?.stop();
        } catch (e) {
          console.warn('Error stopping WebRTC sender track:', e);
        }
      });
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.oniceconnectionstatechange = null;
      pc.onicegatheringstatechange = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch (e) {
        console.warn('Error closing peer connection:', e);
      }
      pcRef.current = null;
    }

    iceCandidatesQueueRef.current = [];
    seenRemoteCandidatesRef.current.clear();
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }, [clearDisconnectTimeout]);

  // All user-facing and remote-triggered exits converge here. The guard makes
  // teardown idempotent and ensures an inbound hangup is never echoed back.
  const cleanupCall = useCallback(() => {
    if (isCallEndedRef.current) return;
    cleanup();
    // Only on a real call end — React effect teardown (StrictMode) must not
    // discard candidates the remount still needs.
    if (remoteNodeIdRef.current) clearBufferedCandidates(remoteNodeIdRef.current);
    onEndCall();
  }, [cleanup, onEndCall]);

  const sendHangup = useCallback(async (reason: HangupReason) => {
    if (hasSentHangupRef.current) return;
    const remoteId = remoteNodeIdRef.current;
    if (!remoteId) return;
    hasSentHangupRef.current = true;

    try {
      const sender = myNodeIdRef.current || (await getMyNodeId());
      myNodeIdRef.current = sender;
      await sendSignal(remoteId, JSON.stringify({ type: 'hangup', reason, sender }));
    } catch (err) {
      console.debug('[WebRTC] Hangup signal could not be delivered:', err);
    }
  }, []);

  const handleHangUp = useCallback(() => {
    void sendHangup(hasConnectedRef.current ? 'ended' : 'cancelled');
    cleanupCall();
  }, [sendHangup, cleanupCall]);

  // Listen for hangups independently of WebRTC initialization so a cancellation
  // cannot be missed while media devices or SDP are still being initialized.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    listenForIncomingSignals((signal) => {
      const currentPeer = remoteNodeIdRef.current;
      if (
        signal.type === 'hangup' &&
        signal.sender &&
        currentPeer &&
        signal.sender.toLowerCase() === currentPeer.toLowerCase()
      ) {
        cleanupCall();
      }
    })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((err: unknown) => {
        console.warn('[WebRTC] Failed to listen for hangup signals:', err);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [cleanupCall]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      void sendHangup(hasConnectedRef.current ? 'ended' : 'cancelled');
      cleanupCall();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [sendHangup, cleanupCall]);

  // Main WebRTC Initialization & Lifecycle
  useEffect(() => {
    let unlistenSignals: (() => void) | undefined;
    const initializationId = ++initializationIdRef.current;
    const isStaleInitialization = () =>
      isCallEndedRef.current || initializationIdRef.current !== initializationId;
    isCallEndedRef.current = false;
    hasSentHangupRef.current = false;
    hasConnectedRef.current = false;

    async function initWebRTC() {
      try {
        // 1. Fetch our local Iroh Node ID for signaling headers
        const myId = await getMyNodeId();
        myNodeIdRef.current = myId;
        if (isStaleInitialization()) return;

        // Ring before touching camera hardware so the peer can show its incoming
        // call UI immediately. The SDP offer follows once local media is ready.
        if (!isIncoming && remoteNodeIdRef.current) {
          void sendSignal(
            remoteNodeIdRef.current,
            JSON.stringify({ type: 'ring', sender: myId })
          ).catch((err) => {
            console.warn('[WebRTC] Early ring signal failed:', err);
          });
        }

        // 2. Capture Local Media (Camera & Mic). Every await is followed by
        // an immediate stale/unmounted check before the stream can be attached.
        let localStream: MediaStream;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
          });
          if (isStaleInitialization()) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          localStream = stream;
        } catch (mediaErr) {
          console.warn('Could not access user media with both video/audio:', mediaErr);
          if (isStaleInitialization()) return;

          // Fall back to audio only if video is unavailable.
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              video: false,
              audio: true,
            });
            if (isStaleInitialization()) {
              stream.getTracks().forEach((track) => track.stop());
              return;
            }
            localStream = stream;
            setIsVideoOff(true);
          } catch (audioOnlyErr) {
            if (isStaleInitialization()) return;
            console.error('Failed to capture audio/video:', audioOnlyErr);
            setMediaError(
              window.isSecureContext && navigator.mediaDevices
                ? 'Could not access camera or microphone.'
                : 'Camera/microphone unavailable: page is not a secure context.'
            );
            localStream = new MediaStream();
          }
        }

        localStreamRef.current = localStream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStream;
        }

        // 3. Initialize RTCPeerConnection with STUN servers
        const pc = new RTCPeerConnection(RTC_CONFIG);
        pcRef.current = pc;
        setConnectionStatus('connecting');

        // Add local tracks to peer connection
        localStream.getTracks().forEach((track) => {
          pc.addTrack(track, localStream);
        });

        // If camera/mic capture failed (permission denied, or no
        // navigator.mediaDevices in an insecure context such as an Android dev
        // build served from http://<lan-ip>:5173), the offer would contain no
        // media sections and ICE would never start. The caller always
        // negotiates audio+video so the call still connects and receives.
        // The callee must not do this: transceivers created by addTransceiver
        // are not matched to the remote offer's m-lines.
        if (!isIncoming) {
          for (const kind of ['audio', 'video'] as const) {
            const hasKind = pc.getTransceivers().some((t) => t.receiver.track.kind === kind);
            if (!hasKind) pc.addTransceiver(kind, { direction: 'recvonly' });
          }
        }

        // 4. Handle incoming remote tracks
        pc.ontrack = (event) => {
          console.info('[WebRTC] Received remote track:', event.track.kind);
          if (event.streams && event.streams[0]) {
            if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = event.streams[0];
            }
            setHasRemoteVideo(true);
          }
        };

        // 5. ICE Candidate Exchange: emit candidates over send_signal
        pc.onicecandidate = async (event) => {
          if (!event.candidate) {
            console.info('[DEBUG-ice] Local candidate gathering complete');
          } else {
            console.info('[DEBUG-ice] Local candidate:', describeCandidate(event.candidate));
          }
          if (event.candidate && !isCallEndedRef.current) {
            const destNodeId = remoteNodeIdRef.current;
            if (destNodeId) {
              const payload = JSON.stringify({
                type: 'candidate',
                candidate: event.candidate.toJSON(),
                sender: myNodeIdRef.current,
              });
              try {
                await sendSignal(destNodeId, payload);
              } catch (err) {
                console.error('[WebRTC] Failed to send ICE candidate:', err);
              }
            }
          }
        };

        pc.oniceconnectionstatechange = () => {
          console.info('[DEBUG-ice] ICE connection state:', pc.iceConnectionState);
          // Failure pairs are logged from onconnectionstatechange.
          if (pc.iceConnectionState === 'connected') {
            void logIcePairs(pc, 'connected');
          } else if (pc.iceConnectionState === 'checking') {
            // Chromium can drop failed pairs before reporting failure, so take
            // a snapshot while checks are still running.
            setTimeout(() => {
              if (pcRef.current === pc && pc.iceConnectionState === 'checking') {
                void logIcePairs(pc, 'still-checking');
              }
            }, 10000);
          }
        };
        pc.onicegatheringstatechange = () => {
          console.info('[DEBUG-ice] ICE gathering state:', pc.iceGatheringState);
        };

        // Track connection state and recover briefly from transient disconnects.
        pc.onconnectionstatechange = () => {
          if (pcRef.current !== pc || isCallEndedRef.current) return;
          const state = pc.connectionState;
          console.info('[WebRTC] Connection state changed:', state);

          if (state === 'connected') {
            hasConnectedRef.current = true;
            clearDisconnectTimeout();
            setConnectionStatus('connected');
          } else if (state === 'disconnected') {
            setConnectionStatus('disconnected');
            clearDisconnectTimeout();
            disconnectTimeoutRef.current = setTimeout(() => {
              if (pcRef.current === pc && pc.connectionState === 'disconnected') {
                cleanupCall();
              }
            }, 4000);
          } else if (state === 'failed') {
            setConnectionStatus('failed');
            // ICE can go checking -> disconnected without ever reporting
            // 'failed', so log the tried pairs here, before cleanup closes pc.
            void logIcePairs(pc, 'failed').finally(cleanupCall);
            // Tell the peer, or it waits on "connecting" indefinitely.
            void sendHangup(hasConnectedRef.current ? 'ended' : 'cancelled');
          } else if (state === 'closed') {
            setConnectionStatus('failed');
            cleanupCall();
          }
        };

        // Helper to process queued candidates once remote description is set
        const flushIceQueue = async () => {
          while (iceCandidatesQueueRef.current.length > 0) {
            const cand = iceCandidatesQueueRef.current.shift();
            if (cand && pcRef.current?.remoteDescription) {
              try {
                await pcRef.current.addIceCandidate(new RTCIceCandidate(cand));
              } catch (err) {
                console.warn('[WebRTC] Error adding queued ICE candidate:', err);
              }
            }
          }
        };

        // 6. Incoming Signaling Message Handler (SDP Offer, Answer, ICE Candidate)
        const handleSignalMessage = async (signal: SignalMessage) => {
          if (isCallEndedRef.current || !pcRef.current) return;
          const currentPc = pcRef.current;

          if (signal.sender && !remoteNodeIdRef.current) {
            remoteNodeIdRef.current = signal.sender;
            setRemoteNodeId(signal.sender);
          }

          try {
            if (signal.type === 'offer' && signal.sdp) {
              console.info('[WebRTC] Handling incoming SDP Offer');
              await currentPc.setRemoteDescription(
                new RTCSessionDescription({ type: 'offer', sdp: signal.sdp })
              );
              await flushIceQueue();

              // Generate and send SDP Answer
              const answer = await currentPc.createAnswer();
              await currentPc.setLocalDescription(answer);

              const targetNode = remoteNodeIdRef.current || signal.sender;
              if (targetNode && !isCallEndedRef.current) {
                const answerPayload = JSON.stringify({
                  type: 'answer',
                  sdp: answer.sdp,
                  sender: myNodeIdRef.current,
                });
                await sendSignal(targetNode, answerPayload);
              }
            } else if (signal.type === 'answer' && signal.sdp) {
              console.info('[WebRTC] Handling incoming SDP Answer');
              await currentPc.setRemoteDescription(
                new RTCSessionDescription({ type: 'answer', sdp: signal.sdp })
              );
              await flushIceQueue();
            } else if (signal.type === 'candidate' && signal.candidate) {
              // Candidates can arrive both live and from the App-level buffer.
              const key = `${signal.candidate.sdpMid ?? ''}|${signal.candidate.candidate ?? ''}`;
              if (seenRemoteCandidatesRef.current.has(key)) return;
              seenRemoteCandidatesRef.current.add(key);
              console.info('[DEBUG-ice] Remote candidate:', describeCandidate(signal.candidate));
              if (currentPc.remoteDescription && currentPc.remoteDescription.type) {
                await currentPc.addIceCandidate(new RTCIceCandidate(signal.candidate));
              } else {
                iceCandidatesQueueRef.current.push(signal.candidate);
              }
            }
          } catch (signalErr) {
            console.error('[WebRTC] Error handling signal message:', signalErr);
          }
        };

        // 7. Subscribe to Tauri incoming_signal events
        unlistenSignals = await listenForIncomingSignals((signal) => {
          if (signal.type === 'hangup') return;
          void handleSignalMessage(signal);
        });
        if (isStaleInitialization()) {
          // Unmounted while listen() was pending; the effect cleanup already ran.
          unlistenSignals();
          unlistenSignals = undefined;
          return;
        }

        // Replay candidates that arrived before this listener existed (e.g.
        // while the incoming-call screen or camera permission prompt was up).
        // They queue until the remote description is set.
        if (remoteNodeIdRef.current) {
          for (const candidate of takeBufferedCandidates(remoteNodeIdRef.current)) {
            await handleSignalMessage({ type: 'candidate', candidate });
          }
        }

        // 8. If receiver launched with an initial offer signal, handle it immediately
        if (isIncoming && initialSignal) {
          await handleSignalMessage(initialSignal);
        } else if (!isIncoming && remoteNodeIdRef.current) {
          if (isCallEndedRef.current) return;
          // 9. Caller mode: Generate SDP Offer and send to remote contact
          console.info('[WebRTC] Caller generating SDP Offer for:', remoteNodeIdRef.current);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          // Trickle ICE: send the SDP now, while candidates continue to arrive
          // through onicecandidate. Never wait for ICE gathering to complete.
          const offerPayload = JSON.stringify({
            type: 'offer',
            sdp: offer.sdp,
            sender: myNodeIdRef.current,
          });

          if (isCallEndedRef.current) return;
          await sendSignal(remoteNodeIdRef.current, offerPayload);
        }
      } catch (err) {
        console.error('[WebRTC] Initialization error:', err);
        if (!isCallEndedRef.current) setConnectionStatus('failed');
      }
    }

    initWebRTC();

    return () => {
      // Invalidate pending media requests before releasing the current streams.
      initializationIdRef.current += 1;
      cleanup();
      if (unlistenSignals) {
        unlistenSignals();
      }
    };
  }, [isIncoming, initialSignal, cleanup, cleanupCall, clearDisconnectTimeout, sendHangup]);

  // Toggle Microphone
  const toggleMute = () => {
    if (localStreamRef.current) {
      const nextMuted = !isMuted;
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !nextMuted;
      });
      setIsMuted(nextMuted);
    }
  };

  // Toggle Camera
  const toggleVideo = () => {
    if (localStreamRef.current) {
      const nextVideoOff = !isVideoOff;
      localStreamRef.current.getVideoTracks().forEach((track) => {
        track.enabled = !nextVideoOff;
      });
      setIsVideoOff(nextVideoOff);
    }
  };

  // Toggle Screen Share
  const toggleScreenShare = async () => {
    if (!pcRef.current || !localStreamRef.current) return;

    if (isScreenSharing) {
      // Revert to camera
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }
      const cameraTrack = localStreamRef.current.getVideoTracks()[0];
      const sender = pcRef.current
        .getSenders()
        .find((s) => s.track && s.track.kind === 'video');

      if (sender && cameraTrack) {
        await sender.replaceTrack(cameraTrack);
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
      setIsScreenSharing(false);
    } else {
      try {
        const initializationId = initializationIdRef.current;
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        if (
          isCallEndedRef.current ||
          initializationIdRef.current !== initializationId
        ) {
          screenStream.getTracks().forEach((track) => track.stop());
          return;
        }
        screenStreamRef.current = screenStream;
        const screenTrack = screenStream.getVideoTracks()[0];

        const sender = pcRef.current
          .getSenders()
          .find((s) => s.track && s.track.kind === 'video');

        if (sender && screenTrack) {
          await sender.replaceTrack(screenTrack);
        }

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = screenStream;
        }

        screenTrack.onended = () => {
          toggleScreenShare();
        };

        setIsScreenSharing(true);
      } catch (err) {
        console.warn('[WebRTC] Screen sharing cancelled or failed:', err);
      }
    }
  };

  const contactName = contact?.name || 'Peer Contact';
  const nodeId = remoteNodeId || contact?.iroh_node_id || 'Unknown Node';
  const truncatedId =
    nodeId.length > 20 ? `${nodeId.slice(0, 10)}...${nodeId.slice(-8)}` : nodeId;

  return (
    <div className="flex-1 flex flex-col h-screen bg-zinc-950 text-zinc-100 select-none overflow-hidden">
      {/* Top Bar Overlay */}
      <header className="relative z-20 flex items-center justify-between px-6 py-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleHangUp}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 text-xs font-medium border border-zinc-800 transition-colors cursor-pointer"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Leave</span>
          </button>

          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-white leading-tight m-0 p-0">
                {contactName}
              </h2>
              <span
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                  connectionStatus === 'connected'
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                    : connectionStatus === 'failed'
                    ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                    : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                }`}
              >
                {connectionStatus === 'connected' ? (
                  <>
                    <ShieldCheck className="h-3 w-3" />
                    Direct P2P
                  </>
                ) : connectionStatus === 'failed' ? (
                  <>
                    <AlertCircle className="h-3 w-3" />
                    Connection Failed
                  </>
                ) : (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Connecting...
                  </>
                )}
              </span>
            </div>
            <p className="text-[11px] font-mono text-zinc-400 m-0 p-0">{truncatedId}</p>
          </div>
        </div>

        {/* Call Timer & Quality */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs font-mono text-emerald-400 bg-emerald-950/40 px-2.5 py-1 rounded-full border border-emerald-500/30">
            <span
              className={`h-2 w-2 rounded-full ${
                connectionStatus === 'connected'
                  ? 'bg-emerald-400 animate-pulse'
                  : 'bg-amber-400 animate-ping'
              }`}
            />
            {formatDuration(seconds)}
          </div>
          <div className="flex items-center gap-1 text-zinc-400 text-xs" title="WebRTC via Iroh Signaling">
            <Signal className="h-4 w-4 text-emerald-400" />
            <span className="hidden sm:inline text-[11px]">
              {connectionStatus === 'connected' ? 'P2P QUIC' : 'Signaling'}
            </span>
          </div>
        </div>
      </header>

      {/* Main Video Stage */}
      <main className="relative flex-1 flex items-center justify-center p-4">
        {/* Remote Video Container. Absolutely positioned because Android's
            Chromium webview does not treat h-full as a definite height here,
            so the box collapsed to zero once the placeholder was removed. */}
        <div className="absolute inset-4 rounded-3xl bg-zinc-900 border border-zinc-800/80 overflow-hidden flex flex-col items-center justify-center shadow-2xl">
          {/* Remote Video Stream Element */}
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${
              hasRemoteVideo ? 'opacity-100 z-10' : 'opacity-0 z-0'
            }`}
          />

          {/* Placeholder when remote video is not yet streaming */}
          {!hasRemoteVideo && (
            <div className="relative z-0 flex flex-col items-center">
              <div className="relative flex items-center justify-center">
                <div className="absolute -inset-4 rounded-full bg-violet-500/20 animate-ping opacity-60" />
                <div className="absolute -inset-8 rounded-full bg-indigo-500/10 animate-pulse" />

                <div className="relative flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-tr from-violet-600 to-indigo-600 text-white font-bold text-3xl shadow-xl shadow-violet-950/50 ring-4 ring-zinc-800">
                  {contactName.slice(0, 2).toUpperCase()}
                </div>
              </div>

              <h3 className="mt-5 text-xl font-semibold text-zinc-100">{contactName}</h3>
              <p className="text-xs text-zinc-400 flex items-center gap-1.5 mt-1.5">
                {connectionStatus === 'connected' ? (
                  <>
                    <Volume2 className="h-3.5 w-3.5 text-emerald-400 animate-bounce" />
                    WebRTC media connected (Audio active)
                  </>
                ) : (
                  <>
                    <Loader2 className="h-3.5 w-3.5 text-violet-400 animate-spin" />
                    Exchanging WebRTC SDP & ICE candidates via Iroh...
                  </>
                )}
              </p>

              {mediaError && (
                <div className="mt-3 px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>{mediaError}</span>
                </div>
              )}
            </div>
          )}

          {/* Local PiP (Picture in Picture) */}
          <div className="absolute bottom-4 right-4 z-20 w-44 h-32 rounded-2xl bg-zinc-950/90 border border-zinc-800 shadow-xl overflow-hidden flex flex-col items-center justify-center">
            {/* Local Video Stream Element */}
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover mirror ${isVideoOff ? 'hidden' : 'block'}`}
            />

            {isVideoOff && (
              <div className="flex flex-col items-center text-zinc-500">
                <VideoOff className="h-6 w-6 mb-1 text-zinc-500" />
                <span className="text-[11px]">Camera off</span>
              </div>
            )}

            <div className="absolute bottom-1.5 left-2 text-[10px] font-medium bg-black/70 px-1.5 py-0.5 rounded text-zinc-300 pointer-events-none">
              {isScreenSharing ? 'Sharing Screen' : 'You'}
            </div>
          </div>
        </div>
      </main>

      {/* Bottom Controls Bar */}
      <footer className="relative z-20 py-5 px-6 flex items-center justify-center bg-gradient-to-t from-black/90 via-black/40 to-transparent">
        <div className="flex items-center gap-3 bg-zinc-900/90 backdrop-blur-xl border border-zinc-800/80 px-6 py-3 rounded-full shadow-2xl">
          {/* Mic Button */}
          <button
            type="button"
            onClick={toggleMute}
            title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            className={`p-3.5 rounded-full transition-all cursor-pointer ${
              isMuted
                ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30 hover:bg-rose-500/30'
                : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
            }`}
          >
            {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>

          {/* Camera Button */}
          <button
            type="button"
            onClick={toggleVideo}
            title={isVideoOff ? 'Turn on camera' : 'Turn off camera'}
            className={`p-3.5 rounded-full transition-all cursor-pointer ${
              isVideoOff
                ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30 hover:bg-rose-500/30'
                : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
            }`}
          >
            {isVideoOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
          </button>

          {/* Screen Share */}
          <button
            type="button"
            onClick={toggleScreenShare}
            title={isScreenSharing ? 'Stop screen sharing' : 'Share screen'}
            className={`p-3.5 rounded-full transition-all cursor-pointer ${
              isScreenSharing
                ? 'bg-violet-600 text-white'
                : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
            }`}
          >
            <Monitor className="h-5 w-5" />
          </button>

          {/* End Call Button */}
          <button
            type="button"
            onClick={handleHangUp}
            title="End call"
            className="flex items-center gap-2 pl-4 pr-5 py-3.5 rounded-full bg-rose-600 hover:bg-rose-500 text-white font-medium text-sm shadow-lg shadow-rose-900/50 transition-all hover:scale-105 active:scale-95 cursor-pointer ml-2"
          >
            <PhoneOff className="h-5 w-5" />
            <span>End Call</span>
          </button>
        </div>
      </footer>
    </div>
  );
};
