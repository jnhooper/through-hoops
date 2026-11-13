import Database from '@tauri-apps/plugin-sql';
import type { Contact } from '../types/contact';

const DB_NAME = 'sqlite:contacts.db';

let dbInstance: Database | null = null;

export const isTauriEnvironment = (): boolean => {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
};

// Fallback in-memory contacts when previewing in standard browser without Tauri
const MOCK_STORAGE_KEY = 'p2p_mock_contacts';

const getMockContacts = (): Contact[] => {
  try {
    const raw = localStorage.getItem(MOCK_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error('Failed reading mock contacts', e);
  }

  const initialMock: Contact[] = [
    {
      iroh_node_id: '5k89e47c1a938f9024cbb1394f9b8702c2e5b7c',
      name: 'Elena Rostova',
      photo_path: null,
      added_at: new Date(Date.now() - 86400000 * 5).toISOString(),
      last_called_at: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
    },
    {
      iroh_node_id: '7b20f1883c749a02d41b9c288921dfaa839b201',
      name: 'Marcus Chen',
      photo_path: null,
      added_at: new Date(Date.now() - 86400000 * 3).toISOString(),
      last_called_at: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
    },
    {
      iroh_node_id: '3c99a80392bc18d89e2401f827ba9102c4b8109',
      name: 'Sarah Connor',
      photo_path: null,
      added_at: new Date(Date.now() - 86400000 * 2).toISOString(),
      last_called_at: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
    },
    {
      iroh_node_id: '1a76201cf902b489c72199b19402a71bc98371a',
      name: 'David Kim',
      photo_path: null,
      added_at: new Date(Date.now() - 86400000 * 1).toISOString(),
      last_called_at: null,
    },
    {
      iroh_node_id: '9f81a700142b93809cb8192a00c8723910cbe21',
      name: 'Zara Thorne',
      photo_path: null,
      added_at: new Date(Date.now() - 86400000 * 4).toISOString(),
      last_called_at: null,
    },
  ];
  try {
    localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(initialMock));
  } catch (e) {
    console.error('Failed writing mock contacts', e);
  }
  return initialMock;
};

const saveMockContacts = (contacts: Contact[]) => {
  try {
    localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(contacts));
  } catch (e) {
    console.error('Failed writing mock contacts', e);
  }
};

export async function getDb(): Promise<Database | null> {
  if (!isTauriEnvironment()) {
    console.info('Running in browser: using simulated SQLite storage.');
    return null;
  }

  if (!dbInstance) {
    try {
      dbInstance = await Database.load(DB_NAME);
    } catch (err) {
      console.error('Error connecting to SQLite database:', err);
      throw err;
    }
  }
  return dbInstance;
}

export async function loadContactsFromDb(): Promise<Contact[]> {
  const db = await getDb();
  if (!db) {
    return getMockContacts();
  }

  const contacts = await db.select<Contact[]>(
    'SELECT iroh_node_id, name, photo_path, added_at, last_called_at FROM contacts ORDER BY added_at DESC'
  );
  return contacts;
}

export async function insertContact(irohNodeId: string, name: string): Promise<void> {
  const trimmedId = irohNodeId.trim();
  const trimmedName = name.trim();

  if (!trimmedId || !trimmedName) {
    throw new Error('Both Iroh Node ID and Name are required.');
  }

  const db = await getDb();
  if (!db) {
    const list = getMockContacts();
    if (list.some((c) => c.iroh_node_id.toLowerCase() === trimmedId.toLowerCase())) {
      throw new Error(`Contact with Iroh Node ID "${trimmedId}" already exists.`);
    }
    const newContact: Contact = {
      iroh_node_id: trimmedId,
      name: trimmedName,
      photo_path: null,
      added_at: new Date().toISOString(),
      last_called_at: null,
    };
    saveMockContacts([newContact, ...list]);
    return;
  }

  await db.execute(
    'INSERT INTO contacts (iroh_node_id, name, added_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
    [trimmedId, trimmedName]
  );
}

export async function updateContactLastCalled(irohNodeId: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    const list = getMockContacts();
    const updated = list.map((c) =>
      c.iroh_node_id === irohNodeId
        ? { ...c, last_called_at: new Date().toISOString() }
        : c
    );
    saveMockContacts(updated);
    return;
  }

  await db.execute(
    'UPDATE contacts SET last_called_at = CURRENT_TIMESTAMP WHERE iroh_node_id = $1',
    [irohNodeId]
  );
}

export async function removeContact(irohNodeId: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    const list = getMockContacts();
    saveMockContacts(list.filter((c) => c.iroh_node_id !== irohNodeId));
    return;
  }

  await db.execute('DELETE FROM contacts WHERE iroh_node_id = $1', [irohNodeId]);
}
