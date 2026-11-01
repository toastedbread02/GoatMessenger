// Small durable JSON store with atomic writes and debounced persistence.
const fs = require('fs');
const path = require('path');

const EMPTY = () => ({
  users: {},      // lowercased username -> record
  sessions: {},   // token -> { user, createdAt, lastSeen }
  contacts: {},   // user -> { peer -> { state, since } }
  messages: {},   // roomId -> [ { id, seq, from, to, env, ts, clientId } ]
  files: {},      // id -> { owner, name, size, mime, path, ts }
  seq: 0,
});

class Store {
  constructor(dir) {
    this.dir = dir;
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
    return [a.toLowerCase(), b.toLowerCase()].sort().join('~');
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

  messagesBetween(a, b, after = 0, limit = 1000) {
    const list = this.data.messages[Store.room(a, b)] || [];
    return list.filter((m) => m.seq > after).slice(-limit);
  }

  lastMessage(a, b) {
    const list = this.data.messages[Store.room(a, b)] || [];
    return list.length ? list[list.length - 1] : null;
  }

  /* files ------------------------------------------------------------------ */

  addFile(rec) {
    this.data.files[rec.id] = rec;
    this.touch();
  }

  getFile(id) {
    return this.data.files[id] || null;
  }
}

module.exports = { Store };
