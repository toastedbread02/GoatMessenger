// Per-account local storage: ratchet sessions, decrypted history, verification
// state. IndexedDB is scoped to the window's session partition, so two windows
// signed into different accounts never share state.
import { idb } from './idb.mjs';
import { serializeSession, deserializeSession } from '../shared/crypto.mjs';

// Per-chat cap. Every message is a small JSON record, but a long-lived pair of
// chatty goats can reach thousands of them, and history is rewritten whole on
// each save — 400 keeps writes small and the storage pane's "keep" honest.
export const MAX_HISTORY = 400;

export class Vault {
  constructor(username) {
    this.user = String(username).toLowerCase();
    this.sessionCache = new Map();
    this.msgCache = new Map();
  }

  k(suffix) { return `${suffix}:${this.user}`; }

  /* identity backup -------------------------------------------------------- */
  async saveBackup(blob) { return idb.set(this.k('backup'), blob); }
  async loadBackup() { return idb.get(this.k('backup'), null); }

  /* ratchet sessions ------------------------------------------------------- */
  async loadSession(peer) {
    const key = String(peer).toLowerCase();
    if (this.sessionCache.has(key)) return this.sessionCache.get(key);
    const stored = await idb.get(`${this.k('session')}:${key}`, null);
    const state = deserializeSession(stored);
    this.sessionCache.set(key, state);
    return state;
  }

  async saveSession(peer, state) {
    const key = String(peer).toLowerCase();
    this.sessionCache.set(key, state);
    await idb.set(`${this.k('session')}:${key}`, serializeSession(state));
  }

  async dropSession(peer) {
    const key = String(peer).toLowerCase();
    this.sessionCache.set(key, null);
    await idb.del(`${this.k('session')}:${key}`);
  }

  /* message history -------------------------------------------------------- */
  async loadMessages(peer) {
    const key = String(peer).toLowerCase();
    if (this.msgCache.has(key)) return this.msgCache.get(key);
    const list = await idb.get(`${this.k('msgs')}:${key}`, []);
    this.msgCache.set(key, list);
    return list;
  }

  async saveMessages(peer, list) {
    const key = String(peer).toLowerCase();
    const trimmed = list.length > MAX_HISTORY ? list.slice(list.length - MAX_HISTORY) : list;
    this.msgCache.set(key, trimmed);
    await idb.set(`${this.k('msgs')}:${key}`, trimmed);
  }

  /* verification ----------------------------------------------------------- */
  async verified(peer) {
    const map = await idb.get(this.k('verified'), {});
    return map[String(peer).toLowerCase()] || null;
  }

  async setVerified(peer, value) {
    const map = await idb.get(this.k('verified'), {});
    if (value) map[String(peer).toLowerCase()] = Date.now();
    else delete map[String(peer).toLowerCase()];
    await idb.set(this.k('verified'), map);
    return map;
  }

  async verifiedAll() { return idb.get(this.k('verified'), {}); }

  /* identity fingerprint --------------------------------------------------- */
  async identityFingerprint() { return idb.get(this.k('idfp'), null); }
  async setIdentityFingerprint(fp) { return idb.set(this.k('idfp'), fp); }

  /* preferences ------------------------------------------------------------ */
  async prefs() { return idb.get(this.k('prefs'), {}); }
  async setPref(key, value) {
    const p = await this.prefs();
    p[key] = value;
    await idb.set(this.k('prefs'), p);
    return p;
  }

  /* storage accounting ----------------------------------------------------- */
  async historyStats() {
    const keys = await idb.keys(this.k('msgs'));
    let notes = 0;
    let bytes = 0;
    for (const key of keys) {
      const list = await idb.get(key, []);
      notes += list.length;
      for (const rec of list) bytes += JSON.stringify(rec).length;
    }
    return { chats: keys.length, notes, bytes };
  }

  // Trim every chat down to its newest `keep` notes. Returns how many went.
  async trimHistory(keep = MAX_HISTORY) {
    const keys = await idb.keys(this.k('msgs'));
    let removed = 0;
    for (const key of keys) {
      const list = await idb.get(key, []);
      if (list.length <= keep) continue;
      removed += list.length - keep;
      await idb.set(key, list.slice(list.length - keep));
    }
    this.msgCache.clear();
    return removed;
  }

  async wipeHistory() {
    const keys = await idb.keys(this.k('msgs'));
    const sessionKeys = await idb.keys(this.k('session'));
    for (const key of [...keys, ...sessionKeys]) await idb.del(key);
    this.msgCache.clear();
    this.sessionCache.clear();
  }

  /* Full local erase — the counterpart of deleting the account on the relay. */
  async wipeAll() {
    await idb.wipe();
    this.msgCache.clear();
    this.sessionCache.clear();
  }
}
