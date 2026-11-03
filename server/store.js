// Small durable store with two interchangeable backends:
//
//  - `Store`  — fs-backed JSON snapshot (the default; used by Node and local
//               dev), with atomic writes and debounced persistence.
//  - `KvStore`— exactly the same interface, mirrored into Deno KV. Used when
//               the relay runs on Deno Deploy, where instances share no disk:
//               the fs backend would silently lose every write the moment the
//               instance idles out. Values larger than a single KV entry
//               (avatars, banners, attachments) are chunked under imgchunk/
//               blob keys.
//
// Runtime callers stay synchronous — reads and mutations run against the
// in-memory mirror both backends load at boot, and persistence is
// fire-and-forget. The few methods that need async on the KV side (bulk
// deletes, `messagesBetween`) are async on both backends so call sites don't
// branch.
const fs = require('fs');
const path = require('path');

const EMPTY = () => ({
  users: {},      // lowercased username -> record
  sessions: {},   // token -> { user, createdAt, lastSeen }
  contacts: {},   // user -> { peer -> { state, since } }
  messages: {},   // roomId -> [ { id, seq, from, to, env, ts, clientId } ]
  files: {},      // id -> { owner, name, size, mime, path?, ts }
  groups: {},     // gid -> { id, name, owner, members: [usernames], createdAt }
  seq: 0,
});

// Marker for persist(): delete this key.
const DEL = { __delete__: true };

// Leave generous headroom under KV's per-value ceiling (64 KiB, verified
// empirically: "Value too large (max 65536 bytes)") for encoding overhead.
// Raw-byte and ASCII-string chunks stay far below; message parts are smaller
// still because arbitrary JSON text can inflate under UTF-8.
const KV_CHUNK = 48 * 1024;
const KV_MSG_INLINE = 48 * 1024; // store small messages as one value
const KV_MSG_PART = 14 * 1024;   // chunk slices for large envelopes
const KV_TX_OPS = 64;            // commit at most this many writes per atomic batch

const roomKey = (a, b) => [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('~');
const seqPad = (seq) => String(seq).padStart(12, '0'); // lexicographic == numeric

/** Splits a possibly-large string into { key, value } chunk writes. */
const chunkString = (str, keyOf) => {
  const out = [];
  for (let i = 0, part = 0; i < str.length; i += KV_CHUNK, part++) {
    out.push({ key: keyOf(part), value: str.slice(i, i + KV_CHUNK) });
  }
  return out;
};

const hasDenoKv = () =>
  typeof Deno !== 'undefined' && typeof Deno.openKv === 'function' && !process.env.GM_FORCE_DISK;

/* ---------------------------------------------------------------- disk ---- */

class Store {
  constructor(dir) {
    this.dir = dir;
    this.mode = 'disk';
    this.dbFile = path.join(dir, 'db.json');
    this.dbTmp = path.join(dir, 'db.json.tmp');
    this.data = EMPTY();
    this.timer = null;
    this.dirty = false;
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.dbFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...EMPTY(), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        const backup = this.dbFile + '.corrupt-' + Date.now();
        try { fs.renameSync(this.dbFile, backup); } catch {}
        console.error('[store] could not read db, started fresh:', err.message);
      }
    }
  }

  /** Debounced save: bursts of writes collapse into one atomic rename. */
  touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.flush();
    }, 120);
  }

  flush() {
    this.dirty = false;
    try {
      fs.writeFileSync(this.dbTmp, JSON.stringify(this.data));
      fs.renameSync(this.dbTmp, this.dbFile);
    } catch (err) {
      console.error('[store] save failed:', err.message);
    }
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.flush();
  }

  /* users ------------------------------------------------------------------ */

  user(name) {
    return this.data.users[String(name || '').toLowerCase()] || null;
  }

  putUser(record) {
    this.data.users[record.username.toLowerCase()] = record;
    this.touch();
  }

  /* sessions --------------------------------------------------------------- */

  session(token) {
    const s = this.data.sessions[token];
    if (!s) return null;
    return { token, user: s.user, createdAt: s.createdAt };
  }

  addSession(token, user) {
    this.data.sessions[token] = { user, createdAt: Date.now(), lastSeen: Date.now() };
    this.touch();
  }

  dropSession(token) {
    delete this.data.sessions[token];
    this.touch();
  }

  /* contacts --------------------------------------------------------------- */

  relation(a, b) {
    const list = this.data.contacts[a.toLowerCase()];
    return (list && list[b.toLowerCase()]) || null;
  }

  setRelation(a, b, state) {
    const key = a.toLowerCase();
    const peer = b.toLowerCase();
    this.data.contacts[key] = this.data.contacts[key] || {};
    this.data.contacts[key][peer] = { state, since: Date.now() };
    this.touch();
  }

  dropRelation(a, b) {
    const key = a.toLowerCase();
    const peer = b.toLowerCase();
    if (this.data.contacts[key]) delete this.data.contacts[key][peer];
    this.touch();
  }

  contactsOf(user) {
    const list = this.data.contacts[user.toLowerCase()] || {};
    return Object.entries(list).map(([peer, rel]) => ({ peer, ...rel }));
  }

  /* messages --------------------------------------------------------------- */

  static room(a, b) {
    return roomKey(a, b);
  }

  pushMessage({ from, to, env, clientId }) {
    const room = Store.room(from, to);
    const list = (this.data.messages[room] = this.data.messages[room] || []);
    if (clientId) {
      const dupe = list.find((m) => m.clientId === clientId && m.from === from.toLowerCase());
      if (dupe) return dupe;
    }
    const msg = {
      id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      seq: ++this.data.seq,
      from: from.toLowerCase(),
      to: to.toLowerCase(),
      env,
      ts: Date.now(),
      clientId: clientId || null,
    };
    list.push(msg);
    if (list.length > 5000) list.splice(0, list.length - 5000);
    this.touch();
    return msg;
  }

  async messagesBetween(a, b, after = 0, limit = 1000) {
    const list = this.data.messages[Store.room(a, b)] || [];
    return list.filter((m) => m.seq > after).slice(-limit);
  }

  lastMessage(a, b) {
    const list = this.data.messages[Store.room(a, b)] || [];
    return list.length ? list[list.length - 1] : null;
  }

  /* groups ----------------------------------------------------------------- */

  createGroup({ id, name, owner, members }) {
    const rec = {
      id: String(id),
      name: String(name),
      owner: String(owner).toLowerCase(),
      members: members.map((m) => String(m).toLowerCase()).filter((m, i, all) => m && all.indexOf(m) === i),
      createdAt: Date.now(),
    };
    this.data.groups[rec.id] = rec;
    this.touch();
    return rec;
  }

  getGroup(id) {
    return this.data.groups[String(id)] || null;
  }

  groupsOf(user) {
    const name = String(user).toLowerCase();
    return Object.values(this.data.groups)
      .filter((g) => g.members.includes(name))
      .map((g) => ({ ...g }));
  }

  shareGroup(a, b) {
    const key = String(b).toLowerCase();
    for (const g of this.groupsOf(a)) {
      if (g.members.includes(key)) return true;
    }
    return false;
  }

  /** Removes a member from a group or deletes the group when it empties.
      Returns the new group record, or null when the group was deleted. */
  leaveGroup(id, user) {
    const rec = this.data.groups[String(id)];
    if (!rec) return null;
    const name = String(user).toLowerCase();
    rec.members = rec.members.filter((m) => m !== name);
    if (rec.members.length <= 1) { // 1 member or none: a group is not a chat
      delete this.data.groups[rec.id];
      this.touch();
      return null;
    }
    this.touch();
    return { ...rec };
  }

  /** Removes a user from every group on their way out (account deletion).
      Returns the still-alive group records they were removed from. */
  dropGroupsFor(username) {
    const name = String(username).toLowerCase();
    const touched = [];
    for (const [id, rec] of Object.entries(this.data.groups)) {
      if (!rec.members.includes(name)) continue;
      rec.members = rec.members.filter((m) => m !== name);
      if (rec.members.length <= 1) delete this.data.groups[id];
      else touched.push({ ...rec });
    }
    this.touch();
    return touched;
  }

  /* files ------------------------------------------------------------------ */

  addFile(rec) {
    this.data.files[rec.id] = rec;
    this.touch();
  }

  getFile(id) {
    return this.data.files[id] || null;
  }

  /* account deletion -------------------------------------------------------- */

  async dropUser(name) {
    delete this.data.users[String(name || '').toLowerCase()];
    this.touch();
  }

  async dropSessionsOf(username) {
    const name = String(username || '').toLowerCase();
    for (const [token, session] of Object.entries(this.data.sessions)) {
      if (session.user === name) delete this.data.sessions[token];
    }
    this.touch();
  }

  /** Removes every contact row involving this user; returns affected peers. */
  async dropRelationsOf(username) {
    const name = String(username || '').toLowerCase();
    const peers = new Set();
    for (const [user, list] of Object.entries(this.data.contacts)) {
      if (user !== name && list[name]) {
        delete list[name];
        peers.add(user);
      }
    }
    delete this.data.contacts[name];
    this.touch();
    return peers;
  }

  /** Drops all message rooms that include this user; ciphertext only. */
  async dropMessagesFor(username) {
    const name = String(username || '').toLowerCase();
    for (const room of Object.keys(this.data.messages)) {
      if (room.split('~').includes(name)) delete this.data.messages[room];
    }
    this.touch();
  }

  /** Removes a user's file records; returns on-disk paths for the caller. */
  async dropFilesOf(username) {
    const name = String(username || '').toLowerCase();
    const paths = [];
    for (const [id, rec] of Object.entries(this.data.files)) {
      if (rec.owner === name) {
        paths.push(rec.path);
        delete this.data.files[id];
      }
    }
    this.touch();
    return paths;
  }
}

/* ---------------------------------------------------------------- Deno KV -- */

class KvStore {
  static room(a, b) { return roomKey(a, b); }

  /** Builds the in-memory mirror from KV. An unavailable/incomplete read
      resolves to whatever loaded — the relay must still start. */
  static async open() {
    const kv = await Deno.openKv();
    const store = new KvStore(kv);
    await store.load();
    return store;
  }

  constructor(kv) {
    this.kv = kv;
    this.mode = 'kv';
    this.data = EMPTY();
    this.closed = false;
  }

  async load() {
    // Users: records carry no images; those live in chunked keys under their
    // own img/ meta entries.
    for await (const e of this.kv.list({ prefix: ['u'] })) {
      this.data.users[e.key[1]] = { ...e.value, avatar: '', banner: '' };
    }
    for await (const e of this.kv.list({ prefix: ['img'] })) {
      const name = e.key[1];
      const rec = this.data.users[name];
      if (!rec || !e.value) continue;
      for (const kind of ['avatar', 'banner']) {
        const parts = [];
        for (let i = 0; i < (e.value[kind] || 0); i++) {
          const chunk = await this.kv.get(['imgchunk', name, kind, i]);
          if (chunk.value) parts.push(chunk.value);
        }
        if (parts.length) rec[kind] = parts.join('');
      }
    }
    for await (const e of this.kv.list({ prefix: ['s'] })) this.data.sessions[e.key[1]] = e.value;
    for await (const e of this.kv.list({ prefix: ['c'] })) this.data.contacts[e.key[1]] = e.value;
    for await (const e of this.kv.list({ prefix: ['g'] })) this.data.groups[e.key[1]] = e.value;
    for await (const e of this.kv.list({ prefix: ['f'] })) this.data.files[e.key[1]] = e.value;
    // Messages across all rooms, ordered by padded seq. Loaded eagerly so the
    // mirror serves synchronous consumers (bootstrap, lastMessage).
    const rooms = {};
    for await (const e of this.kv.list({ prefix: ['m'] })) {
      const room = e.key[1];
      const lst = (rooms[room] = rooms[room] || []);
      if (e.value && e.value.__chunked__) {
        // Large envelopes were split under ['mpart', room, seq, i].
        let text = '';
        let intact = true;
        for (let i = 0; i < e.value.parts; i++) {
          const c = await this.kv.get(['mpart', room, e.key[2], i]);
          if (!c.value) { intact = false; break; }
          text += c.value;
        }
        if (!intact) continue;
        try { lst.push(JSON.parse(text)); } catch { /* skip a corrupt spread */ }
      } else if (e.value) {
        lst.push(e.value);
      }
    }
    for (const [room, list] of Object.entries(rooms)) {
      list.sort((a, b) => a.seq - b.seq);
      this.data.messages[room] = list;
      const last = list[list.length - 1];
      if (last) this.data.seq = Math.max(this.data.seq, last.seq);
    }
    const meta = await this.kv.get(['meta']);
    if (meta.value && Number(meta.value.seq) > this.data.seq) this.data.seq = Number(meta.value.seq);
  }

  /** Fire-and-forget persistence: every mutation except putBlob/getBlob is
      awaited by nobody, so failures log instead of throwing into HTTP calls. */
  persist(writes, what) {
    if (this.closed) return;
    const commit = async () => {
      for (let i = 0; i < writes.length; i += KV_TX_OPS) {
        const part = writes.slice(i, i + KV_TX_OPS);
        const tx = this.kv.atomic();
        for (const w of part) {
          if (w.value === DEL || w.value === undefined) tx.delete(w.key);
          else tx.set(w.key, w.value);
        }
        const res = await tx.commit();
        if (!res.ok) throw new Error('kv transaction conflicted');
      }
    };
    commit().catch((err) => console.error(`[store] kv persist failed (${what}):`, err.message));
  }

  /* users ------------------------------------------------------------------ */

  user(name) {
    return this.data.users[String(name || '').toLowerCase()] || null;
  }

  putUser(record) {
    const name = record.username.toLowerCase();
    this.data.users[name] = record;
    const avatar = record.avatar || '';
    const banner = record.banner || '';
    const base = { ...record, avatar: '', banner: '' };
    const writes = [{ key: ['u', name], value: base }];
    const meta = {};
    for (const [kind, value] of [['avatar', avatar], ['banner', banner]]) {
      const chunks = value
        ? chunkString(value, (i) => ['imgchunk', name, kind, i])
        : [];
      meta[kind] = chunks.length;
      writes.push({ key: ['img', name], value: meta });
      writes.push(...chunks);
    }
    this.persist(writes, `user ${name}`);
  }

  /* sessions --------------------------------------------------------------- */

  session(token) {
    const s = this.data.sessions[token];
    if (!s) return null;
    return { token, user: s.user, createdAt: s.createdAt };
  }

  addSession(token, user) {
    this.data.sessions[token] = { user, createdAt: Date.now(), lastSeen: Date.now() };
    this.persist([{ key: ['s', token], value: this.data.sessions[token] }], `session ${user}`);
  }

  dropSession(token) {
    delete this.data.sessions[token];
    this.persist([{ key: ['s', token], value: DEL }], 'session drop');
  }

  /* contacts --------------------------------------------------------------- */

  relation(a, b) {
    const list = this.data.contacts[a.toLowerCase()];
    return (list && list[b.toLowerCase()]) || null;
  }

  setRelation(a, b, state) {
    const key = a.toLowerCase();
    this.data.contacts[key] = this.data.contacts[key] || {};
    this.data.contacts[key][b.toLowerCase()] = { state, since: Date.now() };
    this.persist([{ key: ['c', key], value: this.data.contacts[key] }], `contact ${key}`);
  }

  dropRelation(a, b) {
    const key = a.toLowerCase();
    if (this.data.contacts[key]) delete this.data.contacts[key][b.toLowerCase()];
    this.persist([{ key: ['c', key], value: this.data.contacts[key] }], `contact ${key}`);
  }

  contactsOf(user) {
    const list = this.data.contacts[user.toLowerCase()] || {};
    return Object.entries(list).map(([peer, rel]) => ({ peer, ...rel }));
  }

  /* messages --------------------------------------------------------------- */

  pushMessage({ from, to, env, clientId }) {
    const room = Store.room(from, to);
    const list = (this.data.messages[room] = this.data.messages[room] || []);
    if (clientId) {
      const dupe = list.find((m) => m.clientId === clientId && m.from === from.toLowerCase());
      if (dupe) return dupe;
    }
    const msg = {
      id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      seq: ++this.data.seq,
      from: from.toLowerCase(),
      to: to.toLowerCase(),
      env,
      ts: Date.now(),
      clientId: clientId || null,
    };
    list.push(msg);
    const evicted = list.length > 5000 ? list.splice(0, list.length - 5000) : [];

    const writes = [{ key: ['meta'], value: { seq: this.data.seq } }];
    const pad = seqPad(msg.seq);
    const text = JSON.stringify(msg);
    if (text.length <= KV_MSG_INLINE) {
      writes.push({ key: ['m', room, pad], value: msg });
    } else {
      // Spread across mpart slices; the meta value only carries the part count.
      const parts = [];
      for (let i = 0, o = 0; o < text.length; i++, o += KV_MSG_PART) {
        parts.push({ key: ['mpart', room, pad, i], value: text.slice(o, o + KV_MSG_PART) });
      }
      writes.push({ key: ['m', room, pad], value: { __chunked__: true, parts: parts.length } });
      writes.push(...parts);
    }
    for (const m of evicted) {
      writes.push({ key: ['m', room, seqPad(m.seq)], value: DEL });
      this.deleteRange(['mpart', room, seqPad(m.seq)]);
    }
    this.persist(writes, `message ${room}`);
    return msg;
  }

  /** Fire-and-forget key-range deletion (prefixes are walked when the task
      turns run; mirror consistency is unaffected). */
  deleteRange(prefix) {
    (async () => {
      const kills = [];
      for await (const e of this.kv.list({ prefix })) kills.push(e.key);
      if (kills.length) this.persist(kills.map((k) => ({ key: k, value: DEL })), 'range delete');
    })().catch((err) => console.error('[store] range delete failed:', err.message));
  }

  async messagesBetween(a, b, after = 0, limit = 1000) {
    const list = this.data.messages[Store.room(a, b)] || [];
    return list.filter((m) => m.seq > after).slice(-limit);
  }

  lastMessage(a, b) {
    const list = this.data.messages[Store.room(a, b)] || [];
    return list.length ? list[list.length - 1] : null;
  }

  /* groups ----------------------------------------------------------------- */

  createGroup({ id, name, owner, members }) {
    const rec = {
      id: String(id),
      name: String(name),
      owner: String(owner).toLowerCase(),
      members: members.map((m) => String(m).toLowerCase()).filter((m, i, all) => m && all.indexOf(m) === i),
      createdAt: Date.now(),
    };
    this.data.groups[rec.id] = rec;
    this.persist([{ key: ['g', rec.id], value: rec }], `group ${rec.id}`);
    return rec;
  }

  getGroup(id) {
    return this.data.groups[String(id)] || null;
  }

  groupsOf(user) {
    const name = String(user).toLowerCase();
    return Object.values(this.data.groups)
      .filter((g) => g.members.includes(name))
      .map((g) => ({ ...g }));
  }

  shareGroup(a, b) {
    const key = String(b).toLowerCase();
    for (const g of this.groupsOf(a)) {
      if (g.members.includes(key)) return true;
    }
    return false;
  }

  leaveGroup(id, user) {
    const rec = this.data.groups[String(id)];
    if (!rec) return null;
    const name = String(user).toLowerCase();
    rec.members = rec.members.filter((m) => m !== name);
    if (rec.members.length <= 1) {
      delete this.data.groups[rec.id];
      this.persist([{ key: ['g', rec.id], value: DEL }], `group ${rec.id}`);
      return null;
    }
    this.persist([{ key: ['g', rec.id], value: rec }], `group ${rec.id}`);
    return { ...rec };
  }

  dropGroupsFor(username) {
    const name = String(username).toLowerCase();
    const touched = [];
    const writes = [];
    for (const [id, rec] of Object.entries(this.data.groups)) {
      if (!rec.members.includes(name)) continue;
      rec.members = rec.members.filter((m) => m !== name);
      if (rec.members.length <= 1) {
        delete this.data.groups[id];
        writes.push({ key: ['g', id], value: DEL });
      } else {
        writes.push({ key: ['g', id], value: rec });
        touched.push({ ...rec });
      }
    }
    if (writes.length) this.persist(writes, `groups drop ${name}`);
    return touched;
  }

  /* files ------------------------------------------------------------------ */

  /** Stores attachment bytes in KV, chunked (5 MB ≈ 108 chunks + meta). */
  async putBlob(id, buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const writes = [];
    for (let i = 0, offset = 0; offset < bytes.length; i++, offset += KV_CHUNK) {
      writes.push({ key: ['blob', id, i], value: bytes.slice(offset, offset + KV_CHUNK) });
    }
    const chunkCount = writes.length;
    writes.push({ key: ['blobmeta', id], value: { size: bytes.length, chunks: chunkCount } });
    for (let i = 0; i < writes.length; i += KV_TX_OPS) {
      const part = writes.slice(i, i + KV_TX_OPS);
      const tx = this.kv.atomic();
      for (const w of part) tx.set(w.key, w.value);
      const res = await tx.commit();
      if (!res.ok) throw new Error('kv upload conflicted');
    }
    return id;
  }

  async getBlob(id) {
    const meta = await this.kv.get(['blobmeta', id]);
    if (!meta.value) return null;
    const parts = [];
    for (let i = 0; i < meta.value.chunks; i++) {
      const chunk = await this.kv.get(['blob', id, i]);
      if (!chunk.value) return null;
      parts.push(chunk.value);
    }
    const total = new Uint8Array(meta.value.size);
    let offset = 0;
    for (const part of parts) { total.set(part, offset); offset += part.length; }
    return total;
  }

  addFile(rec) {
    const stored = { ...rec };
    delete stored.path; // nothing on a filesystem on Deploy
    this.data.files[rec.id] = stored;
    this.persist([{ key: ['f', rec.id], value: stored }], `file ${rec.id}`);
  }

  getFile(id) {
    return this.data.files[id] || null;
  }

  /* account deletion -------------------------------------------------------- */

  async dropUser(name) {
    const key = String(name || '').toLowerCase();
    delete this.data.users[key];
    const writes = [{ key: ['u', key], value: DEL }, { key: ['img', key], value: DEL }];
    for await (const e of this.kv.list({ prefix: ['imgchunk', key] })) {
      writes.push({ key: e.key, value: DEL });
    }
    this.persist(writes, `user drop ${key}`);
  }

  async dropSessionsOf(username) {
    const name = String(username || '').toLowerCase();
    const writes = [];
    for (const [token, session] of Object.entries(this.data.sessions)) {
      if (session.user === name) {
        delete this.data.sessions[token];
        writes.push({ key: ['s', token], value: DEL });
      }
    }
    if (writes.length) this.persist(writes, `sessions drop ${name}`);
  }

  async dropRelationsOf(username) {
    const name = String(username || '').toLowerCase();
    const peers = new Set();
    for (const [user, list] of Object.entries(this.data.contacts)) {
      if (user !== name && list[name]) {
        delete list[name];
        peers.add(user);
      }
    }
    delete this.data.contacts[name];
    const writes = [{ key: ['c', name], value: DEL }];
    for (const user of peers) writes.push({ key: ['c', user], value: this.data.contacts[user] });
    this.persist(writes, `contacts drop ${name}`);
    return peers;
  }

  async dropMessagesFor(username) {
    const name = String(username || '').toLowerCase();
    for (const room of Object.keys(this.data.messages)) {
      if (!room.split('~').includes(name)) continue;
      delete this.data.messages[room];
      this.deleteRange(['m', room]);
      this.deleteRange(['mpart', room]);
    }
  }

  /** On KV there are no on-disk paths; the bytes die with their chunks.
      Returns [] for a compatible caller contract. */
  async dropFilesOf(username) {
    const name = String(username || '').toLowerCase();
    const writes = [];
    for (const [id, rec] of Object.entries(this.data.files)) {
      if (rec.owner !== name) continue;
      delete this.data.files[id];
      writes.push({ key: ['f', id], value: DEL }, { key: ['blobmeta', id], value: DEL });
      for await (const e of this.kv.list({ prefix: ['blob', id] })) {
        writes.push({ key: e.key, value: DEL });
      }
    }
    if (writes.length) this.persist(writes, `files drop ${name}`);
    return [];
  }

  flush() { /* persistence is inline; nothing to flush */ }

  close() {
    this.closed = true;
    return this.kv.close();
  }
}

/* ---------------------------------------------------------------- factory -- */

/** Opens the right backend for this runtime: Deno KV when running under Deno
    (Deploy assigns the app's database automatically), the fs snapshot
    otherwise. Set GM_FORCE_DISK=1 to pin the fs backend even under Deno. */
async function openStore(dir) {
  if (hasDenoKv()) {
    try {
      return await KvStore.open();
    } catch (err) {
      console.error('[store] Deno KV unavailable, falling back to disk:', err.message);
    }
  }
  return new Store(dir);
}

module.exports = { Store, KvStore, openStore };
