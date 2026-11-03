// GoatMessenger renderer: session handling, encrypted messaging, contacts, calls.
import * as C from '../shared/crypto.mjs';
import { isVerified, VERIFIED_TIP } from '../shared/verified.mjs';
import { Api, ApiError } from './api.mjs';
import { Vault, MAX_HISTORY } from './vault.mjs';
import { CallManager } from './calls.mjs';
import { Sound } from './sound.mjs';
import * as D from './dom.mjs';

const { $, el, icon } = D;

const S = {
  info: null,
  api: null,
  vault: null,
  sound: new Sound(),
  calls: null,
  identity: null,
  me: null,
  contacts: new Map(),      // username -> contact record
  groups: new Map(),        // `group:<gid>` -> { id, name, members, owner, createdAt }
  bundles: new Map(),       // username -> public key bundle
  messages: new Map(),      // username -> message records (decrypted, local)
  verified: new Map(),      // username -> timestamp
  presence: new Map(),      // username -> bool
  typingUntil: new Map(),   // username -> ms
  typingSent: 0,
  typingTimer: null,
  unread: new Map(),
  readUpTo: new Map(),      // peer -> highest seq they have read
  activePeer: null,
  search: '',
  authMode: 'signin',
  isGuest: false,
  booted: false,
  mediaCache: new Map(),    // fileId -> object URL
  recorder: null,
  recordingTimer: null,
  transcriptDraft: '',       // live speech-to-text while a voice note records
  droppedEnvelopes: 0,
  themeMode: 'system',
  settingsCat: 'profile',
  notify: { sound: true, desktop: true },   // mirrored into vault prefs
};

const EMOJI = ['🐐', '🐑', '🌿', '🌾', '🔥', '✨', '😄', '😂', '🥹', '😎', '🤝', '👋', '👍', '🙏', '💚', '💛',
  '🧡', '❤️', '🎉', '☕️', '🍞', '🧀', '🥛', '🥕', '🌰', '🗻', '⛰️', '🌙', '☀️', '🌧️', '🔔', '🎵',
  '📎', '📷', '🎥', '📞', '💬', '🤔', '😴', '😭', '🫶', '🫡', '🐐'];

/* ================================================================ utilities */

function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}`, text: message });
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s, transform .3s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 320);
  }, 2800);
}

function showBootNote(text) { $('#boot-note').textContent = text; }

/* ==================================================================== theme */

function resolveDark(mode) {
  return mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme(mode) {
  S.themeMode = ['light', 'dark', 'system'].includes(mode) ? mode : 'system';
  try { localStorage.setItem('gm:theme', S.themeMode); } catch {}
  const dark = resolveDark(S.themeMode);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  window.goat?.setTheme?.(S.themeMode);
}

function savedTheme() {
  try { return localStorage.getItem('gm:theme') || 'system'; } catch { return 'system'; }
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (S.themeMode === 'system') applyTheme('system');
});

const isOnline = (peer) => Boolean(S.presence.get(String(peer).toLowerCase()));

const isGroup = (peer) => S.groups.has(String(peer));
const groupOf = (peer) => S.groups.get(String(peer)) || null;

// Ratchet state must never be touched by two async operations at once.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.then(() => {}, () => {}));
  return run;
}

function displayName(peer) {
  const key = String(peer);
  if (isGroup(key)) return groupOf(key)?.name || key;
  const rec = S.contacts.get(key.toLowerCase());
  return rec?.displayName || peer;
}

function accentOf(peer) {
  const key = String(peer);
  if (isGroup(key)) {
    // Deterministic hue so the same group paints the same avatar everywhere.
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }
  return S.contacts.get(key.toLowerCase())?.accent ?? 30;
}

function avatarOf(peer) {
  const key = String(peer);
  if (isGroup(key)) return '';
  return S.contacts.get(key.toLowerCase())?.avatar || '';
}

function bannerOf(peer) {
  return S.contacts.get(String(peer).toLowerCase())?.banner || '';
}

function unsentTotal() {
  let n = 0;
  for (const v of S.unread.values()) n += v;
  return n;
}

function syncBadge() {
  const total = unsentTotal();
  window.goat?.setBadge?.(total).catch?.(() => {});
  document.title = total > 0 ? `(${total}) GoatMessenger` : 'GoatMessenger';
}

/* ==================================================================== modals */

function openModal(content, { onClose } = {}) {
  const layer = $('#modal-layer');
  S.settingsGuard = null; // the old modal is gone; a fresh one re-arms below
  layer.innerHTML = '';
  layer.append(content);
  layer.hidden = false;
  layer.dataset.onclose = '';
  layer._onClose = onClose || null;
  return layer;
}

function closeModal(force = false) {
  const layer = $('#modal-layer');
  if (layer.hidden) return;
  // Settings refuses to close while its draft has unsaved edits — the warning
  // bar inside the settings modal offers the Save that unlocks it.
  if (!force && S.settingsGuard?.isDirty?.()) {
    S.settingsGuard.refuse();
    return;
  }
  S.settingsGuard = null;
  if (force || S.profileDraft) S.profileDraft = null;
  layer.hidden = true;
  layer.innerHTML = '';
  const cb = layer._onClose;
  layer._onClose = null;
  if (cb) cb();
}

$('#modal-layer').addEventListener('click', (event) => {
  if (event.target.id === 'modal-layer') closeModal();
});

function modalShell(title, subtitle, body, actions = []) {
  const node = el('div', { class: 'modal' },
    el('h3', { text: title }),
    subtitle ? el('p', { class: 'sub', text: subtitle }) : null,
    body,
    actions.length ? el('div', { class: 'modal-actions' }, ...actions) : null);
  return node;
}

/* ====================================================================== auth */

function setAuthMode(mode) {
  S.authMode = mode;
  const isSignup = mode === 'signup';
  D.$$('.tab').forEach((tab) => tab.classList.toggle('is-on', tab.dataset.mode === mode));
  $('#field-display').hidden = !isSignup;
  $('#field-pass2').hidden = !isSignup;
  $('#field-consent').hidden = !isSignup;
  $('#auth-submit').textContent = isSignup ? 'Create my herd' : 'Sign in';
  $('#auth-hint').textContent = isSignup
    ? 'Your passphrase derives your private keys on this device. The relay only ever sees ciphertext.'
    : 'Your passphrase unlocks your keys and your history. It never leaves this device.';
  $('#auth-error').hidden = true;
}

function authError(message) {
  const node = $('#auth-error');
  node.textContent = message;
  node.hidden = false;
}

// Guests are throwaway relay accounts the app creates silently. They can chat
// and make voice calls; camera, screen sharing and file sending need a real
// account the user has set a passphrase for.
const GUEST_MSG = 'Please log in or create an account to use this feature.';

function requireLogin() {
  if (!S.isGuest) return true;
  toast(GUEST_MSG, 'err');
  return false;
}

async function continueAsGuest() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const name = `guest_${D.randomId(4)}`;
    const passphrase = D.randomId(16);
    try {
      await signUp(name, passphrase, 'Guest');
      toast('Chatting as a guest — create an account for everything.');
      return;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) continue; // name taken, roll again
      throw err;
    }
  }
  throw new Error('Every guest name was taken — try again in a moment.');
}

function busy(button, label) {
  button.disabled = true;
  button.dataset.label = button.textContent;
  button.textContent = label;
}
function unbusy(button) {
  button.disabled = false;
  if (button.dataset.label) button.textContent = button.dataset.label;
}

async function signIn(username, passphrase) {
  const name = username.trim();
  if (!name || !passphrase) throw new Error('Enter your goat name and passphrase.');
  const keys = C.derivePassphraseKeys(passphrase, name);
  const res = await S.api.login({ username: name, authToken: keys.authToken });
  if (!res.identityBackup) throw new Error('This account has no key backup on the relay.');
  let identity;
  try {
    identity = C.importIdentity(await C.unwrapIdentity(res.identityBackup, keys.wrapKey));
  } catch {
    throw new Error('That passphrase cannot unlock this account.');
  }
  await startSession({ username: res.me.username, token: res.token, identity, bootstrap: res, backup: res.identityBackup });
  return res;
}

async function signUp(username, passphrase, displayNameValue) {
  const name = username.trim();
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(name)) throw new Error('Use 3–24 letters, numbers or underscores.');
  if (passphrase.length < 8) throw new Error('Please use at least 8 characters for your passphrase.');
  const keys = C.derivePassphraseKeys(passphrase, name);
  const identity = C.createIdentity();
  const backup = await C.wrapIdentity(C.exportIdentity(identity), keys.wrapKey);
  const buildPayload = (pow) => ({
    username: name,
    displayName: (displayNameValue || name).trim(),
    authToken: keys.authToken,
    identityBackup: backup,
    keys: C.publicBundle(identity),
    ...(pow ? { pow } : {}),
  });
  let res;
  try {
    res = await S.api.signup(buildPayload());
  } catch (err) {
    // Public relays demand a tiny proof of work to keep bots out. The
    // challenge arrives with the 428 — solve and retry exactly once.
    if (err instanceof ApiError && err.status === 428 && err.data?.challenge) {
      const pow = { challenge: err.data.challenge, nonce: await solveProofOfWork(err.data.bits || 16, err.data.challenge, name) };
      res = await S.api.signup(buildPayload(pow));
    } else {
      throw err;
    }
  }
  await startSession({ username: res.me.username, token: res.token, identity, bootstrap: res, backup });
  return res;
}

// SHA-256 proof of work: find a nonce whose digest has `bits` leading zeros.
// crypto.subtle is native; the occasional yield keeps the UI alive while the
// loop grinds (~65k hashes at the default 16 bits, a second or two).
async function solveProofOfWork(bits, challenge, name) {
  const enc = new TextEncoder();
  for (let n = 0; ; n++) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${challenge}:${name}:${String(n)}`)));
    let left = bits;
    for (const byte of digest) {
      if (byte === 0) { left -= 8; continue; }
      for (let m = 0x80; m > 0; m >>= 1) { if (byte & m) break; left--; }
      break;
    }
    if (left <= 0) return String(n);
    if (n % 256 === 0) await new Promise((r) => setTimeout(r));
  }
}

async function startSession({ username, token, identity, bootstrap, backup }) {
  S.api.setToken(token);
  S.isGuest = /^guest_/.test(username);
  S.identity = identity;
  if (S.calls) S.calls.identity = identity;
  S.vault = new Vault(username);
  if (backup) await S.vault.saveBackup(backup);

  // Different keys on this device means old ratchets belong to someone else.
  const fingerprint = C.fingerprintKey(identity.ikPub);
  const storedFingerprint = await S.vault.identityFingerprint();
  if (storedFingerprint && storedFingerprint !== fingerprint) {
    await S.vault.wipeHistory();
    toast('This Mac held keys for a different identity — local history was reset.', 'err');
  }
  await S.vault.setIdentityFingerprint(fingerprint);

  S.me = bootstrap.me;
  S.contacts.clear();
  S.groups.clear();
  S.bundles.clear();
  S.messages.clear();
  S.unread.clear();
  S.presence.clear();
  S.verified.clear();
  S.readUpTo.clear();
  S.typingUntil.clear();

  const verifiedMap = await S.vault.verifiedAll();
  for (const [peer, at] of Object.entries(verifiedMap || {})) S.verified.set(peer, at);
  applyBootstrap(bootstrap);

  const prefs = await S.vault.prefs();
  if (prefs.unread) {
    for (const [peer, count] of Object.entries(prefs.unread)) S.unread.set(peer, count);
  }
  if (prefs.theme) applyTheme(prefs.theme);
  S.notify = {
    sound: prefs.notifySound === undefined ? true : Boolean(prefs.notifySound),
    desktop: prefs.notifyDesktop === undefined ? true : Boolean(prefs.notifyDesktop),
  };

  localStorage.setItem('gm:lastUser', username);
  // Stay signed in on relaunch: token + private identity go to the OS keychain.
  try { await window.goat?.session?.save?.({ username: S.me.username, token, identity: C.exportIdentity(identity) }); } catch {}

  $('#auth').hidden = true;
  $('#shell').hidden = false;
  renderMe();
  renderChatList();
  syncBadge();

  wireApi();
  S.api.connect();

  const last = prefs.lastPeer && (S.contacts.has(prefs.lastPeer) || S.groups.has(prefs.lastPeer))
    && (S.groups.has(prefs.lastPeer) || S.contacts.get(prefs.lastPeer).state === 'accepted')
    ? prefs.lastPeer : null;
  if (last) await openChat(last, { silent: true });
  else showEmpty();

  setTimeout(() => $('#composer-input')?.focus(), 200);
}

/* ================================================================ bootstrap */

function applyBootstrap(data) {
  if (data.me) S.me = data.me;
  if (data.groups) {
    // The relay is authoritative for membership; keep local shout-outs in sync.
    S.groups.clear();
    for (const g of data.groups) S.groups.set(`group:${g.id}`, g);
    if (S.activePeer && !S.groups.has(S.activePeer)) showEmpty();
  }
  if (!data.contacts) return;
  S.contacts.clear();
  for (const contact of data.contacts) {
    S.contacts.set(contact.username.toLowerCase(), contact);
    if (contact.presence) S.presence.set(contact.username.toLowerCase(), contact.presence === 'online');
  }
  renderChatList();
  renderRequests();
  if (S.activePeer) {
    renderHeader();
    renderConversation({ scroll: false });
  }
  syncBadge();
}

async function refreshBootstrap() {
  try {
    applyBootstrap(await S.api.bootstrap());
  } catch (err) {
    if (err.status === 401) handleUnauthorized();
  }
}

/* ======================================================================= ws */

function wireApi() {
  S.api.onStatus = (status) => {
    $('#me-status').innerHTML = '';
    const dot = el('i', { class: 'dot' });
    const label = el('span', { text: status === 'online' ? 'Connected · encrypted' : 'Reconnecting…' });
    $('#me-status').classList.toggle('offline', status !== 'online');
    $('#me-status').append(dot, label);
  };
  S.api.onEvent = handleWsEvent;
}

async function handleWsEvent(msg) {
  switch (msg.t) {
    case 'ready':
      if (msg.me) { S.me = { ...S.me, ...msg.me }; renderMe(); }
      // Anything that happened while we were disconnected (contact requests,
      // profile edits) is only visible in a fresh snapshot.
      await refreshBootstrap();
      break;
    case 'presence-list':
      for (const peer of msg.online || []) S.presence.set(String(peer).toLowerCase(), true);
      renderChatList();
      renderHeader();
      break;
    case 'presence': {
      const peer = String(msg.user).toLowerCase();
      S.presence.set(peer, Boolean(msg.online));
      renderChatList();
      if (S.activePeer === peer) renderHeader();
      break;
    }
    case 'message':
      await receiveMessage(msg.msg);
      break;
    case 'typing': {
      const peer = String(msg.from).toLowerCase();
      S.typingUntil.set(peer, msg.on ? Date.now() + 3200 : 0);
      if (S.activePeer === peer) renderTyping();
      renderChatList();
      setTimeout(() => {
        if (S.activePeer === peer) renderTyping();
        renderChatList();
      }, 3300);
      break;
    }
    case 'read':
      await applyReadReceipt(String(msg.from).toLowerCase(), msg.upTo);
      break;
    case 'contact-request':
      toast(`${msg.user.displayName || msg.user.username} wants to join your herd.`);
      await refreshBootstrap();
      break;
    case 'contact-accepted':
      toast(`${msg.user.displayName || msg.user.username} accepted. Say hello!`);
      await refreshBootstrap();
      break;
    case 'contact-removed':
      toast(`${msg.user} left your herd.`);
      await refreshBootstrap();
      break;
    case 'group': {
      const g = msg.group;
      if (!g?.id) break;
      const key = `group:${g.id}`;
      const isNew = !S.groups.has(key);
      S.groups.set(key, g);
      if (isNew) {
        toast(`${g.owner === S.me.username.toLowerCase() ? 'Group created' : `${displayName(g.owner)} added you to “${g.name}”`}.`);
      } else if (S.activePeer === key) renderHeader();
      renderChatList();
      break;
    }
    case 'group-gone': {
      const key = `group:${msg.id}`;
      if (S.groups.delete(key)) {
        toast(`The group “${displayName(key)}” is gone.`);
        if (S.activePeer === key) showEmpty();
        renderChatList();
      }
      break;
    }
    case 'profile': {
      const peer = msg.user.username.toLowerCase();
      const existing = S.contacts.get(peer);
      if (existing) Object.assign(existing, {
        displayName: msg.user.displayName, about: msg.user.about, accent: msg.user.accent,
        avatar: msg.user.avatar, banner: msg.user.banner,
      });
      renderChatList();
      if (S.activePeer === peer) renderHeader();
      break;
    }
    case 'call':
      await S.calls.handle(msg);
      break;
    case 'call-error':
      toast(msg.reason || 'Call failed.', 'err');
      break;
    case 'unauthorized':
      handleUnauthorized();
      break;
    default:
      break;
  }
}

function handleUnauthorized() {
  toast('Session expired. Please sign in again.', 'err');
  S.api.close();
  $('#shell').hidden = true;
  $('#auth').hidden = false;
  const user = localStorage.getItem('gm:lastUser') || '';
  if (user) $('#auth-username').value = user;
}

/* =================================================================== crypto */

async function peerBundle(peer, { force = false } = {}) {
  const key = String(peer).toLowerCase();
  if (!force && S.bundles.has(key)) return S.bundles.get(key);
  const res = await S.api.keys(peer);
  C.verifyBundle(res.keys);
  S.bundles.set(key, res.keys);
  return res.keys;
}

async function ensureSession(peer) {
  const key = String(peer).toLowerCase();
  let state = await S.vault.loadSession(key);
  if (!state) {
    const bundle = await peerBundle(key);
    state = C.initiatorSession(S.identity, bundle);
    await S.vault.saveSession(key, state);
  }
  return state;
}

async function sendPayload(peer, kind, payload) {
  if (isGroup(peer)) return sendGroupPayload(peer, kind, payload);
  const key = String(peer).toLowerCase();
  const clientId = D.randomId(8);
  const envelope = await withLock(key, async () => {
    const state = await ensureSession(key);
    const env = await C.encryptMessage(state, { kind, ...payload });
    await S.vault.saveSession(key, state);
    return env;
  });

  const record = {
    id: null,
    clientId,
    peer: key,
    dir: 'out',
    from: S.me.username.toLowerCase(),
    ts: Date.now(),
    kind,
    payload,
    status: 'sending',
  };
  pushRecord(key, record);
  renderChatList();
  if (S.activePeer === key) renderConversation({ scroll: 'bottom' });

  try {
    const res = await S.api.sendMessage(key, envelope, clientId);
    reconcileSent(key, clientId, res.msg);
    S.sound.sent();
  } catch (err) {
    updateRecord(key, (r) => r.clientId === clientId, (r) => { r.status = 'failed'; });
    renderChatList();
    if (S.activePeer === key) renderConversation({ scroll: false });
    toast(err.message || 'Message failed to send.', 'err');
    throw err;
  }
  return record;
}

// Group send: one story for the sender, one sealed copy per member. Each copy
// rides that member's pairwise ratchet, so the relay sees only ciphertext —
// same guarantee as 1:1, no shared keys. `gid` is how the receiver routes it.
async function sendGroupPayload(peer, kind, payload) {
  const peerKey = String(peer);
  const group = groupOf(peerKey);
  if (!group) throw new Error('This group no longer exists.');
  const gid = group.id;
  const me = S.me.username.toLowerCase();
  const members = group.members.filter((m) => m !== me);
  if (!members.length) throw new Error('You are the only goat here.');

  const clientId = D.randomId(8);
  const record = {
    id: null,
    clientId,
    peer: peerKey,
    dir: 'out',
    from: me,
    ts: Date.now(),
    kind,
    payload,
    status: 'sending',
  };
  pushRecord(peerKey, record);
  renderChatList();
  if (S.activePeer === peerKey) renderConversation({ scroll: 'bottom' });

  let ok = 0;
  let failed = 0;
  for (const member of members) {
    try {
      const envelope = await withLock(member, async () => {
        const state = await ensureSession(member);
        const env = await C.encryptMessage(state, { kind, gid, ...payload });
        await S.vault.saveSession(member, state);
        return env;
      });
      await S.api.sendMessage(member, envelope, clientId, gid);
      ok++;
    } catch {
      failed++;
    }
  }

  updateRecord(peerKey, (r) => r.clientId === clientId && r.dir === 'out', (r) => {
    r.status = ok ? 'sent' : 'failed';
    if (failed) r.missed = failed;
  });
  if (ok) S.sound.sent();
  if (failed) toast(`Could not deliver to ${failed} of ${members.length} goats.`, 'err');
  renderChatList();
  if (S.activePeer === peerKey) renderConversation({ scroll: false });
  return record;
}

// Keep the in-memory copy bounded too — the store and RAM should agree, or a
// long-lived chat drags every old note around until the window is closed.
function capList(list) {
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
  return list;
}

function pushRecord(peer, record) {
  const list = S.messages.get(peer) || [];
  list.push(record);
  list.sort((a, b) => (a.ts - b.ts) || String(a.id).localeCompare(String(b.id)));
  S.messages.set(peer, capList(list));
  persist(peer);
}

function updateRecord(peer, match, mutate) {
  const list = S.messages.get(peer) || [];
  const target = list.find(match);
  if (!target) return false;
  mutate(target);
  persist(peer);
  return true;
}

function reconcileSent(peer, clientId, serverMsg) {
  updateRecord(peer, (r) => r.clientId === clientId && r.dir === 'out', (r) => {
    r.id = serverMsg.id;
    r.seq = serverMsg.seq;
    r.ts = serverMsg.ts;
    r.status = (S.readUpTo.get(peer) || 0) >= serverMsg.seq ? 'read' : 'sent';
  });
  renderChatList();
  if (S.activePeer === peer) renderConversation({ scroll: false });
}

const persistTimers = new Map();
function persist(peer) {
  clearTimeout(persistTimers.get(peer));
  persistTimers.set(peer, setTimeout(() => {
    const list = S.messages.get(peer) || [];
    S.vault.saveMessages(peer, list).catch(() => {});
  }, 200));
}

async function receiveMessage(msg) {
  if (!msg || !msg.env) return;
  const peer = String(msg.from).toLowerCase();
  if (peer === S.me.username.toLowerCase()) {
    // echo of our own message on another device/socket
    if (msg.clientId) reconcileSent(String(msg.to).toLowerCase(), msg.clientId, msg);
    return;
  }
  const existing = (S.messages.get(peer) || []).find((r) => r.id === msg.id);
  if (existing) return;

  let payload;
  try {
    payload = await withLock(peer, async () => {
      let state = await S.vault.loadSession(peer);
      let clear;
      if (!state) {
        if (msg.env.type !== 'prekey') throw new Error('missing session');
        await checkPrekeyIdentity(peer, msg.env.prekey);
        state = C.responderSession(S.identity, msg.env.prekey);
        clear = await C.decryptMessage(state, msg.env);
        await S.vault.saveSession(peer, state);
      } else {
        try {
          clear = await C.decryptMessage(state, msg.env);
        } catch (err) {
          if (msg.env.type !== 'prekey') throw err;
          await checkPrekeyIdentity(peer, msg.env.prekey);
          state = C.responderSession(S.identity, msg.env.prekey);
          clear = await C.decryptMessage(state, msg.env);
          await S.vault.saveSession(peer, state);
        }
      }
      if (state.pendingPrekey) {
        C.confirmSession(state);
        await S.vault.saveSession(peer, state);
      }
      return clear;
    });
  } catch (err) {
    S.droppedEnvelopes++;
    console.warn('could not decrypt message from', peer, err.message);
    return;
  }

  const gid = typeof payload.gid === 'string' ? payload.gid : '';
  const gKey = gid && S.groups.get(`group:${gid}`) ? `group:${gid}` : null;
  if (gKey) delete payload.gid; // consumers see a normal message record
  else if (!S.contacts.has(peer)) {
    await refreshBootstrap();
  }

  const record = {
    id: msg.id,
    clientId: msg.clientId || null,
    peer: gKey || peer,
    dir: 'in',
    from: peer, // the real sender; for groups the conversation is the group
    ts: msg.ts,
    seq: msg.seq,
    kind: payload.kind || 'text',
    payload,
    status: 'delivered',
  };
  pushRecord(record.peer, record);

  const isActive = S.activePeer === record.peer;
  await notifyIncoming(record.peer, peer, payload, record);
  if (!isActive) {
    S.unread.set(record.peer, (S.unread.get(record.peer) || 0) + 1);
    rememberUnread();
  } else if (!gKey) {
    sendRead(peer, msg.seq);
  }
  renderChatList();
  if (S.activePeer === record.peer) renderConversation({ scroll: 'bottom' });
  syncBadge();
}

// Audible + OS notification for a message that needs attention: a new note in
// any chat you are not currently looking at (or while the app is unfocused).
function notifyIncoming(peerKey, senderPeer, payload, record) {
  if (S.info?.e2e) return; // automated runs stay quiet
  const inChat = S.activePeer === peerKey && !document.hidden && document.hasFocus();
  if (!inChat) {
    if (S.notify.sound) S.sound.notify();
    if (S.notify.desktop) {
      const name = displayName(senderPeer);
      window.goat?.notify?.({
        title: isGroup(peerKey) ? `${displayName(peerKey)} — ${name}` : name,
        body: previewText(record) || 'New message',
        peer: peerKey,
        where: isGroup(peerKey) ? displayName(peerKey) : '',
      })?.catch?.(() => {});
    }
  }
}

async function checkPrekeyIdentity(peer, prekey) {
  try {
    const bundle = await peerBundle(peer, { force: !S.bundles.has(peer) });
    if (bundle.ik !== prekey.ik) throw new Error('peers key does not match the pinned bundle');
  } catch (err) {
    throw new Error(`Identity check failed for ${peer}`);
  }
}

async function applyReadReceipt(peer, upTo) {
  // A read event can arrive before our own POST resolves (the relay pushes to
  // the reader first), so remember the watermark and apply it on reconcile too.
  S.readUpTo.set(peer, Math.max(S.readUpTo.get(peer) || 0, upTo || 0));
  const list = S.messages.get(peer) || [];
  let changed = false;
  for (const rec of list) {
    if (rec.dir === 'out' && rec.seq && rec.seq <= upTo && rec.status !== 'read') {
      rec.status = 'read';
      changed = true;
    }
  }
  if (changed) {
    await S.vault.saveMessages(peer, list);
    if (S.activePeer === peer) renderConversation({ scroll: false });
  }
}

function sendRead(peer, upTo) {
  if (!upTo) return;
  S.api.sendWs({ t: 'read', to: peer, upTo });
}

function rememberUnread() {
  const obj = Object.fromEntries([...S.unread.entries()].filter(([, n]) => n > 0));
  S.vault.setPref('unread', obj).catch(() => {});
}

/* ================================================================ rendering */

function renderMe() {
  const me = S.me;    D.paintAvatar($('#me-avatar'), { name: me.displayName || me.username, accent: me.accent, avatar: me.avatar });
  $('#me-name').textContent = me.displayName || me.username;
  if (S.api?.ws && S.api.ws.readyState === WebSocket.OPEN) {
    $('#me-status').innerHTML = '';
    $('#me-status').classList.remove('offline');
    $('#me-status').append(el('i', { class: 'dot' }), el('span', { text: 'Connected · encrypted' }));
  }
}

// Keyed DOM state: contact rows and messages keep their live DOM node until
// their content actually changes, so sends, receipts and presence ticks no
// longer flash the whole list.
const chatState = { rows: new Map(), hint: null };
const convState = { peer: null, rows: new Map() };

function stripAnim(node) { node.style.animation = 'none'; return node; }

function contactRowSig(peer) {
  const g = isGroup(peer) ? groupOf(peer) : null;
  const rec = g ? { displayName: g.name, accent: accentOf(peer) } : S.contacts.get(peer);
  if (!rec) return null;
  const list = S.messages.get(peer) || [];
  const last = list[list.length - 1];
  return JSON.stringify([
    S.activePeer === peer,
    rec?.displayName, rec?.accent, isGroup(peer) ? 'group' : isOnline(peer),
    rec?.avatar || '', rec?.banner || '',
    last?.ts || rec?.last?.ts || rec?.since || 0, rec?.since,
    (S.typingUntil.get(peer) || 0) > Date.now(),
    last ? previewText(last) : '',
    S.unread.get(peer) || 0,
  ]);
}

function contactRow(peer, { fresh = true } = {}) {
  const g = isGroup(peer) ? groupOf(peer) : null;
  const rec = g
    ? { displayName: g.name, accent: accentOf(peer), state: 'accepted' }
    : S.contacts.get(peer);
  if (!rec) return null;
  const list = S.messages.get(peer) || [];
  const last = list[list.length - 1];
  const unread = S.unread.get(peer) || 0;

  const row = el('div', {
    class: `chat-row${S.activePeer === peer ? ' is-active' : ''}`,
    dataset: { peer },
  });
  const avatar = el('div', { class: 'avatar' });
  if (g) {
    D.paintAvatar(avatar, { name: `👥 ${rec.displayName || g.name}`, accent: rec.accent });
  } else {
    D.paintAvatar(avatar, {
      name: rec.displayName || rec.username, accent: rec.accent, online: isOnline(peer), showPresence: true, avatar: rec.avatar,
    });
  }
  const main = el('div', { class: 'chat-main' });
  const top = el('div', { class: 'chat-top' },
    el('div', { class: 'chat-name', text: rec.displayName || rec.username }),
    el('div', { class: 'chat-time', text: D.shortRelative(last?.ts || rec.last?.ts || rec.since) }));
  const preview = el('div', { class: 'chat-preview' });
  const typing = !g && (S.typingUntil.get(peer) || 0) > Date.now();
  if (typing) {
    preview.append(el('em', { text: 'typing…' }));
  } else if (last) {
    // Group previews name the sender so the list reads like a room.
    const prefix = !g ? '' : last.dir === 'out' ? 'You: ' : `${displayName(last.from)}: `;
    preview.append(icon('lock', 'lockmini'), document.createTextNode(prefix + previewText(last)));
  } else {
    preview.append(el('span', { text: `${g ? 'New group — say hello' : 'No messages yet'}` }));
  }
  main.append(top, preview);
  row.append(avatar, main);
  if (unread > 0) row.append(el('div', { class: 'badge', text: String(unread) }));
  row.addEventListener('click', () => openChat(peer));
  if (!fresh) stripAnim(row);
  return row;
}

function previewText(rec) {
  const prefix = rec.dir === 'out' ? 'You: ' : '';
  const p = rec.payload || {};
  switch (rec.kind) {
    case 'image': return `${prefix}📷 Photo`;
    case 'file': return `${prefix}📎 ${p.name || 'File'}`;
    case 'voice': return `${prefix}🎙 ${String(p.text || '').trim().slice(0, 70) || 'Voice note'}`;
    case 'call': return `${prefix}${callNoteText(p)}`;
    default: return prefix + String(p.text || '').replace(/\s+/g, ' ').slice(0, 90);
  }
}

function callNoteText(p) {
  const kind = p.callKind === 'video' ? 'Video call' : 'Call';
  switch (p.outcome) {
    case 'completed': return `${kind} · ${D.duration(p.durationSec || 0)}`;
    case 'declined': return `${kind} declined`;
    case 'missed': return `Missed ${kind.toLowerCase()}`;
    case 'no-answer': return `No answer`;
    case 'cancelled': return `${kind} cancelled`;
    default: return `${kind} failed`;
  }
}

function renderChatList() {
  const box = $('#chat-list');
  const query = S.search.trim().toLowerCase();
  const accepted = [...S.contacts.values()].filter((c) => c.state === 'accepted');

  const groups = [...S.groups.values()].map((g) => ({
    pseudo: 'group',
    username: `group:${g.id}`,
    displayName: g.name,
    accent: accentOf(`group:${g.id}`),
    state: 'accepted',
    since: g.createdAt,
  }));
  const everyone = [...accepted, ...groups];
  const scored = everyone.filter((c) => {
    if (!query) return true;
    if ((c.displayName || c.username).toLowerCase().includes(query)) return true;
    if (c.username.toLowerCase().includes(query)) return true;
    const peer = c.pseudo ? c.username : c.username.toLowerCase();
    const msgs = S.messages.get(peer) || [];
    return msgs.some((m) => String(m.payload?.text || '').toLowerCase().includes(query));
  }).sort((a, b) => {
    const key = (c) => (c.pseudo ? c.username : c.username.toLowerCase());
    const la = (S.messages.get(key(a))?.at(-1)?.ts) || a.last?.ts || a.since || 0;
    const lb = (S.messages.get(key(b))?.at(-1)?.ts) || b.last?.ts || b.since || 0;
    return lb - la;
  });

  const wanted = new Set();
  const seq = [];
  for (const contact of scored) {
    const peer = contact.pseudo ? contact.username : contact.username.toLowerCase();
    wanted.add(peer);
    const sig = contactRowSig(peer);
    let item = chatState.rows.get(peer);
    if (!item) {
      const node = contactRow(peer);
      if (!node) continue;
      item = { sig, node };
      chatState.rows.set(peer, item);
    } else if (item.sig !== sig) {
      const node = contactRow(peer, { fresh: false });
      if (node) {
        item.node.replaceWith(node);
        item.node = node;
        item.sig = sig;
      }
    }
    seq.push(item.node);
  }
  for (const [peer, item] of chatState.rows) {
    if (!wanted.has(peer)) { item.node.remove(); chatState.rows.delete(peer); }
  }

  if (!seq.length) {
    const text = query ? 'No goats match that.' : 'No goats yet — tap + to find one.';
    if (!chatState.hint || chatState.hint._text !== text) {
      chatState.hint?.remove();
      chatState.hint = el('div', { class: 'chat-preview', style: { padding: '18px 12px', textAlign: 'center' } });
      chatState.hint.append(el('span', { text }));
      chatState.hint._text = text;
    }
    box.append(chatState.hint);
  } else if (chatState.hint) {
    chatState.hint.remove();
    chatState.hint = null;
  }

  for (const node of seq) box.append(node);
}

function renderRequests() {
  const box = $('#requests');
  box.innerHTML = '';
  const incoming = [...S.contacts.values()].filter((c) => c.state === 'in');
  const outgoing = [...S.contacts.values()].filter((c) => c.state === 'out');
  if (!incoming.length && !outgoing.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const req of incoming) {
    const card = el('div', { class: 'request-card' });
    const avatar = el('div', { class: 'avatar' });      D.paintAvatar(avatar, { name: req.displayName || req.username, accent: req.accent, avatar: req.avatar });
    card.append(avatar,
      el('div', { class: 'request-text' },
        el('b', { text: req.displayName || req.username }),
        el('span', { text: 'wants to connect' })),
      el('div', { class: 'request-actions' },
        el('button', { class: 'mini quiet', text: 'No', onclick: () => declineRequest(req.username) }),
        el('button', { class: 'mini', text: 'Accept', onclick: () => acceptRequest(req.username) })));
    box.append(card);
  }
  for (const req of outgoing) {
    const card = el('div', { class: 'request-card' });
    const avatar = el('div', { class: 'avatar' });      D.paintAvatar(avatar, { name: req.displayName || req.username, accent: req.accent, avatar: req.avatar });
    card.append(avatar,
      el('div', { class: 'request-text' },
        el('b', { text: req.displayName || req.username }),
        el('span', { text: 'request sent · waiting' })),
      el('div', { class: 'request-actions' },
        el('button', { class: 'mini quiet', text: 'Cancel', onclick: () => declineRequest(req.username) })));
    box.append(card);
  }
}

// Group info passed as a profile card: banner-less, member list, and the way out.
function openGroupInfo() {
  const key = S.activePeer;
  const g = groupOf(key);
  if (!g) return;
  const members = el('div', { class: 'group-members' });
  for (const member of [...g.members].sort()) {
    const isMe = member === S.me.username.toLowerCase();
    const row = el('div', { class: 'picker-row group-member' });
    const avatar = el('div', { class: 'avatar' });
    const rec = S.contacts.get(member);
    const name = isMe ? `${S.me.displayName || member} (you)` : displayName(member);
    D.paintAvatar(avatar, { name: displayName(member), accent: accentOf(member), avatar: rec?.avatar || '' });
    const nameEl = el('div', { class: 'chat-name' });
    nameEl.append(name);
    const badge = isMe ? null : verifiedBadge(member);
    if (badge) nameEl.append(badge);
    row.append(avatar, nameEl,
      member === g.owner ? el('span', { class: 'chip', text: 'creator' }) : null,
      isMe ? null : el('span', { class: 'chip', text: isOnline(member) ? 'online' : 'offline' }));
    members.append(row);
  }
  const card = el('div', { class: 'profile-card' },
    el('div', { class: 'pc-banner' }),
    el('div', { class: 'pc-main' },
      (() => { const av = el('div', { class: 'avatar big pc-avatar' }); D.paintAvatar(av, { name: `👥 ${g.name}`, accent: accentOf(key) }); return av; })(),
      el('div', { class: 'pc-id' },
        el('div', { class: 'pc-name', text: g.name }),
        el('div', { class: 'pc-handle', text: `${g.members.length} goats · end-to-end encrypted` }))),
    members,
    el('p', { class: 'sub', text: 'Group messages are sealed to every member separately over pairwise ratchets — the relay only ever carries ciphertext.' }),
    el('div', { class: 'modal-actions' },
      el('button', { class: 'ghost', text: 'Close', onclick: closeModal }),
      el('button', { class: 'ghost danger-btn', text: 'Leave group', onclick: async () => {
        try {
          await S.api.leaveGroup(g.id);
          toast(`You left “${g.name}”.`);
        } catch (err) {
          toast(err.message, 'err');
          return;
        }
        showEmpty();
        closeModal();
        await refreshBootstrap();
      } })));
  openModal(el('div', { class: 'modal profile-modal' }, card));
}

async function acceptRequest(peer) {
  try {
    const data = await S.api.acceptContact(peer);
    applyBootstrap(data);
    toast(`Connected with ${displayName(peer)}.`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function declineRequest(peer) {
  try {
    applyBootstrap(await S.api.removeContact(peer));
  } catch (err) {
    toast(err.message, 'err');
  }
}

// Blue checkmark for code-verified handles (see shared/verified.mjs).
function verifiedBadge(username) {
  if (!isVerified(username)) return null;
  return el('span', {
    class: 'badge-verified',
    role: 'img',
    tabindex: '0',
    'aria-label': VERIFIED_TIP,
    'data-tip': VERIFIED_TIP,
    html: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11"></circle><path d="M6.8 12.6l3.3 3.3 7-8.2"></path></svg>',
  });
}

function renderHeader() {
  const peer = S.activePeer;
  if (!peer) return;
  const g = isGroup(peer) ? groupOf(peer) : null;
  const rec = S.contacts.get(peer);
  const avatar = $('#peer-avatar');
  D.paintAvatar(avatar, { name: displayName(peer), accent: accentOf(peer), online: g ? false : isOnline(peer), showPresence: !g, avatar: avatarOf(peer) });
  const nameEl = $('#peer-name');
  nameEl.innerHTML = '';
  nameEl.append(displayName(peer));
  if (g) nameEl.append(el('span', { class: 'chip tiny', text: 'group' }));
  const badge = verifiedBadge(peer);
  if (badge) nameEl.append(badge);

  const sub = $('#peer-sub');
  sub.innerHTML = '';
  if (g) {
    sub.append(
      el('i', { class: 'dot off' }),
      el('span', { text: `${g.members.length} goats` }),
      el('span', { text: '·' }),
      el('span', { text: 'end-to-end encrypted' }),
    );
    $('#btn-verify').title = 'Groups keep pairwise ratchets';
    return;
  }
  const typing = (S.typingUntil.get(peer) || 0) > Date.now();
  if (typing) {
    sub.append(el('span', { text: `${rec?.displayName || peer} is typing…` }));
  } else {
    sub.append(
      el('i', { class: `dot${isOnline(peer) ? '' : ' off'}` }),
      el('span', { text: isOnline(peer) ? 'Online' : 'Offline' }),
      el('span', { text: '·' }),
      el('span', { text: 'end-to-end encrypted' }),
    );
  }
  $('#btn-verify').title = S.verified.has(peer) ? 'Verified encryption' : 'Encryption and safety number';
}

function renderTyping() {
  const peer = S.activePeer;
  const row = $('#typing-row');
  if (!peer) { row.hidden = true; return; }
  const active = (S.typingUntil.get(peer) || 0) > Date.now();
  row.hidden = !active;
  if (active) $('#typing-name').textContent = `${displayName(peer)} is typing…`;
}

function messageMeta(rec) {
  const meta = el('span', { class: 'meta' }, document.createTextNode(D.clockTime(rec.ts)));
  if (rec.dir === 'out') {
    if (rec.status === 'sending') meta.append(icon('check'));
    else if (rec.status === 'sent') meta.append(icon('check'));
    else if (rec.status === 'delivered') meta.append(icon('checks'));
    else if (rec.status === 'read') meta.append(icon('checks', 'read'));
    else if (rec.status === 'failed') meta.append(el('span', { text: '· not sent' }));
  }
  return meta;
}

function bubbleFor(rec) {
  const bubble = el('div', { class: 'bubble' });
  const payload = rec.payload || {};

  if (rec.kind === 'call') {
    bubble.append(el('div', { class: 'call-note' }, icon('phone'),
      el('span', { text: callNoteText(payload) })), messageMeta(rec));
    return bubble;
  }

  if (rec.kind === 'image' || rec.kind === 'file') {
    bubble.classList.add('has-media');
    if (payload.caption) bubble.append(el('div', { class: 'caption', text: payload.caption }));
    const holder = el('div', { class: 'media-slot' });
    bubble.append(holder);
    if (rec.kind === 'image') {
      holder.append(el('div', { class: 'media-loading', text: 'Decrypting…' }));
    } else {
      const card = el('div', { class: 'file-card' },
        el('div', { class: 'file-icon' }, icon('clip')),
        el('div', {},
          el('div', { class: 'file-name', text: payload.name || 'File' }),
          el('div', { class: 'file-size', text: D.fileSize(payload.size) })));
      const save = el('button', { class: 'icon-btn', title: 'Save to disk', onclick: () => downloadAttachment(rec) }, icon('download'));
      card.append(save);
      holder.append(card);
    }
    bubble.append(messageMeta(rec));
    hydrate(rec, holder);
    return bubble;
  }

  if (rec.kind === 'voice') {
    bubble.append(buildVoice(rec), messageMeta(rec));
    return bubble;
  }

  bubble.innerHTML = D.linkify(String(payload.text || ''));
  bubble.append(messageMeta(rec));
  return bubble;
}

async function hydrate(rec, holder) {
  if (rec.kind !== 'image') return;
  try {
    const url = await attachmentUrl(rec);
    const img = el('img', { class: 'media-image', src: url, alt: rec.payload.name || 'photo' });
    img.addEventListener('click', () => openLightbox(url, rec));
    holder.innerHTML = '';
    holder.append(img);
    if (S.activePeer) {
      const box = $('#messages');
      if (D.atBottom(box, 160)) D.scrollToBottom(box, false);
    }
  } catch (err) {
    holder.innerHTML = '';
    holder.append(el('div', { class: 'media-loading', text: 'Image unavailable' }));
  }
}

async function attachmentUrl(rec) {
  const id = rec.payload.fileId;
  if (S.mediaCache.has(id)) return S.mediaCache.get(id);
  const bytes = await S.api.download(id);
  const plain = await C.decryptBytes(rec.payload.key, bytes);
  const blob = new Blob([plain], { type: rec.payload.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  if (S.mediaCache.size > 40) {
    const [oldKey, oldUrl] = S.mediaCache.entries().next().value;
    URL.revokeObjectURL(oldUrl);
    S.mediaCache.delete(oldKey);
  }
  S.mediaCache.set(id, url);
  return url;
}

function buildVoice(rec) {
  const wrap = el('div', { class: 'voice-card' });
  const btn = el('button', { class: 'voice-play', type: 'button' }, icon('play'));
  const bars = el('div', { class: 'voice-bars' });
  for (let i = 0; i < 26; i++) {
    const h = 6 + Math.round(Math.abs(Math.sin(i * 1.7)) * 18);
    bars.append(el('i', { style: { height: `${h}px` } }));
  }
  const time = el('div', { class: 'voice-time', text: D.duration(rec.payload.duration || 0) });
  const audio = el('audio', { preload: 'none' });
  let loaded = false;
  let playing = false;

  const ensureSource = async () => {
    if (loaded) return;
    const url = await attachmentUrl(rec);
    audio.src = url;
    loaded = true;
  };

  btn.addEventListener('click', async () => {
    try {
      await ensureSource();
      if (playing) { audio.pause(); return; }
      await audio.play();
    } catch {
      toast('Could not play this voice note.', 'err');
    }
  });
  audio.addEventListener('play', () => {
    playing = true;
    btn.innerHTML = '';
    btn.append(icon('pause'));
  });
  audio.addEventListener('pause', () => {
    playing = false;
    btn.innerHTML = '';
    btn.append(icon('play'));
  });
  audio.addEventListener('timeupdate', () => {
    // Chrome reports Infinity for MediaRecorder WebM blobs — that must not win
    // over the duration stamped into the payload at record time.
    const total = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : (Number(rec.payload.duration) > 0 ? rec.payload.duration : (audio.currentTime || 1));
    const progress = audio.currentTime / total;
    Array.from(bars.children).forEach((bar, i) => bar.classList.toggle('on', i / bars.children.length <= progress));
    time.textContent = D.duration(Math.max(0, total - audio.currentTime));
  });
  audio.addEventListener('loadedmetadata', () => {
    time.textContent = D.duration(Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : Number(rec.payload.duration) > 0 ? rec.payload.duration : 0);
  });
  audio.addEventListener('ended', () => {
    time.textContent = D.duration(rec.payload.duration || 0);
    Array.from(bars.children).forEach((bar) => bar.classList.remove('on'));
  });

  wrap.append(btn, bars, time, audio);

  // Transcript row. A note you sent already carries the words captured while
  // recording; a received note can be transcribed on this device while it
  // plays (approximate — the recognizer hears it through the speakers).
  const transcript = el('div', { class: 'voice-transcript' });
  const stored = String(rec.payload.text || '').trim();
  const canHear = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const bodyEl = el('div', { class: 'voice-transcript-body' });
  const btnEl = el('button', {
    class: 'transcript-btn', type: 'button', 'aria-label': 'Transcribe voice note',
    onclick: async () => {
      if (transcript.dataset.open === '1') {
        transcript.dataset.open = '0';
        return;
      }
      transcript.dataset.open = '1';
      if (stored) {
        bodyEl.textContent = stored;
        return;
      }
      bodyEl.textContent = 'Transcribing…';
      const text = await transcribePlayback();
      bodyEl.textContent = text || 'Nothing recognisable picked up.';
    },
  });
  const recorded = Boolean(rec.payload.text);
  btnEl.textContent = 'Transcribe';
  if (!recorded && !canHear) {
    // Electron's Chromium ships without a speech backend, so do not promise a
    // button that cannot work there — the tooltip says why.
    btnEl.disabled = true;
    btnEl.title = 'This build has no speech engine. Notes sent from a device that does carry their transcript.';
  }
  transcript.append(btnEl, bodyEl);
  transcript.dataset.open = '0';

  return el('div', { class: 'voice-wrap' }, wrap, transcript);
}

// Live recognition while a received note is playing — same on-device engine,
// it simply hears the audio close to the speakers, so keep expectations low.
const playedRecognizers = new Set();
async function transcribePlayback() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return '';
  return new Promise((resolve) => {
    const hear = new SR();
    hear.continuous = true;
    hear.interimResults = false;
    hear.lang = navigator.language || 'en-US';
    let text = '';
    const done = (finalText) => {
      if (playedRecognizers.has(hear)) return;
      playedRecognizers.add(hear);
      try { hear.onend = null; hear.onresult = null; hear.onerror = null; hear.stop(); } catch {}
      setTimeout(() => playedRecognizers.delete(hear), 400);
      resolve(finalText.trim());
    };
    hear.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) text += ` ${event.results[i][0].transcript}`;
      }
    };
    hear.onerror = () => done('');
    hear.onend = () => done('');
    try { hear.start(); } catch { resolve(''); return; }
    setTimeout(() => done(''), 25000);
  });
}

function convKey(rec) {
  if (rec.clientId) return `c:${rec.clientId}`;
  if (rec.id) return `m:${rec.id}`;
  return `x:${rec.ts}:${rec.kind}:${rec.dir}`;
}

function rowSig(rec, prev, next) {
  const samePrev = prev && prev.dir === rec.dir && prev.from === rec.from && rec.ts - prev.ts < 5 * 60 * 1000;
  const sameNext = next && next.dir === rec.dir && next.from === rec.from && next.ts - rec.ts < 5 * 60 * 1000;
  return `${D.dayLabel(rec.ts)}|${samePrev ? 1 : 0}${sameNext ? 1 : 0}|${rec.dir}|${rec.status}|${rec.ts}|${rec.id || ''}`;
}

function messageRowNode(rec, prev, next, { fresh = true } = {}) {
  const samePrev = prev && prev.dir === rec.dir && prev.from === rec.from && rec.ts - prev.ts < 5 * 60 * 1000;
  const sameNext = next && next.dir === rec.dir && next.from === rec.from && next.ts - rec.ts < 5 * 60 * 1000;
  const peer = S.activePeer;

  const row = el('div', {
    class: [
      'msg', rec.dir,
      samePrev ? 'stacked' : 'group-start',
      sameNext ? 'group-mid' : 'group-end',
    ].join(' '),
  });
  const g = isGroup(peer);
  if (rec.dir === 'in') {
    if (!sameNext) {
      const avatar = el('div', { class: 'avatar msg-avatar' });
      // Groups show the sender's own face, not the conversation's.
      D.paintAvatar(avatar, g
        ? { name: displayName(rec.from), accent: accentOf(rec.from), avatar: avatarOf(rec.from) }
        : { name: displayName(peer), accent: accentOf(peer), avatar: avatarOf(peer) });
      row.append(avatar);
    } else {
      row.append(el('div', { class: 'spacer' }));
    }
  }
  if (g && rec.dir === 'in' && !samePrev) {
    row.append(el('div', { class: 'msg-sender', text: displayName(rec.from) }));
  }
  row.append(bubbleFor(rec));
  if (!fresh) {
    stripAnim(row);
    const bubble = row.querySelector('.bubble');
    if (bubble) stripAnim(bubble);
  }
  return row;
}

function dayDividerNode(day) {
  const key = `d:${day}`;
  let item = convState.rows.get(key);
  if (!item) {
    item = { sig: day, node: el('div', { class: 'day-divider', text: day }) };
    convState.rows.set(key, item);
  }
  return item.node;
}

function renderConversation({ scroll = 'bottom' } = {}) {
  const box = $('#messages');
  const peer = S.activePeer;
  if (!peer) return;
  const wasBottom = D.atBottom(box, 140);
  if (convState.peer !== peer) {
    box.innerHTML = '';
    convState.peer = peer;
    convState.rows.clear();
  }

  const list = (S.messages.get(peer) || []).slice().sort((a, b) => (a.ts - b.ts) || String(a.id || '').localeCompare(String(b.id || '')));
  const wanted = new Set();
  const seq = [];
  let lastDay = '';
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    const day = D.dayLabel(rec.ts);
    if (day !== lastDay) {
      seq.push(dayDividerNode(day));
      wanted.add(`d:${day}`);
      lastDay = day;
    }
    const key = convKey(rec);
    wanted.add(key);
    const sig = rowSig(rec, list[i - 1], list[i + 1]);
    let item = convState.rows.get(key);
    if (!item) {
      item = { sig, node: messageRowNode(rec, list[i - 1], list[i + 1]) };
      convState.rows.set(key, item);
    } else if (item.sig !== sig) {
      const node = messageRowNode(rec, list[i - 1], list[i + 1], { fresh: false });
      item.node.replaceWith(node);
      item.node = node;
      item.sig = sig;
    }
    seq.push(item.node);
  }
  for (const [key, item] of convState.rows) {
    if (!wanted.has(key)) { item.node.remove(); convState.rows.delete(key); }
  }

  const hintText = `This is the start of your encrypted thread with ${displayName(peer)}. Everything here is sealed before it leaves your Mac.`;
  if (!list.length) {
    if (!convState.hint || convState.hint._text !== hintText) {
      convState.hint?.remove();
      convState.hint = el('div', { class: 'empty-inline' },
        el('div', { class: 'chat-preview', style: { textAlign: 'center', marginTop: '40px', whiteSpace: 'normal' } }));
      convState.hint.firstChild.append(el('span', { text: hintText }));
      convState.hint._text = hintText;
    }
    seq.push(convState.hint);
  } else if (convState.hint) {
    convState.hint.remove();
    convState.hint = null;
  }

  for (const node of seq) box.append(node);

  if (scroll === 'bottom' || (scroll !== false && wasBottom)) {
    requestAnimationFrame(() => D.scrollToBottom(box, scroll === 'smooth'));
  }
}

/* --------------------------------------------------------------- navigation */

async function openChat(peer, { silent = false } = {}) {
  const key = String(peer).toLowerCase();
  const g = S.groups.get(key);
  if (!g && (!S.contacts.has(key) || S.contacts.get(key).state !== 'accepted')) {
    toast('Accept the request first to start talking.', 'err');
    return;
  }
  const changed = S.activePeer !== key;
  S.activePeer = key;
  S.unread.set(key, 0);
  rememberUnread();
  S.vault.setPref('lastPeer', key).catch(() => {});

  $('#pane').hidden = false;
  $('#empty-state').hidden = true;
  renderHeader();
  renderChatList();

  if (!S.messages.has(key) || !S.messages.get(key).length) {
    S.messages.set(key, await S.vault.loadMessages(key));
  }
  renderConversation({ scroll: 'bottom' });
  renderTyping();
  if (changed && !silent) S.sound.chatOpen();

  const hideCalls = Boolean(g);
  for (const id of ['#btn-call-audio', '#btn-call-video', '#btn-verify']) {
    const btn = $(id);
    if (btn) btn.classList.toggle('is-hidden-for-group', hideCalls);
  }

  if (g) {
    await ingestGroupHistory(key);
    syncBadge();
    $('#composer-input').focus();
    return;
  }

  const lastSeq = (S.messages.get(key) || []).reduce((max, r) => Math.max(max, r.seq || 0), 0);
  if (lastSeq) sendRead(key, lastSeq);

  try {
    const { messages } = await S.api.history(key, 0);
    await ingestHistory(key, messages);
  } catch { /* offline: local history stands */ }

  syncBadge();
  $('#composer-input').focus();
}

// Group history rides pairwise relay rooms (the sealed copies). Pull each
// member's thread once when a group chat opens, and route the group envelopes.
async function ingestGroupHistory(gk) {
  const g = groupOf(gk);
  if (!g) return;
  const me = S.me.username.toLowerCase();
  const known = new Set((S.messages.get(gk) || []).map((r) => r.id).filter(Boolean));
  let added = 0;
  for (const member of g.members) {
    if (member === me) continue;
    const list = S.messages.get(gk) || [];
    if (list.length && added === 0 && known.size > 2) break; // already populated locally
    try {
      const { messages } = await S.api.history(member, 0);
      await withLock(member, async () => {
        const state = await S.vault.loadSession(member);
        if (!state) return;
        for (const msg of messages) {
          if (known.has(msg.id)) continue;
          if (msg.from === me) continue;
          let payload;
          try { payload = await C.decryptMessage(state, msg.env); } catch { continue; }
          if (typeof payload.gid !== 'string' || payload.gid !== g.id) continue;
          delete payload.gid;
          known.add(msg.id);
          list.push({
            id: msg.id, clientId: msg.clientId || null, peer: gk, dir: 'in', from: member,
            ts: msg.ts, seq: msg.seq, kind: payload.kind || 'text', payload, status: 'delivered',
          });
          added++;
        }
        await S.vault.saveSession(member, state);
        if (added) await S.vault.saveMessages(gk, capList(list));
      });
    } catch { /* not pairwise-connected to this member; skip */ }
  }
  if (added && S.activePeer === gk) renderConversation({ scroll: false });
}

async function ingestHistory(peer, messages) {
  if (!messages?.length) return;
  await withLock(peer, async () => {
    const known = new Set((S.messages.get(peer) || []).map((r) => r.id).filter(Boolean));
    const state = await S.vault.loadSession(peer);
    if (!state) return; // nothing to decrypt with yet
    let added = 0;
    for (const msg of messages) {
      if (known.has(msg.id)) continue;
      if (msg.from === S.me.username.toLowerCase()) continue;
      try {
        const payload = await C.decryptMessage(state, msg.env);
        if (typeof payload.gid === 'string') continue; // group copies are ingested separately
        const rec = {
          id: msg.id, peer, dir: 'in', from: peer, ts: msg.ts, seq: msg.seq,
          kind: payload.kind || 'text', payload, status: 'delivered',
        };
        S.messages.get(peer).push(rec);
        added++;
      } catch {
        // Older envelopes we can no longer open (ratchet has advanced). Skip quietly.
      }
    }
    if (added) {
      await S.vault.saveSession(peer, state);
      await S.vault.saveMessages(peer, capList(S.messages.get(peer)));
      if (S.activePeer === peer) renderConversation({ scroll: false });
    }
  });
}

function showEmpty() {
  S.activePeer = null;
  $('#pane').hidden = true;
  $('#empty-state').hidden = false;
  $('#messages').innerHTML = '';
  renderChatList();
}

/* ================================================================ composer */

const input = $('#composer-input');

function syncComposerState() {
  const hasText = input.value.trim().length > 0;
  $('#btn-send').disabled = !hasText;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

input.addEventListener('input', () => {
  syncComposerState();
  sendTyping(true);
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
});

function sendTyping(on) {
  if (!S.activePeer || isGroup(S.activePeer)) return;
  const now = Date.now();
  if (on && now - S.typingSent < 1800) {
    scheduleTypingStop();
    return;
  }
  if (on) {
    S.typingSent = now;
    S.api.sendWs({ t: 'typing', to: S.activePeer, on: true });
  } else {
    S.api.sendWs({ t: 'typing', to: S.activePeer, on: false });
  }
  scheduleTypingStop();
}

function scheduleTypingStop() {
  clearTimeout(S.typingTimer);
  S.typingTimer = setTimeout(() => {
    if (S.activePeer) S.api.sendWs({ t: 'typing', to: S.activePeer, on: false });
  }, 2600);
}

$('#composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !S.activePeer) return;
  input.value = '';
  syncComposerState();
  sendTyping(false);
  const peer = S.activePeer;
  try {
    await sendPayload(peer, 'text', { text });
  } catch { /* surfaced by sendPayload */ }
});

$('#btn-emoji').addEventListener('click', () => {
  const pop = $('#emoji-pop');
  if (!pop.hidden) { pop.hidden = true; return; }
  pop.innerHTML = '';
  for (const emoji of EMOJI) {
    pop.append(el('button', {
      type: 'button',
      text: emoji,
      onclick: () => {
        const start = input.selectionStart || input.value.length;
        input.value = input.value.slice(0, start) + emoji + input.value.slice(input.selectionEnd || start);
        input.focus();
        input.selectionStart = input.selectionEnd = start + emoji.length;
        syncComposerState();
      },
    }));
  }
  pop.hidden = false;
});

document.addEventListener('click', (event) => {
  const pop = $('#emoji-pop');
  if (!pop.hidden && !pop.contains(event.target) && !event.target.closest('#btn-emoji')) pop.hidden = true;
});

/* ------------------------------------------------------------- attachments */

const filePicker = el('input', { type: 'file', style: { display: 'none' } });
document.body.append(filePicker);

$('#btn-attach').addEventListener('click', () => filePicker.click());
$('#btn-empty-add').addEventListener('click', openAddContact);
$('#btn-new-chat').addEventListener('click', openAddContact);
$('#btn-new-group').addEventListener('click', openCreateGroup);

// New group: name it, tick the goats (any connected contacts), invite them.
// The relay stores plain membership; every message is still sealed per member.
function openCreateGroup() {
  // Groups are regular chats, so guests may have them too — only screens,
  // camera and files stay account-only.
  const nameInput = el('input', {
    placeholder: 'The stable', maxlength: '60', spellcheck: 'true',
    'aria-label': 'Group name',
  });
  const accepted = [...S.contacts.values()].filter((c) => c.state === 'accepted');
  if (!accepted.length) {
    openModal(modalShell('Start a group', null, el('p', { class: 'sub', text: 'Connect with at least one goat first — group chats seal every note to each member separately.' })));
    return;
  }
  const picked = new Set();
  const list = el('div', { class: 'picker-list group-pick' });
  let pickedNote = el('p', { class: 'auth-hint', text: 'Pick the goats to invite.' });
  const refreshNote = () => { pickedNote.textContent = picked.size ? `${picked.size} goat${picked.size > 1 ? 's' : ''} picked.` : 'Pick the goats to invite.'; };
  for (const c of accepted) {
    const uname = c.username.toLowerCase();
    const row = el('button', { class: 'picker-row row-btn', type: 'button' });
    const avatar = el('div', { class: 'avatar' });
    D.paintAvatar(avatar, { name: c.displayName || uname, accent: c.accent, avatar: c.avatar });
    const nameEl = el('div', { class: 'chat-name' });
    nameEl.append(c.displayName || uname);
    const badge = verifiedBadge(uname);
    if (badge) nameEl.append(badge);
    const check = el('span', { class: 'chip pick-state', text: '+' });
    row.append(avatar, nameEl, check);
    row.addEventListener('click', () => {
      if (picked.has(uname)) picked.delete(uname);
      else picked.add(uname);
      row.classList.toggle('is-picked', picked.has(uname));
      check.textContent = picked.has(uname) ? '✓' : '+';
      refreshNote();
      createBtn.disabled = !nameInput.value.trim() || picked.size < 1;
    });
    list.append(row);
  }
  const err = el('p', { class: 'auth-error', hidden: true });
  const createBtn = el('button', { class: 'primary small', type: 'button', text: 'Create group', disabled: true });
  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    busy(createBtn, 'Creating…');
    err.hidden = true;
    try {
      const { group } = await S.api.createGroup(nameInput.value.trim(), [...picked]);
      closeModal();
      await openChat(`group:${group.id}`);
    } catch (createErr) {
      err.textContent = createErr.message || 'The relay could not create the group.';
      err.hidden = false;
      unbusy(createBtn);
      createBtn.disabled = false;
    }
  });
  nameInput.addEventListener('input', () => { createBtn.disabled = !nameInput.value.trim() || !picked.size; });
  const body = el('div', {},
    el('label', { class: 'field' }, el('span', { text: 'Group name' }), nameInput),
    list, pickedNote, err,
    el('div', { class: 'modal-actions' },
      el('button', { class: 'ghost', type: 'button', text: 'Cancel', onclick: closeModal }),
      createBtn));
  openModal(modalShell('Start a group', 'Messages go to every member, sealed to each goat separately — the relay never sees plaintext.', body));
  setTimeout(() => nameInput.focus(), 60);
}

filePicker.addEventListener('change', async () => {
  const file = filePicker.files?.[0];
  filePicker.value = '';
  if (file) await sendFile(file);
});

/* paste + drag & drop -------------------------------------------------------- */

input.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  for (const file of files) sendFile(file);
});

const dropZone = el('div', { class: 'dropzone', hidden: true },
  el('div', { class: 'dropzone-card' },
    el('div', { class: 'dropzone-icon' }, icon('clip')),
    el('div', { class: 'dropzone-text' },
      el('b', { id: 'drop-title', text: 'Drop to send' }),
      el('span', { id: 'drop-sub', text: '' }))));
document.body.append(dropZone);

let dragDepth = 0;
const canDropFiles = () => Boolean(S.activePeer) && !$('#shell').hidden && $('#modal-layer').hidden;

window.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  if (!canDropFiles()) return;
  if (dragDepth++ === 0) {
    $('#drop-sub').textContent = `Files go encrypted to ${displayName(S.activePeer)}`;
    dropZone.hidden = false;
  }
});
window.addEventListener('dragleave', () => {
  if (!dragDepth) return;
  if (--dragDepth === 0) dropZone.hidden = true;
});
window.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  dragDepth = 0;
  dropZone.hidden = true;
  const peer = S.activePeer;
  if (!peer) return;
  for (const file of event.dataTransfer.files) sendFile(file);
});

async function sendFile(file) {
  if (!requireLogin()) return;
  if (!S.activePeer) return;
  const peer = S.activePeer;
  if (file.size > 40 * 1024 * 1024) {
    toast('Files up to 40 MB, please.', 'err');
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const enc = await C.encryptBytes(bytes);
    const up = await S.api.upload(enc.data, file.name, file.type || 'application/octet-stream');
    const kind = (file.type || '').startsWith('image/') ? 'image' : 'file';
    const payload = {
      fileId: up.id,
      key: enc.keyB64,
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
    };
    if (kind !== 'image') payload.mime = file.type || 'application/octet-stream';
    await sendPayload(peer, kind, payload);
  } catch (err) {
    toast(err.message || 'Could not send that file.', 'err');
  }
}

async function downloadAttachment(rec) {
  try {
    const bytes = await S.api.download(rec.payload.fileId);
    const plain = await C.decryptBytes(rec.payload.key, bytes);
    if (window.goat?.saveFile) {
      const res = await window.goat.saveFile(rec.payload.name || 'file', plain.buffer);
      if (!res.canceled) toast('Saved to disk.');
    } else {
      const url = URL.createObjectURL(new Blob([plain]));
      const a = el('a', { href: url, download: rec.payload.name || 'file' });
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    toast(err.message || 'Download failed.', 'err');
  }
}

function openLightbox(url, rec) {
  const box = el('div', { class: 'lightbox' },
    el('button', { class: 'icon-btn close', onclick: () => box.remove() }, icon('x')),
    el('img', { src: url, alt: '' }),
    el('button', {
      class: 'primary save',
      text: 'Save image',
      onclick: () => downloadAttachment(rec),
    }));
  box.addEventListener('click', (event) => { if (event.target === box) box.remove(); });
  document.body.append(box);
}

/* -------------------------------------------------------------- voice notes */

$('#btn-voice').addEventListener('click', async () => {
  if (S.recorder) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    const startedAt = Date.now();
    rec.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
    };
    rec.start(200);

    // Speech-to-text runs while you record, entirely on this device — the
    // built-in recognizer never sends audio to the relay, and the finished
    // transcript travels inside the encrypted payload like everything else.
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let hear = null;
    S.transcriptDraft = '';
    if (SR) {
      hear = new SR();
      hear.continuous = true;
      hear.interimResults = true;
      hear.lang = navigator.language || 'en-US';
      // A recognizer that errors and then ends would restart forever. Restart
      // only on a clean end (tab switch), and give up after a few tries.
      let restarts = 0;
      let broken = false;
      const sayLive = (text) => {
        const liveEl = $('#rec-live');
        if (liveEl) liveEl.textContent = text;
      };
      hear.onerror = (event) => {
        const code = event?.error;
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          broken = true;
          sayLive('Speech-to-text is blocked — the note still records.');
        } else if (code === 'network') {
          broken = true;
          sayLive('Speech-to-text needs its online engine — the note still records.');
        }
      };
      hear.onend = () => {
        if (broken || restarts >= 8 || S.recorder?.hear !== hear) return;
        restarts += 1;
        setTimeout(() => {
          if (broken || S.recorder?.hear !== hear) return;
          try { hear.start(); } catch { broken = true; }
        }, 400);
      };
      hear.onresult = (event) => {
        let finalText = '';
        let live = '';
        for (let i = 0; i < event.results.length; i++) {
          const line = event.results[i][0].transcript;
          if (event.results[i].isFinal) finalText += line;
          else live += line;
        }
        S.transcriptDraft = `${finalText} ${live}`.replace(/\s+/g, ' ').trim().slice(0, 4000);
        const liveEl = $('#rec-live');
        if (liveEl) liveEl.textContent = S.transcriptDraft || 'Listening…';
      };
      try { hear.start(); } catch { hear = null; }
    }

    S.recorder = { rec, chunks, startedAt, stream, hear };
    const liveEl = $('#rec-live');
    liveEl.hidden = false;
    liveEl.textContent = SR ? 'Listening…' : 'Speech-to-text is not available in this browser.';
    $('#record-bar').hidden = false;
    $('#rec-time').textContent = '0:00';
    clearInterval(S.recordingTimer);
    S.recordingTimer = setInterval(() => {
      if (!S.recorder) return;
      $('#rec-time').textContent = D.duration((Date.now() - S.recorder.startedAt) / 1000);
    }, 250);
  } catch {
    toast('Microphone unavailable. Check macOS privacy settings.', 'err');
  }
});

function stopRecording() {
  const active = S.recorder;
  if (!active) return null;
  clearInterval(S.recordingTimer);
  S.recorder = null;
  $('#record-bar').hidden = true;
  $('#rec-live').hidden = true;
  return new Promise((resolve) => {
    active.rec.onstop = () => {
      active.stream.getTracks().forEach((track) => track.stop());
      resolve({ blob: new Blob(active.chunks, { type: active.rec.mimeType || 'audio/webm' }), duration: (Date.now() - active.startedAt) / 1000 });
    };
    if (active.hear) { try { active.hear.onend = null; active.hear.stop(); } catch {} }
    try { active.rec.stop(); } catch { resolve(null); }
  });
}

$('#rec-cancel').addEventListener('click', async () => {
  const active = S.recorder;
  if (!active) return;
  active.rec.onstop = () => active.stream.getTracks().forEach((track) => track.stop());
  stopRecording();
  S.transcriptDraft = '';
  toast('Voice note discarded.');
});

$('#rec-send').addEventListener('click', async () => {
  const peer = S.activePeer;
  const transcript = (S.transcriptDraft || '').trim().slice(0, 4000);
  const result = await stopRecording();
  S.transcriptDraft = '';
  if (!result || !result.blob.size || !peer) return;
  try {
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const enc = await C.encryptBytes(bytes);
    const up = await S.api.upload(enc.data, 'voice-note.webm', 'audio/webm');
    await sendPayload(peer, 'voice', {
      fileId: up.id,
      key: enc.keyB64,
      mime: 'audio/webm',
      duration: Math.max(1, Math.round(result.duration)),
      size: result.blob.size,
      ...(transcript ? { text: transcript } : {}),
    });
  } catch (err) {
    toast(err.message || 'Could not send voice note.', 'err');
  }
});

/* ================================================================== contacts */

function openAddContact() {
  const input = el('input', { placeholder: 'goatname', spellcheck: 'false', autocapitalize: 'none' });
  const results = el('div', { class: 'picker-list' });
  const status = el('p', { class: 'auth-hint', text: 'Type a goat name and press Enter.' });

  const search = async () => {
    const name = input.value.trim();
    results.innerHTML = '';
    if (!name) return;
    try {
      const found = await S.api.lookup(name);
      const row = el('div', { class: 'picker-row' });
      const avatar = el('div', { class: 'avatar' });
      D.paintAvatar(avatar, { name: found.user.displayName, accent: found.user.accent, avatar: found.user.avatar });
      const foundName = el('div', { class: 'chat-name' });
      foundName.append(found.user.displayName);
      const foundBadge = verifiedBadge(found.user.username);
      if (foundBadge) foundName.append(foundBadge);
      row.append(avatar, foundName,
        el('span', { class: 'chip', text: found.state === 'accepted' ? 'connected' : found.state === 'in' ? 'wants you' : found.user.presence }));
      row.addEventListener('click', () => {
        if (found.isSelf) return toast('That is you, silly goat.');
        openUserProfile(found);
      });
      results.append(row);
    } catch (err) {
      status.textContent = err.message;
    }
  };

  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); search(); } });

  const body = el('div', {},
    el('label', { class: 'field' }, el('span', { text: 'Find a goat' }), input),
    status, results);

  const modal = modalShell('Grow the herd', 'Invite someone by their goat name. They must accept before you can talk.', body);
  openModal(modal);
  setTimeout(() => input.focus(), 60);
}

/* ------------------------------------------------------------------ settings */

/* ------------------------------------------------------------ profile cards -- */

function joinedLabel(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString([], { month: 'long', year: 'numeric' });
}

// The card shown for yourself (live preview in Settings → Profile) and when
// someone clicks a chat header — shared so the two always look the same.
function profileCard(user) {
  const hue = 22 + (Math.abs(Number(user.accent) || 0) % 17);
  const banner = el('div', { class: 'pc-banner' });
  banner.style.setProperty('--h', hue);
  if (user.banner) banner.style.backgroundImage = `url("${user.banner}")`;
  const avatar = el('div', { class: 'avatar big pc-avatar' });
  D.paintAvatar(avatar, { name: user.displayName || user.username, accent: user.accent, avatar: user.avatar });
  return el('div', { class: 'profile-card' },
    banner,
    el('div', { class: 'pc-main' },
      avatar,        el('div', { class: 'pc-id' },
        (() => {
          const nameRow = el('div', { class: 'pc-name' });
          nameRow.append(user.displayName || user.username);
          const badge = verifiedBadge(user.username);
          if (badge) nameRow.append(badge);
          return nameRow;
        })(),
        el('div', { class: 'pc-handle', text: `@${user.username || ''}` })),
      user.about ? el('p', { class: 'pc-about', text: user.about }) : null,
      el('div', { class: 'pc-chips' },
        user.presence ? el('span', { class: `presence-chip${user.presence === 'online' ? ' on' : ''}` }, el('i', { class: 'dot' }), el('span', { text: user.presence })) : null,
        joinedLabel(user.createdAt) ? el('span', { class: 'chip', text: `in the herd since ${joinedLabel(user.createdAt)}` }) : null)));
}

// Clicking the peer's name/avatar in a chat header opens their card.
function openPeerProfile(peer) {
  const key = String(peer).toLowerCase();
  if (isGroup(key)) return openGroupInfo();
  const rec = S.contacts.get(key);
  if (!rec) return;
  const card = profileCard({ ...rec, presence: isOnline(key) ? 'online' : 'offline' });
  const modal = el('div', { class: 'modal profile-modal' },
    card,
    rec.state === 'accepted' ? el('span', { class: 'chip', text: 'connected · end-to-end encrypted' }) : null);
  openModal(modal);
}

// From the add-contact flow: tapping a found goat shows their profile card,
// with the action that matches the current contact state (chat / accept / send).
function openUserProfile(found) {
  const user = found.user || {};
  const key = String(user.username || '').toLowerCase();
  const card = profileCard(user);
  let action;
  if (found.state === 'accepted') {
    action = el('button', { class: 'primary small', type: 'button', text: 'Open chat', onclick: async () => {
      closeModal();
      try { await openChat(key); } catch (err) { toast(err.message, 'err'); }
    } });
  } else if (found.state === 'in') {
    action = el('button', { class: 'primary small', type: 'button', text: 'Accept request', onclick: async () => {
      closeModal();
      await acceptRequest(key);
    } });
  } else if (found.state === 'out') {
    action = el('span', { class: 'chip', text: 'request sent · waiting' });
  } else {
    action = el('button', { class: 'primary small', type: 'button', text: 'Send contact request', onclick: async () => {
      try {
        applyBootstrap(await S.api.addContact(key));
        toast(`Request sent to ${user.displayName || key}.`);
        closeModal();
      } catch (err) { toast(err.message, 'err'); }
    } });
  }
  openModal(modalShell(user.displayName ? `@${user.username}` : 'Profile', null, card, [action]));
}

// Center-crop an image file to a fixed square/rect Data URL (JPEG).
function readImageThumb(file, { w, h, quality = 0.85 }) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const aspect = w / h;
      let sx = 0; let sy = 0; let sw = img.naturalWidth; let sh = img.naturalHeight;
      if (sw / sh > aspect) { sw = sh * aspect; sx = (img.naturalWidth - sw) / 2; }
      else { sh = sw / aspect; sy = (img.naturalHeight - sh) / 2; }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read.')); };
    img.src = url;
  });
}

function pickImage(kind) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

// Relay + TURN: the two addresses that let two goats in different countries
// reach each other. Messages ride the relay (ciphertext only); calls use TURN.
function netBlock() {
  const net = S.info.net || {};
  const relayInput = el('input', {
    value: net.relayUrl || '',
    placeholder: 'http://203.0.113.10:4040',
    spellcheck: 'false',
  });
  const turnInput = el('input', {
    value: net.turn?.urls || '',
    placeholder: 'turn:203.0.113.10:3478?transport=udp',
    spellcheck: 'false',
  });
  const userInput = el('input', { value: net.turn?.username || '', placeholder: 'goat', spellcheck: 'false' });
  const passInput = el('input', { type: 'password', value: net.turn?.credential || '', placeholder: 'password' });
  const forceBox = el('input', { type: 'checkbox' });
  forceBox.checked = Boolean(net.forceRelay);
  const status = el('div', {
    class: 'net-status',
    text: net.embedded ? 'Using the relay inside this Mac.' : `Using ${net.relayUrl}.`,
  });

  const apply = el('button', {
    class: 'primary small',
    type: 'button',
    text: 'Apply',
    onclick: async () => {
      apply.disabled = true;
      status.textContent = 'Checking the relay…';
      status.className = 'net-status';
      try {
        const res = await window.goat.net.set({
          relayUrl: relayInput.value,
          turn: { urls: turnInput.value, username: userInput.value, credential: passInput.value },
          forceRelay: forceBox.checked,
        });
        if (!res.ok) {
          status.textContent = res.error;
          status.className = 'net-status bad';
          return;
        }
        S.info.net = { ...(S.info.net || {}), ...res.net };
        S.calls?.setNetwork({ turn: res.net.turn, forceRelay: res.net.forceRelay });
        status.textContent = res.restartNeeded
          ? 'Saved. Quit and reopen GoatMessenger to switch relays.'
          : 'Saved. Calls will use these settings now.';
        status.className = 'net-status good';
      } catch (err) {
        status.textContent = err.message;
        status.className = 'net-status bad';
      } finally {
        apply.disabled = false;
      }
    },
  });

  const test = el('button', {
    class: 'ghost',
    type: 'button',
    text: 'Test',
    onclick: async () => {
      status.textContent = 'Testing…';
      status.className = 'net-status';
      const res = await window.goat.net.test(relayInput.value);
      status.textContent = res.ok
        ? `Relay answered in ${res.ms} ms${res.turn ? ' · TURN enabled' : ''}`
        : res.error;
      status.className = `net-status ${res.ok ? 'good' : 'bad'}`;
    },
  });

  return el('div', { class: 'net-block' },
    el('div', { class: 'net-head' },
      icon('users'),
      el('div', {},
        el('div', { text: 'Relay & calls across the world' }),
        el('small', { text: 'Point both goats at the same relay and TURN server' }))),
    el('label', { class: 'field' }, el('span', { text: 'Relay address (blank = this Mac)' }), relayInput),
    el('label', { class: 'field' }, el('span', { text: 'TURN server' }), turnInput),
    el('div', { class: 'field-row' },
      el('label', { class: 'field' }, el('span', { text: 'TURN username' }), userInput),
      el('label', { class: 'field' }, el('span', { text: 'TURN password' }), passInput)),
    el('label', { class: 'check-row' }, forceBox, el('span', { text: 'Force calls through TURN (best across strict networks)' })),
    el('div', { class: 'net-actions' }, status, test, apply),
    el('small', { class: 'net-hint', text: 'Messages and calls stay end-to-end encrypted — the relay only ever forwards ciphertext.' }));
}

const DEV_FLAG = 'gm:devMode';
function devUnlocked() {
  try { return localStorage.getItem(DEV_FLAG) === '1'; } catch { return false; }
}

function themePicker() {
  const modes = [
    ['light', 'Light'],
    ['dark', 'Dark'],
    ['system', 'Match system'],
  ];
  const seg = el('div', { class: 'seg' });
  const paint = () => [...seg.children].forEach((b) => b.classList.toggle('is-on', b.dataset.mode === S.themeMode));
  for (const [mode, label] of modes) {
    seg.append(el('button', {
      type: 'button',
      class: 'seg-btn',
      text: label,
      dataset: { mode },
      onclick: async () => {
        applyTheme(mode);
        try { await S.vault?.setPref('theme', mode); } catch {}
        paint();
      },
    }));
  }
  paint();
  return el('div', { class: 'field' }, el('span', { text: 'Theme' }), seg);
}

// Saves whatever is currently in the settings draft, wherever the user is in
// Settings — the warning bar on top of the modal (and the pane's own Save
// button) both funnel here, so a draft can always be saved and then closed.
async function saveProfileDraft(ctl) {
  if (!S.profileDraft) return;
  if (!requireLogin()) return;
  const draft = S.profileDraft;
  const dirtyBar = ctl?.bar;
  try {
    if (dirtyBar) busy(dirtyBar.querySelector('button'), 'Saving…');
    const res = await S.api.updateProfile({
      displayName: draft.displayName,
      about: draft.about,
      avatar: draft.avatar,
      banner: draft.banner,
    });
    S.me = { ...S.me, ...res.me };
    S.profileDraft = {
      displayName: S.me.displayName || '',
      about: S.me.about || '',
      accent: S.me.accent,
      avatar: S.me.avatar || '',
      banner: S.me.banner || '',
    };
    renderMe();
    renderChatList();
    toast('Profile saved.');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (dirtyBar) unbusy(dirtyBar.querySelector('button'));
    ctl?.update();
  }
}

function profileDirty() {
  const d = S.profileDraft;
  if (!d) return false;
  return d.displayName !== (S.me.displayName || '')
    || (d.about || '').trim() !== (S.me.about || '').trim()
    || d.avatar !== (S.me.avatar || '')
    || d.banner !== (S.me.banner || '');
}

function profilePane(ctl) {
  // The draft survives Settings category switches (and a blocked close) so
  // unsaved edits are never silently dropped; it resets once settings closes.
  const draft = S.profileDraft ??= {
    displayName: S.me.displayName || '',
    about: S.me.about || '',
    accent: S.me.accent,
    avatar: S.me.avatar || '',
    banner: S.me.banner || '',
  };

  // Live preview: exactly the card peers see when they click your profile.
  const previewBox = el('div', { class: 'profile-preview' });
  const renderPreview = () => {
    previewBox.innerHTML = '';
    previewBox.append(profileCard({ ...draft, username: S.me.username, createdAt: S.me.createdAt }));
  };
  renderPreview();

  const avatarBox = el('button', { class: 'pick pick-avatar avatar', type: 'button', title: 'Choose a profile photo' });
  const bannerBox = el('button', { class: 'pick pick-banner', type: 'button', title: 'Choose a banner' });
  const paintPickers = () => {
    D.paintAvatar(avatarBox, { name: draft.displayName || S.me.username, accent: draft.accent, avatar: draft.avatar });
    avatarBox.classList.toggle('has-img', Boolean(draft.avatar));
    bannerBox.style.setProperty('--h', 22 + (Math.abs(Number(draft.accent) || 0) % 17));
    if (draft.banner) bannerBox.style.backgroundImage = `url("${draft.banner}")`;
    else bannerBox.style.backgroundImage = '';
    bannerBox.classList.toggle('has-img', Boolean(draft.banner));
  };
  paintPickers();

  const setAvatar = async () => {
    const file = await pickImage();
    if (!file) return;
    try {
      draft.avatar = await readImageThumb(file, { w: 256, h: 256, quality: 0.86 });
      paintPickers();
      renderPreview();
      ctl?.update();
    } catch (err) { toast(err.message, 'err'); }
  };
  const setBanner = async () => {
    const file = await pickImage();
    if (!file) return;
    try {
      draft.banner = await readImageThumb(file, { w: 960, h: 320, quality: 0.82 });
      paintPickers();
      renderPreview();
      ctl?.update();
    } catch (err) { toast(err.message, 'err'); }
  };
  avatarBox.addEventListener('click', () => { if (requireLogin()) setAvatar(); });
  bannerBox.addEventListener('click', () => { if (requireLogin()) setBanner(); });
  const removeAvatar = el('button', { class: 'mini quiet pick-clear', type: 'button', text: 'Remove', onclick: () => { if (!requireLogin() || !draft.avatar) return; draft.avatar = ''; paintPickers(); renderPreview(); ctl?.update(); } });
  const removeBanner = el('button', { class: 'mini quiet pick-clear', type: 'button', text: 'Remove', onclick: () => { if (!requireLogin() || !draft.banner) return; draft.banner = ''; paintPickers(); renderPreview(); ctl?.update(); } });

  const nameInput = el('input', { value: draft.displayName, maxlength: '40', placeholder: S.me.username });
  const aboutInput = el('input', { value: draft.about, placeholder: 'a goat of few words', maxlength: '120' });
  const guestLock = S.isGuest
    ? el('small', { class: 'net-hint', text: 'Guests keep a basic profile. Log in or create an account to edit photos, banner or name.' })
    : null;
  if (S.isGuest) { nameInput.disabled = true; aboutInput.disabled = true; }
  nameInput.addEventListener('input', () => { draft.displayName = nameInput.value.trim() || S.me.username; renderPreview(); ctl?.update(); });
  aboutInput.addEventListener('input', () => { draft.about = aboutInput.value.trim(); renderPreview(); ctl?.update(); });

  return el('div', {},
    el('small', { class: 'net-hint', text: 'This is the profile card other goats see — live preview:' }),
    previewBox,
    guestLock,
    el('div', { class: 'pick-row' },
      el('div', { class: 'field pick-field' }, el('span', { text: 'Profile photo' }), avatarBox, removeAvatar),
      el('div', { class: 'field pick-field' }, el('span', { text: 'Banner' }), bannerBox, removeBanner)),
    el('label', { class: 'field' }, el('span', { text: 'Display name' }), nameInput),
    el('label', { class: 'field' }, el('span', { text: 'About' }), aboutInput),
    el('div', { class: 'net-actions', style: { justifyContent: 'flex-end', margin: '0 0 14px' } },
      el('span', { class: 'net-status', text: 'Only you can read your conversations — no one at the relay can.' }),
      el('button', {
        class: 'primary small',
        text: 'Save profile',
        onclick: () => saveProfileDraft(ctl),
      })),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'Relay' }), el('small', { text: S.api.url || 'not connected' })),
      el('span', { class: 'chip', text: 'ciphertext only' })),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'Stay signed in' }), el('small', { text: 'Your token and keys unlock automatically in the OS keychain' })),
      el('span', { class: 'chip', text: 'on' })),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'Sign out' }), el('small', { text: 'Also forget the saved login on this device' })),
      el('button', { class: 'ghost', text: 'Sign out', onclick: signOut })),
    el('div', { class: 'row-item danger-item' },
      el('div', { class: 'grow' }, el('div', { text: 'Delete account & data' }), el('small', { text: 'Erases this account on the relay, its stored ciphertext and your local history — for good' })),
      el('button', { class: 'ghost danger-btn', text: 'Delete…', onclick: openDeleteAccount })));
}

function appearancePane() {
  return el('div', {},
    themePicker(),
    el('small', { class: 'net-hint', text: '“Match system” follows macOS or Windows appearance, and switches instantly when your system changes.' }));
}

/* ---------------------------------------------------------------- storage -- */

function clearAttachmentCache() {
  for (const url of S.mediaCache.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  S.mediaCache.clear();
}

// Drop every chat back to MAX_HISTORY notes and reload the open one, so the
// in-memory copies cannot immediately grow the store again on the next save.
async function trimLocalHistory() {
  const removed = await S.vault.trimHistory();
  const active = S.activePeer;
  S.messages.clear();
  if (active) {
    S.messages.set(active, await S.vault.loadMessages(active));
    renderConversation({ scroll: false });
  }
  renderChatList();
  return removed;
}

function storagePane() {
  const stat = (value, label) => el('div', { class: 'storage-stat' }, el('b', { text: value }), el('span', { text: label }));
  const fmt = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const stats = el('div', { class: 'storage-stats' }, el('small', { class: 'net-hint', text: 'Counting…' }));

  const refresh = async () => {
    stats.innerHTML = '';
    try {
      const { chats, notes, bytes } = await S.vault.historyStats();
      stats.append(
        stat(String(notes), notes === 1 ? 'note' : 'notes'),
        stat(String(chats), chats === 1 ? 'chat' : 'chats'),
        stat(fmt(bytes), 'on this device'),
        stat(String(S.mediaCache.size), 'previews in memory'),
      );
    } catch {
      stats.append(el('small', { class: 'net-hint', text: 'Local storage is not readable in this window.' }));
      return;
    }
  };
  void refresh();

  const trimBtn = el('button', {
    class: 'ghost', type: 'button', text: 'Trim',
    onclick: async () => {
      busy(trimBtn, 'Trimming…');
      try {
        const removed = await trimLocalHistory();
        toast(removed ? `Trimmed ${removed} old note${removed === 1 ? '' : 's'}.` : `Nothing to trim — every chat is under ${MAX_HISTORY}.`);
      } catch (err) {
        toast(err.message || 'Could not trim history.', 'err');
      } finally {
        unbusy(trimBtn);
        await refresh();
      }
    },
  });

  const cacheBtn = el('button', {
    class: 'ghost', type: 'button', text: 'Clear',
    onclick: () => {
      const had = S.mediaCache.size;
      clearAttachmentCache();
      refresh();
      toast(had ? `Freed ${had} decrypted preview${had === 1 ? '' : 's'} from memory.` : 'No previews were cached.');
    },
  });

  return el('div', {},
    el('small', { class: 'net-hint', text: 'Everything below lives on this device only — never on the relay.' }),
    stats,
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' },
        el('div', { text: 'History limit' }),
        el('small', { text: `Each chat keeps its newest ${MAX_HISTORY} notes; older ones are dropped from local storage as new ones arrive.` })),
      el('span', { class: 'chip', text: `${MAX_HISTORY} per chat` })),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' },
        el('div', { text: 'Trim old notes now' }),
        el('small', { text: 'Applies the limit straight away to every chat on this device. Trimmed notes stay on the relay and can be pulled back.' })),
      trimBtn),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' },
        el('div', { text: 'Attachment previews' }),
        el('small', { text: 'Decrypted images and voice notes held in memory so they reopen instantly. Files themselves stay E2E on the relay.' })),
      cacheBtn),
    el('small', { class: 'net-hint', text: 'Want everything gone? Security → “Clear local history” wipes notes and ratchets for good.' }));
}

function networkPane() {
  return el('div', {}, netBlock(),
    el('small', { class: 'net-hint', text: 'Keep both goats pointed at the same relay so messages flow between them.' }));
}

function privacyPane() {
  const fingerprint = C.fingerprintKey(S.identity.ikPub).match(/.{1,4}/g).join(' ');
  return el('div', {},
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'This device’s identity key' }),
        el('small', { text: 'X25519 · Ed25519' }), el('div', { class: 'kv', text: fingerprint }))),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'Per-chat safety numbers' }), el('small', { text: 'Compare them with your friend out loud — it is in each chat’s shield menu' })),
      el('span', { class: 'chip', text: 'always on' })),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'Clear local history' }), el('small', { text: 'Removes decrypted messages and ratchets on this device' })),
      el('button', {
        class: 'ghost',
        text: 'Clear',
        onclick: async () => {
          const peer = S.activePeer;
          await S.vault.wipeHistory();
          S.messages.clear();
          if (peer) await openChat(peer);
          else renderChatList();
          toast('Local history cleared.');
        },
      })));
}

function aboutPane() {
  let pokes = 0;
  let pokeTimer = null;
  const versionBtn = el('button', {
    class: 'row-item row-btn',
    type: 'button',
    title: 'Version',
    onclick: () => {
      pokes += 1;
      clearTimeout(pokeTimer);
      pokeTimer = setTimeout(() => { pokes = 0; }, 2200);
      if (pokes >= 5) {
        pokes = 0;
        try { localStorage.setItem(DEV_FLAG, '1'); } catch {}
        toast('Developer mode unlocked 🐐');
        openSettings('dev');
      } else if (pokes >= 3) {
        toast(`${5 - pokes} more taps for developer mode…`);
      }
    },
  },
  el('div', { class: 'grow' }, el('div', { text: 'GoatMessenger' }), el('small', { text: 'An end-to-end encrypted messenger for goats' })),
  el('span', { class: 'chip', text: `version ${S.info.version}` }));

  return el('div', {},
    versionBtn,
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'Encryption' }), el('small', { text: 'X3DH + Double Ratchet, X25519 + AES-256-GCM' })),
      el('span', { class: 'chip', text: 'end-to-end' })),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'Calls' }), el('small', { text: 'Peer-to-peer DTLS-SRTP media between the two apps' })),
      el('span', { class: 'chip', text: 'direct' })));
}

// Settings → Notifications. Sound always lives here; OS notifications use
// Electron's Notification on desktop and the web Notification API in a tab.
function notifyPane() {
  const row = (label, small, control) => el('div', { class: 'row-item' },
    el('div', { class: 'grow' }, el('div', { text: label }), el('small', { text: small })), control);
  const toggle = (key, label, onFlip) => {
    const btn = el('button', { class: 'ghost', type: 'button', text: S.notify[key] ? 'On' : 'Off' });
    btn.onclick = async () => {
      S.notify[key] = !S.notify[key];
      btn.textContent = S.notify[key] ? 'On' : 'Off';
      try { await S.vault?.setPref(key === 'sound' ? 'notifySound' : 'notifyDesktop', S.notify[key]); } catch {}
      if (onFlip) onFlip();
    };
    return btn;
  };

  const webStatus = el('span', { class: 'chip', text: '' });
  const refreshWeb = async () => {
    if (!('Notification' in window)) { webStatus.textContent = 'not supported'; return; }
    webStatus.textContent = Notification.permission === 'granted' ? 'granted'
      : Notification.permission === 'denied' ? 'blocked in the browser' : 'not granted';
  };
  const webAsk = el('button', {
    class: 'ghost', type: 'button', text: 'Enable',
    onclick: async () => {
      if ('Notification' in window) {
        try { await Notification.requestPermission(); } catch {}
        refreshWeb();
      }
    },
  });
  const isWeb = window.goat?.platform === 'web';
  void refreshWeb();

  return el('div', {},
    row('Message sound', 'A clear chime for any message that lands while you are elsewhere (in-app or in another tab).', toggle('sound', 'Message sound')),
    row('Desktop notifications', 'Shows the sender, the group (if any) and a preview; clicking it opens that chat.', toggle('desktop', 'Desktop notifications')),
    isWeb
      ? el('div', { class: 'row-item' },
        el('div', { class: 'grow' }, el('div', { text: 'Browser permission' }),
          el('small', { text: 'In a browser tab, notifications are gated by the browser itself.' })),
        el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, webStatus, webAsk))
      : null,
    el('small', { class: 'net-hint', text: 'Nothing is sent when a notification shows — previews come from messages already decrypted on this device.' }));
}

function devPane() {
  const net = S.info.net || {};
  const reveal = (label, target) => el('div', { class: 'row-item' },
    el('div', { class: 'grow' }, el('div', { text: label }), el('small', { text: target || '—' })),
    el('button', { class: 'ghost', text: 'Reveal', onclick: () => window.goat?.revealPath?.(target) }));
  return el('div', {},
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'Relay in use' }), el('small', { text: S.api.url || '—' })),
      el('span', { class: 'chip', text: net.embedded ? 'embedded' : 'external' })),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'Relay address (configured)' }), el('small', { text: net.relayUrl || '(none — local relay)' })),
      el('span', { class: 'chip', text: 'settings' })),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'TURN' }),
        el('small', { text: net.turn?.urls || 'none — calls go peer-to-peer' })),
      el('span', { class: 'chip', text: net.turnPort ? `port ${net.turnPort}` : 'no turn' })),
    reveal('Data directory', S.info.userData),
    reveal('Boot log', `${S.info.userData}/boot.log`),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'Second window' }), el('small', { text: 'Sign in as another goat to test calls and shares' })),
      el('button', { class: 'ghost', text: 'Open', onclick: () => window.goat?.newWindow?.() })),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, el('div', { text: 'Test flags' })),
      el('div', { class: 'dev-chips', style: { display: 'flex', gap: '6px' } },
        el('span', { class: 'chip tiny', text: S.info.e2e ? 'e2e' : 'no e2e' }),
        el('span', { class: 'chip tiny', text: S.info.fakeMedia ? 'fake media' : 'real media' }))),
    el('small', { class: 'net-hint', text: 'Developer tools for poking at relays, TURN and diagnostics. Unlock: About → tap the version 5 times.' }));
}

function openSettings(category = S.settingsCat || 'profile') {
  const panes = {
    profile: profilePane,
    appearance: appearancePane,
    storage: storagePane,
    network: networkPane,
    notify: notifyPane,
    privacy: privacyPane,
    about: aboutPane,
    ...(devUnlocked() ? { dev: devPane } : {}),
  };
  if (!panes[category]) category = 'profile';
  S.settingsCat = category;

  // Unsaved-edits warning bar: shown while the profile draft differs from the
  // saved profile, with a Save that unblocks closing.
  const dirtyBar = el('div', { class: 'settings-dirty-bar', hidden: true },
    el('span', { class: 'dirty-text', text: 'You have unsaved changes' }),
    el('button', { class: 'primary small', text: 'Save', onclick: () => ctl.save() }));
  let ctl = {
    bar: dirtyBar,
    update: () => { dirtyBar.hidden = !profileDirty(); },
    flash: () => {
      dirtyBar.hidden = false;
      dirtyBar.classList.remove('shake');
      void dirtyBar.offsetWidth;
      dirtyBar.classList.add('shake');
    },
    save: () => saveProfileDraft(ctl),
  };

  const labels = {
    profile: ['Profile', 'users'],
    appearance: ['Appearance', 'smile'],
    storage: ['Storage', 'download'],
    network: ['Network', 'screen'],
    notify: ['Notifications', 'bell'],
    privacy: ['Security', 'lock'],
    about: ['About', 'shield'],
    dev: ['Developer', 'clip'],
  };
  const side = el('div', { class: 'settings-side' });
  for (const id of Object.keys(panes)) {
    const [label, ic] = labels[id] || [id, 'gear'];
    side.append(el('button', {
      class: `settings-cat${id === category ? ' is-on' : ''}`,
      type: 'button',
      onclick: () => openSettings(id),
    }, icon(ic), el('span', { text: label })));
  }

  const content = el('div', { class: 'settings-body' }, panes[category](ctl));
  const modal = el('div', { class: 'modal settings-modal' },
    el('h3', { text: 'Settings' }),
    el('p', { class: 'sub', text: `@${S.me.username}` }),
    el('div', { class: 'settings-grid' }, side, content),
    dirtyBar);
  openModal(modal);
  ctl.update();
  S.settingsGuard = {
    isDirty: () => profileDirty(),
    refuse: () => ctl.flash(),
  };
}

async function signOut() {
  closeModal(true); // signing out is explicit: a dirty settings draft does not block it
  try { await window.goat?.session?.clear?.(); } catch {}
  try { await S.api.logout(); } catch {}
  S.api.close();
  S.calls?.reset();
  if (S.calls) S.calls.identity = null;
  S.identity = null;
  S.me = null;
  S.activePeer = null;
  S.contacts.clear();
  S.messages.clear();
  S.bundles.clear();
  S.unread.clear();
  $('#shell').hidden = true;
  $('#auth').hidden = false;
  $('#auth-pass').value = '';
  setAuthMode('signin');
  const user = localStorage.getItem('gm:lastUser') || '';
  $('#auth-username').value = user;
}

// Settings → Profile → Delete: wipes the relay account AND local data, then
// returns to the sign-in screen. Deliberate two-step confirm (type the name).
function openDeleteAccount() {
  if (S.isGuest) { toast('A guest session only lives on this device — signing out erases it.', 'err'); return; }
  const name = S.me.username;
  const confirmInput = el('input', {
    spellcheck: 'false', autocapitalize: 'none', autocomplete: 'off',
    'aria-label': 'Type your goat name to confirm deletion',
  });
  const err = el('p', { class: 'auth-error', hidden: true });
  const delBtn = el('button', {
    class: 'primary small danger-btn', type: 'button', text: 'Delete my account forever', disabled: true,
    onclick: async () => {
      delBtn.disabled = true;
      busy(delBtn, 'Deleting…');
      err.hidden = true;
      try {
        await S.api.deleteAccount(name);
        try { await window.goat?.session?.clear?.(); } catch {}
        try { await S.vault?.wipeAll?.(); } catch {}
        try { localStorage.removeItem('gm:lastUser'); } catch {}
        S.api.close();
        S.calls?.reset();
        if (S.calls) S.calls.identity = null;
        S.identity = null;
        S.me = null;
        S.activePeer = null;
        S.contacts.clear();
        S.messages.clear();
        S.bundles.clear();
        S.unread.clear();
        S.presence.clear();
        S.verified.clear();
        closeModal();
        $('#shell').hidden = true;
        $('#auth').hidden = false;
        $('#auth-pass').value = '';
        $('#auth-username').value = '';
        setAuthMode('signin');
        toast('Your account and everything on the relay for it is gone.');
      } catch (deleteErr) {
        err.textContent = deleteErr.message || 'The relay could not delete the account. It may be offline — try again when it is back.';
        err.hidden = false;
        unbusy(delBtn);
        delBtn.disabled = confirmInput.value.trim().toLowerCase() !== name.toLowerCase();
      }
    },
  });
  confirmInput.addEventListener('input', () => {
    delBtn.disabled = confirmInput.value.trim().toLowerCase() !== name.toLowerCase();
  });
  const body = el('div', {},
    el('p', { class: 'sub', text: 'This permanently erases:' }),
    el('ul', { class: 'delete-list' },
      el('li', { text: 'your account, profile, photos and key backup on the relay' }),
      el('li', { text: 'the queued ciphertext the relay holds for your conversations' }),
      el('li', { text: 'uploaded attachments stored on the relay' }),
      el('li', { text: 'decrypted history, keys and preferences on this device' })),
    el('p', { class: 'sub', text: 'Your friends keep their chats; your messages simply disappear for them. There is no undo.' }),
    el('label', { class: 'field' }, el('span', { text: `Type “${name}” to confirm` }), confirmInput),
    err);
  openModal(modalShell('Delete this goat?', null, body, [
    el('button', { class: 'ghost', type: 'button', text: 'Cancel', onclick: closeModal }),
    delBtn,
  ]));
  setTimeout(() => confirmInput.focus(), 60);
}

/* ------------------------------------------------------------------ verify */

async function openVerify() {
  const peer = S.activePeer;
  if (!peer) return;
  let bundle;
  try { bundle = await peerBundle(peer); } catch (err) { return toast(err.message, 'err'); }
  const number = C.safetyNumber(C.publicBundle(S.identity), bundle);
  const verifiedAt = S.verified.get(peer);
  const state = el('div', { class: `verify-state${verifiedAt ? '' : ' unverified'}` },
    icon(verifiedAt ? 'shield' : 'lock'),
    el('span', { text: verifiedAt ? `Verified on ${new Date(verifiedAt).toLocaleDateString()}` : 'Not verified yet' }));

  const actions = [];
  if (verifiedAt) {
    actions.push(el('button', {
      class: 'ghost',
      text: 'Remove verification',
      onclick: async () => { await S.vault.setVerified(peer, false); S.verified.delete(peer); renderHeader(); closeModal(); },
    }));
  } else {
    actions.push(el('button', {
      class: 'primary small',
      text: 'Mark as verified',
      onclick: async () => {
        await S.vault.setVerified(peer, true);
        S.verified.set(peer, Date.now());
        renderHeader();
        closeModal();
        toast('Safety number marked as verified.');
      },
    }));
  }
  actions.push(el('button', {
    class: 'ghost',
    text: 'Copy number',
    onclick: async () => { await navigator.clipboard.writeText(number); toast('Safety number copied.'); },
  }));

  const body = el('div', {},
    state,
    el('div', { class: 'safety', text: number }),
    el('p', { class: 'sub', text: 'Read this number to each other out loud, or compare a photo of the screen. If both numbers match, no one is in the middle — every message is sealed with X3DH and a Double Ratchet.' }),
    el('div', { class: 'row-item' },
      el('div', { class: 'grow' },
        el('div', { text: 'Their identity key' }),
        el('div', { class: 'kv', text: C.fingerprintKey(C.b64d(bundle.ik)).match(/.{1,4}/g).join(' ') }))));

  openModal(modalShell(`Encryption with ${displayName(peer)}`, 'End-to-end · X25519 + AES-256-GCM', body, actions));
}

/* ==================================================================== calls */

function buildCallManager() {
  S.calls = new CallManager({
    identity: S.identity,
    sound: S.sound,
    signal: (payload) => {
      if (!S.api.sendWs(payload)) toast('Connection lost — call ended.', 'err');
    },
    bundleFor: async (peer) => {
      try { return await peerBundle(peer); } catch { return null; }
    },
    onState: (state) => renderCall(state),
    onIncoming: ({ peer, kind }) => {
      const card = $('#incoming');
      card.dataset.kind = kind === 'video' ? 'video' : 'audio';
      card.hidden = false;
      D.paintAvatar($('#incoming-avatar'), { name: displayName(peer), accent: accentOf(peer), avatar: avatarOf(peer) });
      $('#incoming-name').textContent = displayName(peer);
      $('#incoming-sub').textContent = kind === 'video' ? 'Incoming video call · encrypted' : 'Incoming voice call · encrypted';
      card.dataset.peer = peer;
    },
    onRemoteStream: (stream) => {
      const audio = $('#remote-audio');
      if (audio) {
        audio.srcObject = stream;
        audio.play().catch(() => {});
      }
      watchRemoteVideo(stream);
    },
    onLocalStream: (stream) => {
      const local = $('#local-video');
      if (local) {
        local.srcObject = stream;
        const hasVideo = stream.getVideoTracks().length > 0;
        $('#call-pip').hidden = !hasVideo;
        $('#call-pip').classList.toggle('is-share', Boolean(S.calls?.current?.sharing));
      }
    },
    onPeerShare: (on) => {
      $('#call-share-text').textContent = on
        ? `${displayName(S.calls?.current?.peer || '')} is sharing their screen`
        : 'Sharing your screen';
      if (on) toast(`${displayName(S.calls?.current?.peer || '')} started sharing their screen.`);
    },
    onTick: (seconds) => { $('#call-timer').textContent = D.duration(seconds); },
    onEnd: (result) => endCallUi(result),
  });
}

let remoteWatchTimer = null;

function watchRemoteVideo(stream) {
  stopRemoteWatch();
  if (!stream) return;
  const videoTrack = stream.getVideoTracks?.()[0] || null;
  const video = $('#remote-video');
  const evaluate = () => {
    const call = S.calls?.current;
    if (!call) { stopRemoteWatch(); return; }
    // Real frames are the only truth: videoWidth > 0 means Chromium has
    // actually decoded something (camera or screen share).
    const frames = Boolean(video) && video.videoWidth > 0;
    const show = Boolean(videoTrack) && (
      frames
      || (call.kind === 'video' && videoTrack && !videoTrack.muted)
      || (call.peerSharing && videoTrack && !videoTrack.muted)
    );
    showRemoteVideo(show ? stream : null, show);
  };
  // mute/unmute is the fast path (Windows screen shares short-circuit there);
  // the short poll is the safety net for engines where those events never fire.
  if (videoTrack) {
    videoTrack.onunmute = evaluate;
    videoTrack.onmute = evaluate;
  }
  remoteWatchTimer = setInterval(evaluate, 400);
  evaluate();
}

function stopRemoteWatch() {
  if (remoteWatchTimer) {
    clearInterval(remoteWatchTimer);
    remoteWatchTimer = null;
  }
}

function showRemoteVideo(stream, on) {
  const video = $('#remote-video');
  if (!video) return;
  if (on) {
    if (video.srcObject !== stream) video.srcObject = stream;
    video.classList.add('live');
    $('#call-audio-art').classList.add('hide');
  } else {
    video.classList.remove('live');
    $('#call-audio-art').classList.remove('hide');
  }
}

function renderCall(state) {
  const layer = $('#call-layer');
  layer.hidden = false;
  document.body.classList.add('call-active');
  $('#incoming').hidden = true;
  D.paintAvatar($('#call-avatar'), { name: displayName(state.peer), accent: accentOf(state.peer), avatar: avatarOf(state.peer) });
  $('#call-peer').textContent = displayName(state.peer);
  $('#call-state').textContent = {
    inviting: 'Calling…',
    incoming: 'Ringing…',
    connecting: 'Connecting securely…',
    connected: 'Connected · end-to-end encrypted',
  }[state.state] || '';
  $('#call-timer').textContent = D.duration(state.duration || 0);
  $('#call-code').textContent = state.code || '';
  $('#btn-mute').classList.toggle('is-off', state.muted);
  $('#btn-camera').classList.toggle('is-off', !state.cameraOn && !state.sharing);
  $('#btn-camera').disabled = state.kind !== 'video' && !state.sharing;
  $('#btn-share').classList.toggle('is-off', !state.sharing);
  $('#btn-share').disabled = state.state !== 'connected';
  $('#call-pip').hidden = !state.cameraOn && !state.sharing;
  $('#call-pip').classList.toggle('is-share', Boolean(state.sharing));
  const pill = $('#call-share-pill');
  pill.hidden = !state.sharing && !state.peerSharing;
  $('#call-share-text').textContent = state.peerSharing
    ? `${displayName(state.peer)} is sharing their screen`
    : 'Sharing your screen';
  if (state.peerSharing) {
    // The remote-video watcher flips the stage the moment real frames arrive.
    const track = S.calls?.current?.remoteStream?.getVideoTracks?.()[0];
    if (track && track.onunmute) track.onunmute();
  }
  if (state.state === 'connecting') S.sound.stopDial();
}

function endCallUi(result) {
  stopRemoteWatch();
  document.body.classList.remove('call-active');
  $('#call-layer').hidden = true;
  $('#incoming').hidden = true;
  $('#remote-video').classList.remove('live');
  $('#remote-video').srcObject = null;
  $('#call-audio-art').classList.remove('hide');
  $('#call-pip').hidden = true;
  $('#call-share-pill').hidden = true;
  $('#call-code').hidden = true;
  S.sound.stopAll();
  window.goat?.screen?.clear?.(window.goat.partition);

  const peer = result.peer;
  if (peer && S.contacts.has(peer)) {
    const rec = {
      id: null,
      clientId: D.randomId(8),
      peer,
      dir: 'out',
      from: S.me.username.toLowerCase(),
      ts: Date.now(),
      kind: 'call',
      payload: { outcome: result.outcome, durationSec: result.durationSec, callKind: result.kind },
      status: 'sent',
      local: true,
    };
    pushRecord(peer, rec);
    renderChatList();
    if (S.activePeer === peer) renderConversation({ scroll: 'bottom' });
  }

  const messages = {
    completed: `Call ended · ${D.duration(result.durationSec)}`,
    declined: `${displayName(peer)} declined`,
    missed: 'Missed call',
    'no-answer': 'No answer',
    cancelled: 'Call cancelled',
    failed: 'Call failed',
  };
  toast(messages[result.outcome] || 'Call ended', result.outcome === 'failed' ? 'err' : '');
}

async function openScreenPicker() {
  const call = S.calls?.current;
  if (!call) return toast('Start a call first.', 'err');
  if (call.state !== 'connected') return toast('Wait until the call connects.', 'err');
  if (!window.goat?.screen) return toast('Screen sharing needs the desktop app.', 'err');
  const res = await window.goat.screen.sources();
  const pick = (source) => async () => {
    closeModal();
    toast(`Sharing ${source.name}.`);
    try {
      await S.calls.startShare(source.id, window.goat.partition);
    } catch (err) {
      toast(err.name === 'NotAllowedError'
        ? 'Screen recording is blocked. Allow GoatMessenger in System Settings → Privacy.'
        : err.message || 'Could not share that screen.', 'err');
    }
  };

  const cards = (res.sources || []).map((source) => el('button', {
    class: 'screen-card',
    type: 'button',
    onclick: pick(source),
  },
  source.thumbnail
    ? el('img', { src: source.thumbnail, alt: '' })
    : el('div', { class: 'screen-blank' }, icon('screen')),
  el('div', { class: 'screen-meta' },
    source.appIcon ? el('img', { class: 'screen-app', src: source.appIcon, alt: '' }) : null,
    el('span', { class: 'screen-name', text: source.name }),
    el('span', { class: 'chip tiny', text: source.kind }))));

  const list = cards.length
    ? el('div', { class: 'screen-grid' }, ...cards)
    : el('p', { class: 'sub', text: 'No screens available. On macOS you may need to allow Screen Recording for GoatMessenger, then try again.' });

  const warning = res.permission && res.permission !== 'granted'
    ? el('div', { class: 'screen-warning' },
      icon('lock'),
      el('div', { class: 'grow' },
        el('div', { text: 'macOS needs Screen Recording permission' }),
        el('small', { text: 'Allow GoatMessenger in System Settings → Privacy & Security → Screen Recording, then restart the app.' })),
      el('button', { class: 'ghost', type: 'button', text: 'Open Settings', onclick: () => window.goat.screen.openPrefs() }))
    : null;

  openModal(modalShell(
    'Share your screen',
    'The stream joins the encrypted call — nothing extra leaves your Mac.',
    el('div', { class: 'screen-picker' }, warning, list),
    [el('button', { class: 'ghost', type: 'button', text: 'Cancel', onclick: closeModal })],
  ));
}

$('#btn-share').addEventListener('click', () => {
  const call = S.calls?.current;
  if (call?.sharing) {
    S.calls.stopShare();
    return;
  }
  if (!requireLogin()) return;
  openScreenPicker();
});

$('#btn-call-audio').addEventListener('click', () => startCall('audio'));
$('#btn-call-video').addEventListener('click', () => startCall('video'));

async function startCall(kind) {
  if (!S.activePeer) return;
  if (kind === 'video' && !requireLogin()) return;
  if (S.calls.active) return toast('You are already in a call.', 'err');
  try {
    await S.calls.start(S.activePeer, kind);
    if (S.calls.lastError) {
      toast(S.calls.lastError);
      S.calls.lastError = null;
    }
  } catch (err) {
    S.calls.reset();
    $('#call-layer').hidden = true;
    toast(err.name === 'NotAllowedError'
      ? 'Microphone access denied. Enable it in System Settings → Privacy.'
      : err.message || 'Could not start the call.', 'err');
  }
}

$('#btn-accept').addEventListener('click', async () => {
  if ($('#incoming').dataset.kind === 'video' && !requireLogin()) {
    $('#incoming').hidden = true;
    S.calls.decline();
    return;
  }
  $('#incoming').hidden = true;
  try {
    await S.calls.accept();
    if (S.calls.lastError) {
      toast(S.calls.lastError);
      S.calls.lastError = null;
    }
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Microphone access denied.' : 'Could not answer the call.', 'err');
    $('#call-layer').hidden = true;
  }
});

$('#btn-decline').addEventListener('click', () => {
  $('#incoming').hidden = true;
  S.calls.decline();
});

$('#btn-hangup').addEventListener('click', () => S.calls.hangup());
$('#btn-mute').addEventListener('click', () => S.calls.toggleMute());
$('#btn-camera').addEventListener('click', () => {
  if (!requireLogin()) return;
  S.calls.toggleCamera();
});
$('#btn-call-code').addEventListener('click', () => {
  const node = $('#call-code');
  node.hidden = !node.hidden;
});

/* ==================================================================== wiring */

function wireStaticUi() {
  D.$$('.tab').forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#auth-submit');
    const username = $('#auth-username').value;
    const pass = $('#auth-pass').value;
    const buttonLabel = S.authMode === 'signup' ? 'Creating keys…' : 'Unlocking…';
    $('#auth-error').hidden = true;
    busy(button, buttonLabel);
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 10)));
    try {
      if (S.authMode === 'signup') {
        const pass2 = $('#auth-pass2').value;
        if (pass !== pass2) throw new Error('Passphrases do not match.');
        if (!$('#auth-age').checked || !$('#auth-terms').checked) {
          throw new Error('Please confirm your age and accept the Terms & Privacy policy to continue.');
        }
        await signUp(username, pass, $('#auth-display').value);
        toast('Welcome to the herd.');
      } else {
        await signIn(username, pass);
        toast('Signed in.');
      }
    } catch (err) {
      authError(err.message || 'Something went wrong.');
    } finally {
      unbusy(button);
    }
  });

  $('#btn-settings').addEventListener('click', openSettings);
  $('#peer-avatar').addEventListener('click', () => { if (S.activePeer) openPeerProfile(S.activePeer); });
  $('#peer-name').addEventListener('click', () => { if (S.activePeer) openPeerProfile(S.activePeer); });
  $('#btn-verify').addEventListener('click', openVerify);
  $('#btn-guest').addEventListener('click', async () => {
    const button = $('#btn-guest');
    $('#auth-error').hidden = true;
    busy(button, 'Waking a guest…');
    try {
      await continueAsGuest();
    } catch (err) {
      authError(err.message || 'Could not start a guest session.');
    } finally {
      unbusy(button);
    }
  });
  $('#search').addEventListener('input', (event) => {
    S.search = event.target.value;
    renderChatList();
  });
  $('#btn-new-window-auth').addEventListener('click', () => window.goat?.newWindow?.());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#modal-layer').hidden) return closeModal();
      if (!$('#call-layer').hidden) return S.calls?.hangup();
      if (!$('#emoji-pop').hidden) return void ($('#emoji-pop').hidden = true);
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#search').focus();
    }
  });

  document.addEventListener('pointerdown', () => S.sound.ensure(), { once: true });

  // Clicking a message notification opens that chat (window restore + focus
  // steps happen in the main process first).
  window.goat?.onNotifyClick?.((data) => {
    const peer = String(data?.peer || '');
    const reachable = S.contacts.get(peer)?.state === 'accepted' || S.groups.has(peer);
    if (peer && reachable) openChat(peer).catch(() => {});
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.activePeer) {
      S.unread.set(S.activePeer, 0);
      syncBadge();
      renderChatList();
      const lastSeq = (S.messages.get(S.activePeer) || []).reduce((m, r) => Math.max(m, r.seq || 0), 0);
      sendRead(S.activePeer, lastSeq);
    }
  });

  window.addEventListener('beforeunload', () => {
    try { S.calls?.reset(); } catch {}
    try { S.api?.close(); } catch {}
  });
}

/* ===================================================================== boot */

// Brings back the previous session without the passphrase. Runs after the relay
// is known to be healthy; when it fails we simply fall through to sign-in and
// keep the stored record (it may belong to a relay that is only down right now).
async function tryRestoreSession() {
  if (S.info.e2e) return; // tests sign in explicitly
  let saved;
  try { saved = await window.goat?.session?.load?.(); } catch { return; }
  if (!saved?.token || !saved.identity) return;
  try {
    S.api.setToken(saved.token);
    const bootstrap = await S.api.request('/api/bootstrap');
    await startSession({
      username: saved.username,
      token: saved.token,
      identity: C.importIdentity(saved.identity),
      bootstrap,
    });
    showBootNote('Welcome back.');
  } catch {
    try { S.api.setToken(null); } catch {}
  }
}

function showRelayWarning(message) {
  const card = $('.auth-card');
  if (!card) return;
  let node = $('#relay-warning');
  if (!node) {
    node = el('div', { class: 'auth-error', id: 'relay-warning' });
    card.insertBefore(node, $('.auth-meta'));
  }
  node.innerHTML = '';
  node.append(
    el('strong', { text: 'Relay offline. ' }),
    el('span', { text: message }),
    el('button', {
      class: 'link',
      type: 'button',
      text: ' Retry',
      onclick: async () => {
        const res = await window.goat.retryRelay();
        if (res.relayError) {
          showRelayWarning(res.relayError);
          return;
        }
        await adoptRelay(res, node);
      },
    }),
  );
  node.hidden = false;
  // Don't make the user watch for the relay — after a machine slept, a tunnel
  // hiccup, or a relay restart, this recovers the moment the relay answers.
  startRelayWatch();
}

let relayWatchTimer = null;

/** Points the live session at a newly-verified relay and clears the warning. */
async function adoptRelay(res, warnNode) {
  S.api = new Api(res.relayUrl);
  S.info.relayUrl = res.relayUrl;
  const label = $('#relay-label');
  if (label) label.textContent = `relay ${res.relayUrl}`;
  showBootNote('Ready.');
  if (warnNode) warnNode.hidden = true;
  if (relayWatchTimer) { clearInterval(relayWatchTimer); relayWatchTimer = null; }
}

/** Polls every few seconds while the relay is down; hidden tabs skip a beat. */
function startRelayWatch() {
  if (relayWatchTimer) return;
  relayWatchTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const res = await window.goat.retryRelay();
      if (!res.relayError) {
        await adoptRelay(res, $('#relay-warning'));
        toast('The relay is back online. You can sign in.');
      }
    } catch { /* still down; keep watching */ }
  }, 6000);
}

async function boot() {
  wireStaticUi();
  try {
    S.info = await window.goat.info();
  } catch {
    S.info = { relayUrl: 'http://127.0.0.1:4040' };
  }
  S.api = new Api(S.info.relayUrl);
  buildCallManager();
  if (S.info.net) S.calls.setNetwork({ turn: S.info.net.turn, forceRelay: S.info.net.forceRelay });

  $('#relay-label').textContent = `relay ${S.info.relayUrl}`;
  applyTheme(savedTheme());
  const lastUser = localStorage.getItem('gm:lastUser');
  if (lastUser) $('#auth-username').value = lastUser;

  // The ngrok-skip header matters on free tunnels: without it ngrok answers
  // the browser with its interstitial page and boot would always think the
  // relay is down, even when it is fine.
  const healthy = await fetch(`${S.info.relayUrl}/api/health`, {
    headers: { 'ngrok-skip-browser-warning': 'goatmessenger' },
  }).then((r) => r.ok).catch(() => false);
  showBootNote(healthy ? 'Ready.' : 'Relay not reachable — start it with npm run server.');
  if (!healthy) showRelayWarning(S.info.relayError || `No relay answering at ${S.info.relayUrl}.`);

  await tryRestoreSession();

  setTimeout(() => {
    $('#boot').classList.add('hide');
    if (!S.me) {
      $('#auth').hidden = false;
      $('#auth-username').focus();
    }
    S.booted = true;
  }, healthy ? 500 : 900);
}

/* ============================================================== test hooks */

window.__gm = {
  state: S,
  booted: () => S.booted,
  signIn,
  signUp,
  openChat,
  signOut,
  async sendText(text) {
    await sendPayload(S.activePeer, 'text', { text });
  },
  async sendFile(name, mime, bytes) {
    const file = new File([bytes], name, { type: mime });
    await sendFile(file);
  },
  addContact: async (name) => {
    applyBootstrap(await S.api.addContact(name));
  },
  acceptRequest,
  ready: () => Boolean(S.me && S.booted),
  unread: (peer) => S.unread.get(String(peer).toLowerCase()) || 0,
  startCall,
  acceptCall: () => S.calls.accept(),
  declineCall: () => S.calls.decline(),
  hangup: () => S.calls.hangup(),
  callState: () => {
    const call = S.calls?.current;
    if (!call) return { state: 'idle' };
    return {
      state: call.state,
      kind: call.kind,
      code: call.code,
      pc: call.pc ? call.pc.connectionState : null,
      localTracks: call.localStream ? call.localStream.getTracks().map((t) => `${t.kind}:${t.enabled}`) : [],
      remoteTracks: call.remoteStream ? call.remoteStream.getTracks().map((t) => t.kind) : [],
      sharing: Boolean(call.sharing),
      peerSharing: Boolean(call.peerSharing),
      sendingVideo: Boolean(call.videoTx?.sender?.track),
      usingTurn: S.calls.hasTurn(),
      icePolicy: S.calls.icePolicy,
      remoteVideo: (() => {
        const stream = call.remoteStream;
        if (!stream) return null;
        const track = stream.getVideoTracks()[0];
        if (!track) return null;
        const settings = track.getSettings?.() || {};
        return { muted: track.muted, width: settings.width || 0, height: settings.height || 0 };
      })(),
    };
  },
  startShare: (id) => S.calls.startShare(id, window.goat.partition),
  stopShare: () => S.calls.stopShare(),
  screenSources: () => window.goat.screen.sources(),
  openScreenPicker,
  net: () => S.info.net,
  relayUrl: () => S.api.url,
  setNetwork: (next) => {
    S.calls.setNetwork(next);
    S.info.net = { ...(S.info.net || {}), ...next };
    return S.calls.iceServers;
  },
  // Transport-level facts for the live call: DTLS state, the SRTP cipher, the
  // certificate pair, and which candidate pair actually carries the media.
  callStats: async () => {
    const call = S.calls?.current;
    if (!call || !call.pc) return { error: 'no active call' };
    try {
      const report = await call.pc.getStats();
      const rows = [];
      report.forEach((stat) => {
        const row = { id: stat.id, type: stat.type };
        ['dtlsState', 'dtlsCipher', 'srtpCipher', 'selectedCandidatePairId', 'bytesSent', 'bytesReceived',
          'state', 'selected', 'nominated', 'localCandidateId', 'remoteCandidateId', 'fingerprint',
          'fingerprintAlgorithm', 'port', 'protocol', 'address', 'candidateType', 'transportId'].forEach((key) => {
          if (stat[key] !== undefined) row[key] = stat[key];
        });
        rows.push(row);
      });
      const certificates = rows.filter((r) => r.type === 'certificate').map((r) => r.fingerprint || r.id);
      const transport = rows.find((r) => r.type === 'transport') || null;
      const candidates = {};
      for (const row of rows) {
        if (row.type === 'local-candidate' || row.type === 'remote-candidate') {
          candidates[row.id] = { port: row.port, protocol: row.protocol, address: row.address, type: row.candidateType };
        }
      }
      const pairs = rows.filter((r) => r.type === 'candidate-pair');
      const pair = pairs.find((p) => p.selected)
        || (transport?.selectedCandidatePairId ? pairs.find((p) => p.id === transport.selectedCandidatePairId) : null)
        || pairs.find((p) => p.state === 'succeeded' && p.nominated)
        || pairs.find((p) => p.state === 'succeeded')
        || null;
      let relayPort = null;
      try { relayPort = Number(new URL(S.api.url).port || 80); } catch {}
      return {
        transport: transport ? { dtlsState: transport.dtlsState || null, dtlsCipher: transport.dtlsCipher || null, srtpCipher: transport.srtpCipher || null } : null,
        certificates,
        pair: pair ? {
          state: pair.state || null,
          bytesSent: pair.bytesSent || 0,
          bytesReceived: pair.bytesReceived || 0,
          localCandidate: candidates[pair.localCandidateId] || null,
          remoteCandidate: candidates[pair.remoteCandidateId] || null,
        } : null,
        relayPort,
        types: [...new Set(rows.map((r) => r.type))].sort(),
      };
    } catch (err) {
      return { error: err.message };
    }
  },
  transcript: (peer) => (S.messages.get(String(peer).toLowerCase()) || []).map((r) => ({
    dir: r.dir, kind: r.kind, text: r.payload?.text, status: r.status, ts: r.ts,
  })),
  safety: async (peer) => C.safetyNumber(C.publicBundle(S.identity), await peerBundle(peer)),
  contacts: () => [...S.contacts.values()].map((c) => ({ username: c.username, state: c.state })),
  activePeer: () => S.activePeer,
  groups: () => [...S.groups.entries()].map(([key, g]) => ({ key, ...g })),
  createGroup: async (name, members) => S.api.createGroup(name, members),
  notifyPrefs: () => S.notify,
};

boot();
