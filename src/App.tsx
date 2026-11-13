import { useState, useEffect, useCallback } from 'react';
import type { Contact } from './types/contact';
import type { SignalMessage } from './types/signaling';
import { Home } from './views/Home';
import { ActiveCall } from './views/ActiveCall';
import { listenForIncomingSignals } from './services/signaling';
import { loadContactsFromDb } from './services/db';
import { Video, PhoneOff, PhoneCall } from 'lucide-react';

export type AppView = 'home' | 'active-call';

interface IncomingCallInfo {
  nodeId: string;
  name: string;
  offerSignal: SignalMessage;
}

export default function App() {
  const [currentView, setCurrentView] = useState<AppView>('home');
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [isIncomingCall, setIsIncomingCall] = useState<boolean>(false);
  const [initialSignal, setInitialSignal] = useState<SignalMessage | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);

  // Global listener for incoming calls when user is in home view
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listenForIncomingSignals(async (payloadString: string) => {
      try {
        const signal = JSON.parse(payloadString) as SignalMessage;
        if (signal && signal.type === 'offer' && signal.sender) {
          // If already in an active call, ActiveCall handles signals directly
          if (currentView === 'active-call') return;

          // Lookup caller name in saved contacts if available
          let callerName = 'Remote Peer';
          try {
            const contacts = await loadContactsFromDb();
            const matched = contacts.find(
              (c) => c.iroh_node_id.toLowerCase() === signal.sender?.toLowerCase()
            );
            if (matched) {
              callerName = matched.name;
            }
          } catch (e) {
            console.warn('Could not load contacts to resolve caller name', e);
          }

          setIncomingCall({
            nodeId: signal.sender,
            name: callerName,
            offerSignal: signal,
          });
        }
      } catch (e) {
        console.warn('Non-JSON incoming signal in App:', payloadString, e);
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      if (unlisten) unlisten();
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
    if (!incomingCall) return;

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

  const handleDeclineIncomingCall = () => {
    setIncomingCall(null);
  };

  const handleEndCall = () => {
    setActiveContact(null);
    setIsIncomingCall(false);
    setInitialSignal(null);
    setCurrentView('home');
  };

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
              Incoming P2P Video Call...
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
                className="flex items-center gap-2 px-6 py-3 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-emerald-950/50 transition-all hover:scale-105 active:scale-95 cursor-pointer"
              >
                <PhoneCall className="h-4 w-4" />
                <span>Accept</span>
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
