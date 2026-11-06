// HTTP + WebSocket client for the relay.
import { solveProofOfWork } from '../shared/pow.mjs';

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status || 0;
    this.data = data || null;
  }
}

export class Api {
  constructor(baseUrl) {
    this.base = String(baseUrl || '').replace(/\/$/, '');
    this.token = null;
    this.ws = null;
    this.wsClosed = false;
    this.retry = 0;
    this.retryTimer = null;
    this.onEvent = () => {};
    this.onStatus = () => {};
    this.heartbeat = null;
  }

  get url() { return this.base; }

  setToken(token) { this.token = token; }

  async request(path, { method = 'GET', body, raw, headers = {}, timeout = 25000, retryNetwork = 0 } = {}) {
    const init = {
      method,
      headers: {
        // Free-tier ngrok tunnels serve a "Visit Site" interstitial to browser
        // requests; this header opts the API out of it (harmless elsewhere).
        'ngrok-skip-browser-warning': 'goatmessenger',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      signal: AbortSignal.timeout(timeout),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (raw !== undefined) init.body = raw;

    let res;
    try {
      res = await fetch(this.base + path, init);
    } catch (err) {
      // A reused keep-alive socket can be closed by the relay or an intermediary
      // at the exact moment we send on it. One retry on a fresh connection is
      // the standard fix; only opt-in callers ask for it.
      if (retryNetwork > 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return this.request(path, { method, body, raw, headers, timeout, retryNetwork: retryNetwork - 1 });
      }
      throw new ApiError('Cannot reach the relay. Is it running?', 0);
    }
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/octet-stream')) {
      if (!res.ok) throw new ApiError('Download failed.', res.status);
      return new Uint8Array(await res.arrayBuffer());
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
    return data;
  }

  signup(payload) { return this.request('/api/signup', { method: 'POST', body: payload, timeout: 40000 }); }
  login(payload) { return this.request('/api/login', { method: 'POST', body: payload, timeout: 40000 }); }
  logout() { return this.request('/api/logout', { method: 'POST', body: {} }); }
  deleteAccount(username) {
    return this.request('/api/account', { method: 'DELETE', body: { confirm: username }, timeout: 30000 });
  }
  bootstrap() { return this.request('/api/bootstrap'); }
  lookup(username) { return this.request(`/api/lookup?username=${encodeURIComponent(username)}`); }
  addContact(username) { return this.request('/api/contacts', { method: 'POST', body: { username } }); }
  acceptContact(username) { return this.request('/api/contacts/accept', { method: 'POST', body: { username } }); }
  removeContact(username) { return this.request(`/api/contacts?username=${encodeURIComponent(username)}`, { method: 'DELETE' }); }
  keys(username) { return this.request(`/api/keys?username=${encodeURIComponent(username)}`); }
  history(username, after = 0) { return this.request(`/api/messages?username=${encodeURIComponent(username)}&after=${after}`); }
  sendMessage(to, env, clientId, gid) {
    return this.request('/api/messages', { method: 'POST', body: { to, env, clientId, ...(gid ? { gid } : {}) }, timeout: 20000 });
  }
  createGroup(name, members) { return this.request('/api/groups', { method: 'POST', body: { name, members } }); }
  groups() { return this.request('/api/groups'); }
  leaveGroup(gid) { return this.request(`/api/groups/${encodeURIComponent(gid)}/leave`, { method: 'POST', body: {} }); }
  updateProfile(profile) { return this.request('/api/profile', { method: 'POST', body: profile }); }
  upload(bytes, name, mime) {
    return this.request('/api/upload', {
      method: 'POST',
      raw: bytes,
      headers: { 'x-file-name': name, 'x-file-type': mime },
      timeout: 120000,
    });
  }
  download(fileId) { return this.request(`/api/file/${fileId}`, { timeout: 120000 }); }

  /* ------------------------------------------------------------- migration -- */

  /** Everything needed to stand this account up on another relay. */
  exportAccount() { return this.request('/api/export', { method: 'POST', body: {}, timeout: 60000, retryNetwork: 1 }); }

  /** Copies a bundle onto this relay. Public relays demand the same proof of
      work as a signup, delivered with a 428 the first time round. */
  async importAccount(bundle) {
    const name = String(bundle?.account?.username || '');
    const attempt = (pow) => this.request('/api/import', {
      method: 'POST',
      body: { bundle, ...(pow ? { pow } : {}) },
      timeout: 120000,
      retryNetwork: 1,
    });
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Already here — from an earlier attempt that landed but whose reply was
        // lost. The sign-in that follows is the real check.
        return { ok: true, alreadyThere: true, username: name, imported: {} };
      }
      if (!(err instanceof ApiError) || err.status !== 428 || !err.data?.challenge) throw err;
      const nonce = await solveProofOfWork(err.data.bits || 16, err.data.challenge, name);
      return attempt({ challenge: err.data.challenge, nonce });
    }
  }

  /* ------------------------------------------------------------- websocket -- */

  connect() {
    this.wsClosed = false;
    if (!this.token) return;
    const wsUrl = this.base.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(this.token)}`;
    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.retry = 0;
      this.onStatus('online');
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.sendWs({ t: 'ping' }), 20000);
    };
    socket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      this.onEvent(msg);
    };
    socket.onclose = (event) => {
      clearInterval(this.heartbeat);
      this.onStatus('offline');
      if (this.wsClosed) return;
      if (event.code === 4001) {
        this.onEvent({ t: 'unauthorized' });
        return;
      }
      this.scheduleReconnect();
    };
    socket.onerror = () => {};
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    this.retry = Math.min(this.retry + 1, 6);
    const delay = Math.min(900 * 2 ** (this.retry - 1), 15000);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  sendWs(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  close() {
    this.wsClosed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}
