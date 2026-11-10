// Optional, user-controlled browser storage (IndexedDB). Off by default.
// When switched on, the original CSV files are kept in this browser only (never uploaded),
// so they can be reopened after closing the tab.

import type { LoadOptions } from './types';

const DB = 'csv-geo-mapper';
const STORE = 'files';
const SETTINGS_KEY = 'csv-geo-mapper:settings';

export interface StoredFile {
  key: string;
  name: string;
  file: Blob;
  opts: LoadOptions;
  savedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}

export const storage = {
  async save(f: StoredFile) { await tx('readwrite', (s) => s.put(f)); },
  async remove(key: string) { await tx('readwrite', (s) => s.delete(key)); },
  async list(): Promise<StoredFile[]> {
    try { return await tx<StoredFile[]>('readonly', (s) => s.getAll() as IDBRequest<StoredFile[]>); } catch { return []; }
  },
  async clearAll() {
    try { await tx('readwrite', (s) => s.clear()); } catch { /* ignore */ }
    try { indexedDB.deleteDatabase(DB); } catch { /* ignore */ }
    try { localStorage.removeItem(SETTINGS_KEY); } catch { /* ignore */ }
    try {
      const root = await (navigator.storage as any)?.getDirectory?.();
      if (root) for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
    } catch { /* ignore */ }
  },
  loadSettings<T>(): Partial<T> {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
  },
  saveSettings<T>(s: T) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  },
  async estimate(): Promise<{ usage: number; quota: number } | null> {
    try {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    } catch { return null; }
  },
};
