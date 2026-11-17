import { useState, useEffect, useCallback, useRef } from 'react';
import type { Contact } from './types/contact';
import type { SignalMessage } from './types/signaling';
import { Home } from './views/Home';
import { ActiveCall } from './views/ActiveCall';
import {
  bufferCandidate,
  clearBufferedCandidates,
  getMyNodeId,
  isFromPeer,
  listenForIncomingSignals,
  sendSignal,
} from './services/signaling';
import { loadContactsFromDb } from './services/db';
import { Video, PhoneOff, PhoneCall } from 'lucide-react';

export type AppView = 'home' | 'active-call';

interface IncomingCallInfo {
  nodeId: string;
  name: string;
  offerSignal: SignalMessage | null;
}

export default function App() {
  const [currentView, setCurrentView] = useState<AppView>('home');
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [isIncomingCall, setIsIncomingCall] = useState<boolean>(false);
  const [initialSignal, setInitialSignal] = useState<SignalMessage | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);
  // The signal listener below is not re-registered when incomingCall changes,
  // so it reads the pending call through this ref.
  const incomingCallRef = useRef<IncomingCallInfo | null>(null);
  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  // Global listener for incoming calls when user is in home view
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    // `signal.sender` is the authenticated peer ID (see listenForIncomingSignals).
    listenForIncomingSignals(async (signal: SignalMessage) => {
      try {
        if (signal.type === 'candidate') {
          // Always buffer, even mid-call: ActiveCall dedupes, and this covers
          // the gap before its own listener is registered.
          if (signal.sender && signal.candidate) {
            bufferCandidate(signal.sender, signal.candidate);
          }
          return;
        }
        if (signal.type === 'hangup') {
          if (signal.sender) {
            clearBufferedCandidates(signal.sender);
            const sender = signal.sender.toLowerCase();
            setIncomingCall((pending) =>
              pending && pending.nodeId.toLowerCase() === sender ? null : pending
            );
          }
          return;
        }

        const sender = signal.sender;
        if ((signal.type === 'ring' || signal.type === 'offer') && sender) {
          // If already in an active call, ActiveCall handles signals directly
          if (currentView === 'active-call') return;

          // One pending call at a time. A different caller is told we're busy
          // instead of replacing the call the user is looking at.
          const pending = incomingCallRef.current;
          if (pending && !isFromPeer(signal, pending.nodeId)) {
            console.info(`Ignoring ${signal.type} from ${sender}: another call is pending`);
            clearBufferedCandidates(sender);
            void getMyNodeId()
              .then((me) =>
                sendSignal(sender, JSON.stringify({ type: 'hangup', reason: 'busy', sender: me }))
              )
              .catch(() => {
                // Best effort; the caller times out on its own otherwise.
              });
            return;
          }

          // A ring starts a fresh call; discard leftovers from an earlier one.
          if (signal.type === 'ring') clearBufferedCandidates(sender);

          // Ring opens the incoming-call UI before the camera/SDP are ready.
          let callerName = 'Remote Peer';
          try {
            const contacts = await loadContactsFromDb();
            const matched = contacts.find(
              (c) => c.iroh_node_id.toLowerCase() === sender.toLowerCase()
            );
            if (matched) callerName = matched.name;
          } catch (e) {
            console.warn('Could not load contacts to resolve caller name', e);
          }

          setIncomingCall((current) => {
            // Re-check after the await above: another caller may have won.
            if (current && !isFromPeer(signal, current.nodeId)) return current;
            return {
              nodeId: sender,
              name: callerName,
              offerSignal: signal.type === 'offer' ? signal : (current?.offerSignal ?? null),
            };
          });
        }
      } catch (e) {
        console.warn('Failed to handle incoming signal in App:', e);
      }
    }).then((cleanup) => {
      // If the effect was torn down before listen() resolved (StrictMode, or a
      // view change), drop the listener instead of leaking a duplicate.
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [currentView]);

  const handleStartCall = (contact: Contact) => {
    setActiveContact(contact);
    setIsIncomingCall(false);
    setInitialSignal(null);
    setIncomingCall(null);
    setCurrentView('active-call');
  };

  const handleAcceptIncomingCall = useCallback(() => {
    if (!incomingCall?.offerSignal) return;

    const contact: Contact = {
      iroh_node_id: incomingCall.nodeId,
      name: incomingCall.name,
      photo_path: null,
      added_at: new Date().toISOString(),
      last_called_at: new Date().toISOString(),
    };

    setActiveContact(contact);
    setIsIncomingCall(true);
    setInitialSignal(incomingCall.offerSignal);
    setIncomingCall(null);
    setCurrentView('active-call');
  }, [incomingCall]);

  const handleDeclineIncomingCall = useCallback(() => {
    if (!incomingCall) return;
    const remoteId = incomingCall.nodeId;
    setIncomingCall(null);
    clearBufferedCandidates(remoteId);

    void getMyNodeId()
      .then((sender) =>
        sendSignal(
          remoteId,
          JSON.stringify({ type: 'hangup', reason: 'declined', sender })
        )
      )
      .catch(() => {
        // The caller may already have cancelled or gone offline.
      });
  }, [incomingCall]);

  useEffect(() => {
    if (!incomingCall) return;
    const handleBeforeUnload = () => handleDeclineIncomingCall();
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [incomingCall, handleDeclineIncomingCall]);

  const handleEndCall = useCallback(() => {
    setActiveContact(null);
    setIsIncomingCall(false);
    setInitialSignal(null);
    setIncomingCall(null);
    setCurrentView('home');
  }, []);

  return (
    <div className="min-h-screen w-full flex flex-col bg-zinc-950">
      {/* Incoming Call Notification Modal */}
      {incomingCall && currentView === 'home' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/80 backdrop-blur-md animate-fade-in" />
          <div className="relative w-full max-w-sm rounded-3xl bg-zinc-900 border border-violet-500/30 p-6 shadow-2xl shadow-violet-950/50 text-center z-10 animate-scale-up">
            <div className="relative mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-tr from-violet-600 to-indigo-600 text-white font-bold text-2xl shadow-xl mb-4">
              <span className="absolute -inset-2 rounded-full bg-violet-500/20 animate-ping" />
              <Video className="h-8 w-8 relative z-10" />
            </div>

            <h3 className="text-xl font-bold text-white">{incomingCall.name}</h3>
            <p className="text-xs text-zinc-400 mt-1 font-mono truncate px-4">
              {incomingCall.nodeId}
            </p>
            <p className="text-sm text-violet-300 font-medium mt-3 flex items-center justify-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              {incomingCall.offerSignal ? 'Incoming P2P Video Call...' : 'Ringing... Preparing call'}
            </p>

            <div className="flex items-center justify-center gap-4 mt-6">
              <button
                type="button"
                onClick={handleDeclineIncomingCall}
                className="flex items-center gap-2 px-5 py-3 rounded-full bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 text-xs font-semibold transition-all cursor-pointer"
              >
                <PhoneOff className="h-4 w-4" />
                <span>Decline</span>
              </button>
              <button
                type="button"
                onClick={handleAcceptIncomingCall}
                disabled={!incomingCall.offerSignal}
                className="flex items-center gap-2 px-6 py-3 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-emerald-950/50 transition-all hover:scale-105 active:scale-95 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
              >
                <PhoneCall className="h-4 w-4" />
                <span>{incomingCall.offerSignal ? 'Accept' : 'Connecting...'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {currentView === 'home' ? (
        <Home onStartCall={handleStartCall} />
      ) : (
        <ActiveCall
          contact={activeContact}
          onEndCall={handleEndCall}
          isIncoming={isIncomingCall}
          initialSignal={initialSignal}
        />
      )}
    </div>
  );
}
