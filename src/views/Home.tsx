import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Clock,
  Users,
  UserPlus,
  Search,
  RefreshCw,
  Sparkles,
  Radio,
  QrCode,
  Settings,
  UserRound,
} from 'lucide-react';
import type { Contact } from '../types/contact';
import type { LocalProfile } from '../types/profile';
import {
  loadContactsFromDb,
  insertContact,
  updateContactLastCalled,
  removeContact,
  getLocalProfile,
  resolveAvatarUrl,
  isTauriEnvironment,
} from '../services/db';
import { ContactCard } from '../components/ContactCard';
import { parseDbTimestamp } from '../utils/time';
import { getNetworkingError } from '../services/signaling';
import { AddContactModal } from '../components/AddContactModal';
import { MyCodeModal } from '../components/MyCodeModal';
import { ProfileModal } from '../components/ProfileModal';

interface HomeProps {
  onStartCall: (contact: Contact) => void;
}

export const Home: React.FC<HomeProps> = ({ onStartCall }) => {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isAddModalOpen, setIsAddModalOpen] = useState<boolean>(false);
  const [isMyCodeOpen, setIsMyCodeOpen] = useState<boolean>(false);
  const [isProfileOpen, setIsProfileOpen] = useState<boolean>(false);
  const [localProfile, setLocalProfile] = useState<LocalProfile>({
    name: '',
    photo_path: null,
  });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [networkingError, setNetworkingError] = useState<string | null>(null);

  // Load contacts from SQLite via @tauri-apps/plugin-sql
  const fetchContacts = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await loadContactsFromDb();
      setContacts(data);
    } catch (err) {
      console.error('Failed to load contacts:', err);
      setStatusMessage('Unable to access contacts database.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    async function init() {
      try {
        const data = await loadContactsFromDb();
        if (!ignore) {
          setContacts(data);
        }
      } catch (err) {
        if (!ignore) {
          console.error('Failed to load contacts:', err);
          setStatusMessage('Unable to access contacts database.');
        }
      } finally {
        if (!ignore) {
          setIsLoading(false);
        }
      }
    }

    init();
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    listen<void>('contacts_changed', () => {
      void fetchContacts();
    })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((err: unknown) => {
        console.error('Failed to listen for contact updates:', err);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [fetchContacts]);

  useEffect(() => {
    let ignore = false;
    getLocalProfile()
      .then((profile) => {
        if (!ignore) setLocalProfile(profile);
      })
      .catch((err: unknown) => {
        console.error('Failed to load local profile:', err);
        if (!ignore) setStatusMessage(`Unable to load your profile: ${String(err)}`);
      });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    getNetworkingError()
      .then((reason) => {
        if (!ignore) setNetworkingError(reason);
      })
      .catch((err: unknown) => {
        console.error('Failed to check networking status:', err);
      });
    return () => {
      ignore = true;
    };
  }, []);

  // Handle calling a contact
  const handleCall = async (contact: Contact) => {
    try {
      // Record call timestamp in database
      await updateContactLastCalled(contact.iroh_node_id);
    } catch (err) {
      console.warn('Could not update last_called_at in database:', err);
    }
    // Switch to active call view
    onStartCall(contact);
  };

  // Handle contact deletion
  const handleDeleteContact = async (irohNodeId: string) => {
    try {
      await removeContact(irohNodeId);
      await fetchContacts();
    } catch (err) {
      console.error('Failed to delete contact:', err);
    }
  };

  // Filter contacts by search query if present
  const filteredContacts = useMemo(() => {
    if (!searchQuery.trim()) return contacts;
    const query = searchQuery.toLowerCase();
    return contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(query) ||
        c.iroh_node_id.toLowerCase().includes(query)
    );
  }, [contacts, searchQuery]);

  // Split UI into two sections:
  // 1. Recents: Top 3 contacts based on last_called_at
  // 2. Alphabetical: The rest, strictly ensuring no duplicates from Recents
  const { recents, alphabetical } = useMemo(() => {
    // Contacts with last_called_at set, sorted newest first
    const calledContacts = [...filteredContacts]
      .filter((c) => c.last_called_at != null && c.last_called_at !== '')
      .sort((a, b) => {
        const timeA = parseDbTimestamp(a.last_called_at!).getTime();
        const timeB = parseDbTimestamp(b.last_called_at!).getTime();
        return timeB - timeA;
      });

    // Top 3 recents
    const topRecents = calledContacts.slice(0, 3);
    const recentIds = new Set(topRecents.map((c) => c.iroh_node_id));

    // The rest of the contacts, with no duplicates from recents, sorted A-Z by name
    const rest = filteredContacts
      .filter((c) => !recentIds.has(c.iroh_node_id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    return {
      recents: topRecents,
      alphabetical: rest,
    };
  }, [filteredContacts]);

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-zinc-950 text-zinc-100 pb-24">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-20 backdrop-blur-md bg-zinc-950/80 border-b border-zinc-900 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-violet-600 to-indigo-500 shadow-md shadow-violet-900/30 text-white">
              <Radio className="h-5 w-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-white m-0 p-0">
                  through hoops
                </h1>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/20">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
                  P2P Node Ready
                </span>
              </div>
              <p className="text-xs text-zinc-400 m-0 p-0">
                End-to-end encrypted direct peer connections
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsProfileOpen(true)}
              title="Edit your profile"
              className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-2.5 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-white"
            >
              {resolveAvatarUrl(localProfile.photo_path) ? (
                <img
                  src={resolveAvatarUrl(localProfile.photo_path)!}
                  alt="Your avatar"
                  className="h-6 w-6 rounded-lg object-cover"
                />
              ) : (
                <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-zinc-800 text-zinc-400">
                  <UserRound className="h-3.5 w-3.5" />
                </div>
              )}
              <span className="hidden max-w-24 truncate sm:inline">
                {localProfile.name || 'Your Profile'}
              </span>
              <Settings className="h-3.5 w-3.5 text-zinc-500" />
            </button>

            <button
              type="button"
              onClick={() => setIsMyCodeOpen(true)}
              title="View my Iroh Node ID"
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-violet-600/15 hover:bg-violet-600/25 text-violet-300 hover:text-violet-200 border border-violet-500/30 transition-all text-xs font-semibold cursor-pointer shadow-sm"
            >
              <QrCode className="h-3.5 w-3.5" />
              <span>My Code</span>
            </button>

            <button
              type="button"
              onClick={() => fetchContacts()}
              title="Refresh contacts"
              className="p-2 rounded-xl text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition-colors"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-6 pt-6">
        {/* Search Bar */}
        <div className="relative mb-6">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
            <Search className="h-4 w-4" />
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search contacts by name or node key..."
            className="w-full rounded-2xl bg-zinc-900/80 border border-zinc-800/80 pl-10 pr-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/80 transition-all shadow-inner"
          />
        </div>

        {networkingError && (
          <div
            role="alert"
            className="mb-6 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm"
          >
            {networkingError}. You can browse contacts, but calls and adding contacts won&apos;t
            work until the app is restarted.
          </div>
        )}

        {statusMessage && (
          <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm">
            {statusMessage}
          </div>
        )}

        {/* Loading State */}
        {isLoading && contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
            <RefreshCw className="h-8 w-8 animate-spin mb-3 text-violet-500" />
            <p className="text-sm">Loading contacts from SQLite database...</p>
          </div>
        ) : contacts.length === 0 ? (
          /* Empty State */
          <div className="flex flex-col items-center justify-center py-16 px-4 text-center rounded-3xl border border-dashed border-zinc-800 bg-zinc-900/30">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-800/80 text-zinc-400 mb-4">
              <Users className="h-8 w-8" />
            </div>
            <h3 className="text-base font-semibold text-zinc-200">No contacts yet</h3>
            <p className="text-xs text-zinc-400 max-w-sm mt-1 mb-5">
              Add peers using their Iroh Node ID to start high quality, peer-to-peer video calls.
            </p>
            <button
              type="button"
              onClick={() => setIsAddModalOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold shadow-lg shadow-violet-600/30 transition-all cursor-pointer"
            >
              <UserPlus className="h-4 w-4" />
              Add Your First Contact
            </button>
          </div>
        ) : (
          <div className="space-y-8">
            {/* Section 1: Recents (Top 3 based on last_called_at) */}
            <section>
              <div className="flex items-center justify-between mb-3 px-1">
                <div className="flex items-center gap-2 text-zinc-200 font-semibold text-sm">
                  <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400">
                    <Clock className="h-3.5 w-3.5" />
                  </div>
                  <span>Recents</span>
                  <span className="text-xs font-normal text-zinc-500">
                    ({recents.length})
                  </span>
                </div>
                {recents.length > 0 && (
                  <span className="text-[11px] text-zinc-500 font-normal">
                    Top 3 by last call
                  </span>
                )}
              </div>

              {recents.length > 0 ? (
                <div className="grid grid-cols-1 gap-3">
                  {recents.map((contact) => (
                    <ContactCard
                      key={`recent-${contact.iroh_node_id}`}
                      contact={contact}
                      variant="recent"
                      onCall={handleCall}
                      onDelete={handleDeleteContact}
                    />
                  ))}
                </div>
              ) : (
                <div className="p-4 rounded-2xl border border-zinc-800/60 bg-zinc-900/20 text-center">
                  <p className="text-xs text-zinc-500 flex items-center justify-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-zinc-500" />
                    No recent calls yet. Start a call with a peer to see them here!
                  </p>
                </div>
              )}
            </section>

            {/* Section 2: Alphabetical (The rest, strictly avoiding duplicates) */}
            <section>
              <div className="flex items-center justify-between mb-3 px-1">
                <div className="flex items-center gap-2 text-zinc-200 font-semibold text-sm">
                  <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
                    <Users className="h-3.5 w-3.5" />
                  </div>
                  <span>Alphabetical</span>
                  <span className="text-xs font-normal text-zinc-500">
                    ({alphabetical.length})
                  </span>
                </div>
                <span className="text-[11px] text-zinc-500 font-normal">
                  A to Z
                </span>
              </div>

              {alphabetical.length > 0 ? (
                <div className="grid grid-cols-1 gap-3">
                  {alphabetical.map((contact) => (
                    <ContactCard
                      key={`alpha-${contact.iroh_node_id}`}
                      contact={contact}
                      variant="standard"
                      onCall={handleCall}
                      onDelete={handleDeleteContact}
                    />
                  ))}
                </div>
              ) : recents.length > 0 ? (
                <div className="p-4 rounded-2xl border border-zinc-800/60 bg-zinc-900/20 text-center">
                  <p className="text-xs text-zinc-500">
                    All contacts are currently shown in your Recents list.
                  </p>
                </div>
              ) : (
                <div className="p-4 rounded-2xl border border-zinc-800/60 bg-zinc-900/20 text-center">
                  <p className="text-xs text-zinc-500">
                    No contacts found matching &ldquo;{searchQuery}&rdquo;.
                  </p>
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {/* Floating Action Button (FAB) */}
      <div className="fixed bottom-6 right-6 z-30">
        <button
          type="button"
          onClick={() => setIsAddModalOpen(true)}
          className="group flex items-center gap-2.5 pl-4 pr-5 py-3.5 rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-medium text-sm shadow-xl shadow-violet-950/60 hover:shadow-violet-600/40 hover:scale-105 active:scale-95 transition-all duration-200 cursor-pointer border border-violet-400/20"
        >
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 group-hover:rotate-90 transition-transform duration-200">
            <UserPlus className="h-3.5 w-3.5" />
          </div>
          <span className="tracking-wide">New Contact</span>
        </button>
      </div>

      {/* Add Contact Modal */}
      <AddContactModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSaveContact={insertContact}
        onContactAdded={fetchContacts}
      />

      {/* My Code Modal */}
      <MyCodeModal
        isOpen={isMyCodeOpen}
        onClose={() => setIsMyCodeOpen(false)}
      />

      {isProfileOpen && (
        <ProfileModal
          isOpen
          onClose={() => setIsProfileOpen(false)}
          onSaved={setLocalProfile}
        />
      )}
    </div>
  );
};
