// Tiny promise wrapper over IndexedDB. One key/value store is enough here:
// sessions, message history and preferences are all namespaced strings.
const DB_NAME = 'goatmessenger';
const STORE = 'kv';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    if (result && 'onsuccess' in result) {
      result.onsuccess = () => { result = result.result; };
    }
  });
}

export const idb = {
  async get(key, fallback = null) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result === undefined ? fallback : req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async set(key, value) {
    return tx('readwrite', (store) => store.put(value, key));
  },
  async del(key) {
    return tx('readwrite', (store) => store.delete(key));
  },
  async keys(prefix = '') {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve((req.result || []).filter((k) => String(k).startsWith(prefix)));
      req.onerror = () => reject(req.error);
    });
  },
  async wipe() {
    return tx('readwrite', (store) => store.clear());
  },
};
