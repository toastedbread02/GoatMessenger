// GoatMessenger relay server.
//
// The server is deliberately blind: it stores public key bundles, opaque
// encrypted envelopes, and routing metadata. It never has a key that can read a
// message, a file, or a call's signalling.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const { Store, openStore } = require('./store');

/* -------------------------------------------------------------- turnstile -- */
// Cloudflare's robot check on sign-ups (https://developers.cloudflare.com/turnstile/).
// Shipped configured with Cloudflare's published test keys — the widget shows,
// one click, always passes — so every relay displays it out of the box with no
// account needed. A relay operator who wants real enforcement sets
// TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY in the environment; the relay then
// verifies every signup token against Cloudflare's siteverify API and rejects
// signups without a valid one. (The signup proof-of-work stays the always-on
// fallback so loops of requests still cost the bot real CPU.)
const CAPTCHA_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const CAPTCHA = {
  siteKey: process.env.TURNSTILE_SITE_KEY || '1x00000000000000000000AA',
  secret: process.env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA',
  strict: Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY),
};
// TURN is only needed when the operator opts into UDP relaying, and importing
// it pulls in `node:dgram` — which would break runtime hosts (Deno Deploy)
// that have no UDP sockets even when TURN is switched off.
let createTurnServer = null;
try { createTurnServer = require('./turn').createTurnServer; } catch (err) {
  console.error('[relay] TURN support unavailable:', err.message);
}

const MAX_JSON = 2200 * 1024;
// Account migration carries a whole history in one body, so it gets its own
// (still bounded) ceiling.
const MAX_IMPORT = 8 * 1024 * 1024;
const MAX_UPLOAD = 50 * 1024 * 1024;
// On backends where attachments live inside the storage engine (Deno Deploy's
// KV) uploads are capped tighter so one file can never eat the whole quota's
// write budget.
const KV_MAX_UPLOAD = 5 * 1024 * 1024;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

const bareJson = (res, code, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type,x-file-name,x-file-type,ngrok-skip-browser-warning',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    ...headers,
  });
  res.end(payload);
};

const fail = (res, code, error, extra) => bareJson(res, code, { error, ...(extra || {}) });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = MAX_JSON) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

const GROUP_ID_RE = /^g[0-9a-f]{8,32}$/;

/** Validates a portable account bundle before it is written into the store.
    Returns an error message, or null when the bundle is usable. */
function bundleProblem(bundle) {
  if (!bundle || typeof bundle !== 'object' || bundle.v !== 1) return 'Unsupported account bundle.';
  const acc = bundle.account;
  if (!acc || typeof acc !== 'object') return 'Account bundle is missing its account.';
  if (!USERNAME_RE.test(String(acc.username || ''))) return 'Account bundle has an invalid name.';
  if (typeof acc.salt !== 'string' || acc.salt.length < 8 || acc.salt.length > 200) {
    return 'Account bundle has an invalid salt.';
  }
  if (typeof acc.verifier !== 'string' || !/^[A-Za-z0-9+/=]{20,80}$/.test(acc.verifier)) {
    return 'Account bundle has an invalid verifier.';
  }
  const keys = acc.keys;
  if (!keys || typeof keys !== 'object') return 'Account bundle has no key bundle.';
  for (const field of ['ik', 'sig', 'spk', 'spkSig']) {
    if (typeof keys[field] !== 'string' || keys[field].length < 32) {
      return 'Account bundle has an incomplete key bundle.';
    }
  }
  if (typeof acc.identityBackup !== 'string' || acc.identityBackup.length < 32) {
    return 'Account bundle has no key backup.';
  }
  return null;
}

const hashToken = (token, salt) => crypto.scryptSync(String(token), salt, 32, { N: 16384, r: 8, p: 1 });
const newToken = () => crypto.randomBytes(32).toString('base64url');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

// Avatar/banner arrive as data URLs and are published to contacts verbatim,
// so keep them small and strictly image-shaped. null = "not touched".
const MAX_AVATAR = 220 * 1024;
const MAX_BANNER = 420 * 1024;
const IMG_DATA_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
function sanitizeImage(input, maxLen) {
  if (input === undefined) return null;
  if (typeof input !== 'string') return null;
  if (input === '') return '';
  if (input.length > maxLen) return null;
  return IMG_DATA_RE.test(input) ? input : null;
}

function sanitizeProfile(input) {
  const displayName = String(input.displayName || '').trim().slice(0, 40);
  const about = String(input.about || '').trim().slice(0, 120);
  const accent = Number.isFinite(input.accent) ? Math.max(0, Math.min(360, Math.round(input.accent))) : null;
  return { displayName, about, accent, avatar: sanitizeImage(input.avatar, MAX_AVATAR), banner: sanitizeImage(input.banner, MAX_BANNER) };
}

function publicUser(rec, presence) {
  return {
    username: rec.username,
    displayName: rec.displayName || rec.username,
    about: rec.about || '',
    accent: rec.accent ?? 0,
    avatar: rec.avatar || '',
    banner: rec.banner || '',
    createdAt: rec.createdAt,
    presence: presence(rec.username) ? 'online' : 'offline',
  };
}

function createGoatServer({
  port = 4040,
  dataDir = path.join(process.cwd(), 'data'),
  host = '127.0.0.1',
  tls = null,
  turn = null,      // { port, publicIp, user, pass, realm, statsToken }
  pow = null,       // 'public' (default) | 'always' | 'off' — signup proof-of-work mode
} = {}) {
  const storeReady = openStore(dataDir); // Promise<Store> — fs on Node, Deno KV on Deploy
  // Attachments are written to disk only in fs-store mode; in KV mode they
  // live in the database. On a read-only data dir (Deno Deploy) fall back to
  // the instance's temp directory so boot never crashes.
  let filesDir = path.join(dataDir, 'files');
  try {
    fs.mkdirSync(filesDir, { recursive: true });
  } catch (err) {
    if (!['EACCES', 'EROFS', 'EPERM'].includes(err.code)) throw err;
    filesDir = path.join(require('os').tmpdir(), 'goatmessenger-files');
    fs.mkdirSync(filesDir, { recursive: true });
  }
  // Assigned once the store finishes loading. Every consumer awaits `boot()`
  // before its first synchronous read; helpers below close over the binding,
  // so they see the loaded store wherever they run.
  let store = null;
  const boot = () => {
    if (store) return Promise.resolve();
    return storeReady.then((loaded) => { store = loaded; });
  };

  /* ------------------------------------------------------- hardening headers - */
  // Security headers on every relay response (mostly relevant through the
  // browser copy of the app). Strict-Transport-Security only exists on TLS.
  const baseHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...(tls ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
  // Shadow the module-level helpers so every response inside this server
  // carries the hardening headers too.
  const json = (res, code, body, headers = {}) => bareJson(res, code, body, { ...baseHeaders, ...headers });
  const fail = (res, code, error, extra) => json(res, code, { error, ...(extra || {}) });
  const sendJson = json;

  /* ------------------------------------------------------------ bot control - */
  // Light proof-of-work on signups for relays reachable from the open
  // internet (tunnels/VPS). Loopback (the embedded relay in the desktop app
  // and local dev/tests) is exempt unless pow: 'always' is set.
  const POW_BITS = 16;
  const POW_MODE = pow === 'off' ? 'off' : (pow === 'always' ? 'always' : 'public');
  const POW_SECRET = crypto.randomBytes(32); // per-process: challenges die with the relay, do not need to persist
  const powSeen = new Set();
  const ipOf = (req) => String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  const isLoopbackIp = (ip) => ip.startsWith('127.') || ip === '::1' || ip === 'localhost';
  const powChallenge = (ip, name, bucket = Math.floor(Date.now() / 3600000)) =>
    crypto.createHmac('sha256', POW_SECRET).update(`${bucket}:${ip}:${name}`).digest('hex');
  const leadingZeroBits = (buf) => {
    let bits = 0;
    for (const byte of buf) {
      if (byte === 0) { bits += 8; continue; }
      for (let m = 0x80; m > 0; m >>= 1) { if (byte & m) break; bits++; }
      break;
    }
    return bits;
  };

  /** Verifies a signup's proof of work — null when valid, else { error, bits, challenge }. */
  const powVerify = (ip, name, pow) => {
    const now = Math.floor(Date.now() / 3600000);
    const accepted = new Set([powChallenge(ip, name, now), powChallenge(ip, name, now - 1)]);
    if (!pow || typeof pow !== 'object' || typeof pow.challenge !== 'string' || !accepted.has(pow.challenge)) {
      return { error: 'Signup proof of work is stale. Try again.', bits: POW_BITS, challenge: powChallenge(ip, name, now) };
    }
    const nonce = String(pow.nonce || '');
    if (!/^\d{1,10}$/.test(nonce)) {
      return { error: 'Signup proof of work is malformed.', bits: POW_BITS, challenge: pow.challenge };
    }
    const digest = crypto.createHash('sha256').update(`${pow.challenge}:${name}:${nonce}`).digest();
    const key = `${pow.challenge}:${nonce}`;
    const spent = powSeen.has(key);
    if (!spent && leadingZeroBits(digest) < POW_BITS) {
      return { error: 'Signup proof of work did not check out.', bits: POW_BITS, challenge: pow.challenge };
    }
    if (spent) {
      return { error: 'Signup proof of work has been used already.', bits: POW_BITS, challenge: powChallenge(ip, name, now) };
    }
    if (powSeen.size > 40000) powSeen.clear();
    powSeen.add(key);
    return null;
  };
    /** Cloudflare Turnstile: null when acceptable, else an error message.
     * Strict (real keys) means the token is mandatory and verified remotely;
     * test keys (the shipped default) are cosmetic — the proof of work still
     * gates the actual flood. */
    const captchaVerify = async (token) => {
      if (!CAPTCHA.strict) return null; // demo keys: the widget is informal
      if (!token || typeof token !== 'string' || token.length < 10) {
        return 'The robot check did not complete. Please try again.';
      }
      try {
        const body = new URLSearchParams({ secret: CAPTCHA.secret, response: token }).toString();
        const verdict = await (await fetch(CAPTCHA_VERIFY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        })).json();
        if (verdict && verdict.success) return null;
      } catch (err) {
        console.error('[captcha] siteverify unreachable:', err.message);
        return 'The robot check could not be verified. Please try again.';
      }
      return 'The robot check failed or expired. Please try again.';
    };
    const powRequired = (ip) => POW_MODE === 'always' || (POW_MODE === 'public' && !isLoopbackIp(ip));

  /** username -> Set<WebSocket> */
  const sockets = new Map();
  const presence = (user) => {
    const set = sockets.get(String(user).toLowerCase());
    return Boolean(set && set.size);
  };

  const sendTo = (user, payload) => {
    const set = sockets.get(String(user).toLowerCase());
    if (!set) return 0;
    const data = JSON.stringify(payload);
    let n = 0;
    for (const ws of set) {
      if (ws.readyState === 1) {
        ws.send(data);
        n++;
      }
    }
    return n;
  };

  const broadcastToContacts = (user, payload, { includeSelf = false } = {}) => {
    const name = user.toLowerCase();
    for (const rel of store.contactsOf(name)) {
      if (rel.state === 'accepted') sendTo(rel.peer, payload);
    }
    if (includeSelf) sendTo(name, payload);
  };

  const pairAccepted = (a, b) =>
    store.relation(a, b)?.state === 'accepted' && store.relation(b, a)?.state === 'accepted';

  /* ------------------------------------------------------------- group chats - */

  const publicGroup = (g) => ({
    id: g.id, name: g.name, owner: g.owner, members: g.members, createdAt: g.createdAt,
  });
  // Two goats may not be direct contacts but share a group: bundle fetches and
  // ciphertext drops for group deliveries ride on shared membership.
  const canReach = (a, b) => pairAccepted(a, b) || store.shareGroup(a, b);

  /* ---------------------------------------------------------------- sessions - */

  const authenticate = (req) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return null;
    const session = store.session(token);
    if (!session) return null;
    const user = store.user(session.user);
    if (!user) return null;
    return { token, user };
  };

  const rateCounters = new Map();
  const tooMany = (key, max) => {
    const now = Date.now();
    const entry = rateCounters.get(key) || { count: 0, reset: now + 60000 };
    if (now > entry.reset) {
      entry.count = 0;
      entry.reset = now + 60000;
    }
    entry.count++;
    rateCounters.set(key, entry);
    return entry.count > max;
  };
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateCounters) if (now > entry.reset) rateCounters.delete(key);
  }, 300000).unref();

  const bootstrap = (user) => {
    const me = store.user(user);
    const contacts = store.contactsOf(user).map((rel) => {
      const rec = store.user(rel.peer);
      const last = store.lastMessage(user, rel.peer);
      return {
        ...(rec ? publicUser(rec, presence) : { username: rel.peer, displayName: rel.peer, presence: 'offline', accent: 0, about: '' }),
        state: rel.state,
        since: rel.since,
        last: last ? { id: last.id, seq: last.seq, from: last.from, ts: last.ts, env: last.env } : null,
      };
    }).sort((a, b) => ((b.last?.ts || b.since) - (a.last?.ts || a.since)));

    return {
      me: publicUser(me, presence),
      contacts,
      groups: store.groupsOf(me.username).map(publicGroup),
      server: { name: 'goatmessenger', version: 1, encrypted: true },
    };
  };

  /* ----------------------------------------------------------------- routing - */

  async function handleRequest(req, res) {
    await boot();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization,content-type,x-file-name,x-file-type,ngrok-skip-browser-warning',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      });
      return res.end();
    }

    try {
      /* public ------------------------------------------------------------- */
      if (route === '/api/health') {
        return json(res, 200, {
          ok: true,
          name: 'goatmessenger',
          users: Object.keys(store.data.users).length,
          turn: turnServer ? { enabled: true } : { enabled: false },
        });
      }

      // Cloudflare Turnstile site key so clients can render the robot check
      // before submitting a signup.
      if (route === '/api/captcha' && req.method === 'GET') {
        return json(res, 200, { siteKey: CAPTCHA.siteKey, strict: CAPTCHA.strict });
      }

      // Proof-of-work challenge for signups (see powVerify below). Supply the
      // intended username so the challenge binds to it.
      if (route === '/api/pow' && req.method === 'GET') {
        const name = String(url.searchParams.get('name') || '');
        return json(res, 200, { bits: POW_BITS, challenge: powChallenge(ipOf(req), name) });
      }

      // Local operational read-out for the bundled TURN relay. Guarded by a
      // token so a public deployment does not advertise its traffic counters.
      if (route === '/api/turn-stats') {
        const token = url.searchParams.get('token') || req.headers['x-turn-token'] || '';
        const expected = turn?.statsToken || '';
        if (!turnServer || !expected || token !== expected) return fail(res, 404, 'Unknown route.');
        return json(res, 200, turnServer.stats());
      }

      if (route === '/api/signup' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || 'local';
        if (tooMany(`signup:${ip}`, 10)) return fail(res, 429, 'Too many accounts from here. Wait a minute.');
        const body = await readJson(req);
        const username = String(body.username || '').trim();
        if (!USERNAME_RE.test(username)) return fail(res, 400, 'Use 3–24 letters, numbers or underscores.');
        if (powRequired(ip)) {
          // Bots hit public relays hard first; a tiny proof of work keeps
          // mass registrations out without any third-party captcha.
          const verdict = powVerify(ip, username, body.pow);
          if (verdict) return sendJson(res, 428, { ...verdict });
        }
        if (CAPTCHA.strict) {
          const captchaError = await captchaVerify(body.turnstile);
          if (captchaError) return fail(res, 403, captchaError);
        } else if (body.turnstile && typeof body.turnstile === 'string' && body.turnstile.length > 100000) {
          return fail(res, 400, 'Bad captcha token.');
        }
        if (store.user(username)) return fail(res, 409, 'That name is already taken.');
        if (typeof body.authToken !== 'string' || body.authToken.length < 32) return fail(res, 400, 'Weak auth token.');
        const keys = body.keys || {};
        for (const field of ['ik', 'sig', 'spk', 'spkSig']) {
          if (typeof keys[field] !== 'string' || keys[field].length < 32) return fail(res, 400, 'Invalid key bundle.');
        }
        if (typeof body.identityBackup !== 'string' || body.identityBackup.length < 32) {
          return fail(res, 400, 'Missing encrypted key backup.');
        }
        const profile = sanitizeProfile(body);
        const salt = crypto.randomBytes(16).toString('base64');
        const record = {
          username,
          displayName: profile.displayName || username,
          about: profile.about,
          accent: profile.accent ?? Math.floor(Math.random() * 360),
          createdAt: Date.now(),
          salt,
          verifier: hashToken(body.authToken, salt).toString('base64'),
          keys,
          identityBackup: body.identityBackup,
        };
        store.putUser(record);
        const token = newToken();
        store.addSession(token, record.username);
        return json(res, 200, { token, ...bootstrap(record.username) });
      }

      if (route === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || 'local';
        if (tooMany(`login:${ip}`, 30)) return fail(res, 429, 'Too many attempts. Wait a minute.');
        const body = await readJson(req);
        const user = store.user(body.username);
        if (!user) return fail(res, 401, 'Incorrect name or passphrase.');
        const attempt = hashToken(String(body.authToken || ''), user.salt);
        if (!safeEqual(attempt, Buffer.from(user.verifier, 'base64'))) {
          return fail(res, 401, 'Incorrect name or passphrase.');
        }
        const token = newToken();
        store.addSession(token, user.username);
        return json(res, 200, {
          token,
          identityBackup: user.identityBackup,
          keys: user.keys,
          ...bootstrap(user.username),
        });
      }

      // Account migration (in). A goat made on another relay brings its
      // account record, contacts, groups and ciphertext history here. The
      // verifier is scrypt(authToken, salt) on every relay, so copying it
      // verbatim means the same name + passphrase opens the account here too.
      // Signup protection still applies: non-loopback callers solve the same
      // proof of work as a fresh signup.
      if (route === '/api/import' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || 'local';
        if (tooMany(`import:${ip}`, 60)) return fail(res, 429, 'Too many imports from here. Wait a minute.');
        const body = await readJson(req, MAX_IMPORT);
        const bundle = body.bundle;
        const problem = bundleProblem(bundle);
        if (problem) return fail(res, 400, problem);
        const acc = bundle.account;
        if (powRequired(ip)) {
          const verdict = powVerify(ip, acc.username, body.pow);
          if (verdict) return sendJson(res, 428, { ...verdict });
        }
        const name = acc.username.toLowerCase();
        if (store.user(name)) return fail(res, 409, 'That name is already here.');

        const record = {
          username: acc.username,
          displayName: String(acc.displayName || acc.username).trim().slice(0, 40) || acc.username,
          about: String(acc.about || '').trim().slice(0, 120),
          accent: Number.isFinite(acc.accent) ? Math.max(0, Math.min(360, Math.round(acc.accent))) : 0,
          createdAt: Number(acc.createdAt) || Date.now(),
          salt: acc.salt,
          verifier: acc.verifier,
          keys: { ik: acc.keys.ik, sig: acc.keys.sig, spk: acc.keys.spk, spkSig: acc.keys.spkSig },
          identityBackup: acc.identityBackup,
        };
        const avatar = sanitizeImage(acc.avatar, MAX_AVATAR);
        const banner = sanitizeImage(acc.banner, MAX_BANNER);
        if (avatar) record.avatar = avatar;
        if (banner) record.banner = banner;
        store.putUser(record);

        let groups = 0;
        for (const g of (Array.isArray(bundle.groups) ? bundle.groups : []).slice(0, 200)) {
          if (!g || !GROUP_ID_RE.test(String(g.id || '')) || store.getGroup(g.id)) continue;
          const members = (Array.isArray(g.members) ? g.members : [])
            .map((m) => String(m).toLowerCase())
            .filter((m) => USERNAME_RE.test(m));
          if (!members.includes(name)) members.push(name);
          if (members.length < 2) continue;
          store.createGroup({
            id: g.id,
            name: String(g.name || 'Group').trim().slice(0, 60) || 'Group',
            owner: USERNAME_RE.test(String(g.owner || '')) ? g.owner : name,
            members,
          });
          groups++;
        }

        let contacts = 0;
        for (const rel of (Array.isArray(bundle.contacts) ? bundle.contacts : []).slice(0, 500)) {
          const peer = String((rel && rel.peer) || '').toLowerCase();
          if (!USERNAME_RE.test(peer) || peer === name) continue;
          if (!['in', 'out', 'accepted'].includes(rel.state)) continue;
          if (store.relation(name, peer)) continue;
          store.setRelation(name, peer, rel.state);
          contacts++;
        }

        let messages = 0;
        for (const room of (Array.isArray(bundle.messages) ? bundle.messages : []).slice(0, 400)) {
          const peer = String((room && room.peer) || '').toLowerCase();
          if (!USERNAME_RE.test(peer) || peer === name) continue;
          for (const m of (Array.isArray(room.list) ? room.list : []).slice(-3000)) {
            if (!m || typeof m.env !== 'object' || !m.env) continue;
            if (typeof m.env.ct !== 'string' || !m.env.header) continue;
            const from = String(m.from || '').toLowerCase();
            if (from !== name && from !== peer) continue;
            store.pushMessage({
              from,
              to: from === name ? peer : name,
              env: m.env,
              clientId: typeof m.clientId === 'string' ? m.clientId : null,
              ts: Number(m.ts) || undefined,
            });
            messages++;
          }
        }
        store.flush();
        return json(res, 200, {
          ok: true,
          username: record.username,
          imported: { contacts, groups, messages },
        });
      }

      if (route === '/api/lookup' && req.method === 'GET') {
        const auth = authenticate(req);
        if (!auth) return fail(res, 401, 'Sign in first.');
        const name = String(url.searchParams.get('username') || '').trim();
        const rec = store.user(name);
        if (!rec) return fail(res, 404, 'No goat by that name.');
        const rel = store.relation(auth.user.username, rec.username);
        return json(res, 200, {
          user: publicUser(rec, presence),
          state: rel ? rel.state : 'none',
          isSelf: rec.username.toLowerCase() === auth.user.username.toLowerCase(),
        });
      }

      /* authenticated ------------------------------------------------------ */
      const auth = authenticate(req);
      if (!auth) return fail(res, 401, 'Sign in first.');
      const me = auth.user;

      if (route === '/api/bootstrap') return json(res, 200, bootstrap(me.username));

      // Account migration (out): everything needed to stand this goat up on
      // another relay — account record (same passphrase hash), contacts,
      // groups and the ciphertext of every room it is part of.
      if (route === '/api/export' && req.method === 'POST') {
        if (tooMany(`export:${me.username.toLowerCase()}`, 10)) {
          return fail(res, 429, 'Exported too often. Wait a minute.');
        }
        const name = me.username.toLowerCase();
        const rooms = [];
        for (const [room, list] of Object.entries(store.data.messages || {})) {
          if (!Array.isArray(list) || !list.length) continue;
          const peers = room.split('~');
          if (!peers.includes(name)) continue;
          const peer = peers.find((p) => p !== name);
          if (!peer) continue; // a room with itself has nothing to carry
          rooms.push({ peer, list: list.slice(-3000) });
        }
        if (rooms.length > 400) rooms.length = 400;
        return json(res, 200, {
          bundle: {
            v: 1,
            exportedAt: Date.now(),
            account: {
              username: me.username,
              displayName: me.displayName || me.username,
              about: me.about || '',
              accent: me.accent ?? 0,
              avatar: me.avatar || '',
              banner: me.banner || '',
              createdAt: me.createdAt,
              salt: me.salt,
              verifier: me.verifier,
              keys: me.keys,
              identityBackup: me.identityBackup,
            },
            contacts: store.contactsOf(name),
            groups: store.groupsOf(name).map(publicGroup),
            messages: rooms,
          },
        });
      }

      if (route === '/api/logout' && req.method === 'POST') {
        store.dropSession(auth.token);
        return json(res, 200, { ok: true });
      }

      // Account deletion — data minimization in one step. The user must
      // re-type their goat name in the body so fat-finger clicks don't nuke
      // an account. Everything the relay holds for this user is erased.
      if (route === '/api/account' && req.method === 'DELETE') {
        const body = await readJson(req);
        const confirm = String(body.confirm || '').trim().toLowerCase();
        if (confirm !== me.username.toLowerCase()) {
          return fail(res, 400, 'Type your goat name to confirm deletion.');
        }
        for (const rel of store.contactsOf(me.username)) {
          if (rel.state === 'accepted') {
            sendTo(rel.peer, { t: 'contact-removed', user: me.username.toLowerCase() });
          }
        }
        for (const group of store.dropGroupsFor(me.username)) {
          for (const member of group.members) {
            if (member !== me.username.toLowerCase()) sendTo(member, { t: 'group', group });
          }
        }
        const wsSet = sockets.get(me.username.toLowerCase());
        if (wsSet) {
          for (const ws of wsSet) { try { ws.close(4002, 'account-deleted'); } catch {} }
          sockets.delete(me.username.toLowerCase());
        }
        const filePaths = await store.dropFilesOf(me.username);
        await store.dropRelationsOf(me.username);
        await store.dropMessagesFor(me.username);
        await store.dropSessionsOf(me.username);
        await store.dropUser(me.username);
        store.flush();
        for (const filePath of filePaths) {
          try { fs.unlinkSync(filePath); } catch {}
        }
        return json(res, 200, { ok: true });
      }

      if (route === '/api/profile' && req.method === 'POST') {
        const body = await readJson(req);
        const profile = sanitizeProfile(body);
        if (profile.displayName) me.displayName = profile.displayName;
        if (profile.about !== null) me.about = profile.about;
        if (profile.accent !== null) me.accent = profile.accent;
        if (profile.avatar !== null) { if (profile.avatar) me.avatar = profile.avatar; else delete me.avatar; }
        if (profile.banner !== null) { if (profile.banner) me.banner = profile.banner; else delete me.banner; }
        store.putUser(me);
        broadcastToContacts(me.username, {
          t: 'profile', user: publicUser(me, presence),
        }, { includeSelf: true });
        return json(res, 200, { me: publicUser(me, presence) });
      }

      if (route === '/api/keys' && req.method === 'GET') {
        const peer = String(url.searchParams.get('username') || '').trim();
        const rec = store.user(peer);
        if (!rec) return fail(res, 404, 'No goat by that name.');
        const self = rec.username.toLowerCase() === me.username.toLowerCase();
        if (!self && !canReach(me.username, rec.username)) return fail(res, 403, 'Not connected.');
        return json(res, 200, { username: rec.username, keys: rec.keys });
      }

      if (route === '/api/contacts' && req.method === 'POST') {
        const body = await readJson(req);
        const rec = store.user(body.username);
        if (!rec) return fail(res, 404, 'No goat by that name.');
        if (rec.username.toLowerCase() === me.username.toLowerCase()) return fail(res, 400, 'That is you.');
        const mine = store.relation(me.username, rec.username);
        if (mine?.state === 'accepted') return fail(res, 409, 'Already connected.');
        if (mine?.state === 'out') return fail(res, 409, 'Request already sent.');

        const accepted = mine?.state === 'in';
        store.setRelation(me.username, rec.username, accepted ? 'accepted' : 'out');
        store.setRelation(rec.username, me.username, accepted ? 'accepted' : 'in');
        if (accepted) {
          const payload = { t: 'contact-accepted', user: publicUser(me, presence) };
          sendTo(rec.username, payload);
          sendTo(me.username, { t: 'contact-accepted', user: publicUser(rec, presence) });
        } else {
          sendTo(rec.username, { t: 'contact-request', user: publicUser(me, presence) });
        }
        return json(res, 200, bootstrap(me.username));
      }

      if (route === '/api/contacts/accept' && req.method === 'POST') {
        const body = await readJson(req);
        const rec = store.user(body.username);
        if (!rec) return fail(res, 404, 'No goat by that name.');
        const mine = store.relation(me.username, rec.username);
        if (!mine || (mine.state !== 'in' && mine.state !== 'accepted')) return fail(res, 409, 'No pending request.');
        store.setRelation(me.username, rec.username, 'accepted');
        store.setRelation(rec.username, me.username, 'accepted');
        sendTo(rec.username, { t: 'contact-accepted', user: publicUser(me, presence) });
        sendTo(me.username, { t: 'contact-accepted', user: publicUser(rec, presence) });
        return json(res, 200, bootstrap(me.username));
      }

      if (route === '/api/contacts' && req.method === 'DELETE') {
        const peer = String(url.searchParams.get('username') || '').trim();
        const rec = store.user(peer);
        if (!rec) return fail(res, 404, 'No goat by that name.');
        store.dropRelation(me.username, rec.username);
        store.dropRelation(rec.username, me.username);
        sendTo(rec.username, { t: 'contact-removed', user: me.username });
        return json(res, 200, bootstrap(me.username));
      }

      if (route === '/api/messages' && req.method === 'GET') {
        const peer = String(url.searchParams.get('username') || '').trim();
        const after = Number(url.searchParams.get('after') || 0);
        if (!store.user(peer)) return fail(res, 404, 'No goat by that name.');
        if (!pairAccepted(me.username, peer)) return fail(res, 403, 'Not connected.');
        return json(res, 200, { messages: await store.messagesBetween(me.username, peer, after) });
      }

      // Group chats. Membership is plain server state; content is still
      // end-to-end encrypted, sealed per member over pairwise ratchets.
      if (route === '/api/groups' && req.method === 'POST') {
        const body = await readJson(req);
        const name = String(body.name || '').trim().slice(0, 60);
        if (!name) return fail(res, 400, 'Give the group a name.');
        const requested = Array.isArray(body.members) ? body.members.map(String).filter(Boolean) : [];
        if (requested.length + 1 > 31) return fail(res, 400, 'Groups hold up to 31+1 goats.');
        const members = new Set([me.username.toLowerCase()]);
        for (const candidate of requested) {
          const rec = store.user(candidate);
          if (!rec) return fail(res, 404, `No goat by the name ${candidate}.`);
          members.add(rec.username.toLowerCase());
        }
        const group = store.createGroup({
          id: `g${crypto.randomBytes(8).toString('hex')}`,
          name,
          owner: me.username,
          members: [...members],
        });
        const wire = { t: 'group', group: publicGroup(group) };
        for (const member of group.members) sendTo(member, wire);
        return json(res, 200, { group: publicGroup(group) });
      }

      if (route === '/api/groups' && req.method === 'GET') {
        return json(res, 200, { groups: store.groupsOf(me.username).map(publicGroup) });
      }

      const leaveMatch = route.match(/^\/api\/groups\/(gh?[0-9a-f]+)\/leave$/);
      if (leaveMatch && req.method === 'POST') {
        const gid = leaveMatch[1];
        const rec = store.getGroup(gid);
        if (!rec || !rec.members.includes(me.username.toLowerCase())) return fail(res, 404, 'No such group.');
        const next = store.leaveGroup(gid, me.username);
        for (const member of next ? next.members : []) sendTo(member, { t: 'group', group: publicGroup(next) });
        return json(res, 200, { ok: true, group: next ? publicGroup(next) : null });
      }

      if (route === '/api/messages' && req.method === 'POST') {
        const body = await readJson(req);
        const peer = String(body.to || '').trim();
        const rec = store.user(peer);
        if (!rec) return fail(res, 404, 'No goat by that name.');
        const gid = typeof body.gid === 'string' ? body.gid : '';
        if (gid) {
          // Group delivery: sender and recipient must be in that group.
          const groupRec = store.getGroup(gid);
          if (!groupRec || !groupRec.members.includes(me.username.toLowerCase())
            || !groupRec.members.includes(rec.username.toLowerCase())) {
            return fail(res, 403, 'Not in that group.');
          }
        } else if (!pairAccepted(me.username, peer)) {
          return fail(res, 403, 'Not connected.');
        }
        const env = body.env;
        if (!env || typeof env !== 'object' || typeof env.ct !== 'string' || !env.header) {
          return fail(res, 400, 'Malformed envelope.');
        }
        const msg = store.pushMessage({
          from: me.username, to: rec.username, env, clientId: body.clientId,
        });
        const wire = { t: 'message', msg };
        sendTo(rec.username, wire);
        if (rec.username !== me.username) sendTo(me.username, wire);
        return json(res, 200, { msg });
      }

      if (route === '/api/upload' && req.method === 'POST') {
        const limit = store.mode === 'kv' ? KV_MAX_UPLOAD : MAX_UPLOAD;
        const buf = await readBody(req, limit);
        if (!buf.length) return fail(res, 400, 'Empty file.');
        const id = crypto.randomBytes(16).toString('hex');
        const rec = {
          id,
          owner: me.username.toLowerCase(),
          name: String(req.headers['x-file-name'] || 'file').slice(0, 120),
          mime: String(req.headers['x-file-type'] || 'application/octet-stream').slice(0, 100),
          size: buf.length,
          ts: Date.now(),
        };
        if (store.mode === 'kv') {
          await store.putBlob(id, buf); // attachments live in the storage engine
        } else {
          const target = path.join(filesDir, `${id}.bin`);
          fs.writeFileSync(target, buf);
          rec.path = target;
        }
        store.addFile(rec);
        return json(res, 200, { id, size: rec.size });
      }

      if (route.startsWith('/api/file/') && req.method === 'GET') {
        const rec = store.getFile(url.pathname.split('/').pop());
        if (!rec) return fail(res, 404, 'No such file.');
        const owner = rec.owner;
        const allowed = owner === me.username.toLowerCase()
          || pairAccepted(me.username, owner)
          || store.shareGroup(me.username, owner);
        if (!allowed) return fail(res, 403, 'Not allowed.');
        const fileHeaders = {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Access-Control-Allow-Origin': '*',
        };
        if (store.mode === 'kv') {
          const bytes = await store.getBlob(rec.id);
          if (!bytes) return fail(res, 410, 'File expired.');
          res.writeHead(200, { ...fileHeaders, 'Content-Length': bytes.length });
          return res.end(bytes);
        }
        if (!fs.existsSync(rec.path)) return fail(res, 410, 'File expired.');
        res.writeHead(200, { ...fileHeaders, 'Content-Length': rec.size });
        return fs.createReadStream(rec.path).pipe(res);
      }

      return fail(res, 404, 'Unknown route.');
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[http]', err);
      return fail(res, status, status >= 500 ? 'Server error.' : err.message);
    }
  }

  const server = tls ? https.createServer(tls, handleRequest) : http.createServer(handleRequest);
  // Node drops idle keep-alive sockets after 5s by default. A client that
  // stalls (a slow proof-of-work solve, a laptop waking up, a tunnel hiccup)
  // then reuses a socket the relay is already closing and sees a reset, so
  // give idle connections a generous window instead.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;

  const turnServer = turn
    ? createTurnServer({
      port: Number(turn.port || 3478),
      host: turn.host || '0.0.0.0',
      publicIp: turn.publicIp || null,
      realm: turn.realm || 'goatmessenger',
      user: turn.user || 'goat',
      pass: turn.pass || 'goat-turn',
      verbose: Boolean(turn.verbose),
      id: turn.id || 'relay-embedded',
    })
    : null;

  /* --------------------------------------------------------------- websocket - */

  const wss = new WebSocketServer({ server, path: '/ws' });
  // ws forwards http server errors; without a handler a busy port would crash
  // the host process instead of being reported to our caller.
  wss.on('error', (err) => {
    if (err && err.code !== 'EADDRINUSE') console.error('[ws]', err.message);
  });
  const calls = new Map(); // callId -> { from, to, kind, startedAt }

  wss.on('connection', async (ws, req) => {
    await boot();
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const session = store.session(token);
    if (!session || !store.user(session.user)) {
      ws.close(4001, 'unauthorized');
      return;
    }
    const me = store.user(session.user);
    const name = me.username.toLowerCase();
    ws.me = name;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    if (!sockets.has(name)) sockets.set(name, new Set());
    sockets.get(name).add(ws);

    ws.send(JSON.stringify({ t: 'ready', me: publicUser(store.user(name), presence) }));
    if (sockets.get(name).size === 1) {
      broadcastToContacts(name, { t: 'presence', user: name, online: true });
    }
    // tell the new socket who is already around
    const online = [];
    for (const rel of store.contactsOf(name)) {
      if (rel.state === 'accepted' && presence(rel.peer)) online.push(rel.peer);
    }
    ws.send(JSON.stringify({ t: 'presence-list', online }));

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;

      try {
        const peerName = String(msg.to || '').trim();
        const peerRec = store.user(peerName);
        const related = peerRec && pairAccepted(me.username, peerRec.username);

        if (msg.t === 'typing') {
          if (!related) return;
          sendTo(peerRec.username, { t: 'typing', from: me.username, on: Boolean(msg.on) });
          return;
        }

        if (msg.t === 'read') {
          if (!related) return;
          sendTo(peerRec.username, {
            t: 'read', from: me.username, upTo: Number(msg.upTo) || 0, ids: Array.isArray(msg.ids) ? msg.ids.slice(0, 50) : [],
          });
          return;
        }

        if (msg.t === 'call') {
          if (!related) {
            ws.send(JSON.stringify({ t: 'call-error', callId: msg.callId, reason: 'Not connected.' }));
            return;
          }
          const action = String(msg.action || '');
          const callId = String(msg.callId || '').slice(0, 64);
          if (!callId) return;

          if (action === 'invite') {
            if (calls.has(callId)) return;
            calls.set(callId, {
              from: me.username, to: peerRec.username, kind: msg.kind === 'video' ? 'video' : 'audio', startedAt: Date.now(),
            });
            sendTo(peerRec.username, {
              t: 'call', action: 'invite', callId, from: me.username, kind: calls.get(callId).kind,
              ep: String(msg.ep || '').slice(0, 200), epSig: String(msg.epSig || '').slice(0, 200),
              displayName: publicUser(me, presence).displayName,
            });
            return;
          }

          const call = calls.get(callId);
          if (!call) {
            ws.send(JSON.stringify({ t: 'call-error', callId, reason: 'Call is no longer active.' }));
            return;
          }
          const participant = call.from === me.username || call.to === me.username;
          const target = call.from === me.username ? call.to : call.from;
          if (!participant) return;
          const allowed = ['ring', 'accept', 'decline', 'cancel', 'hangup', 'signal'];
          if (!allowed.includes(action)) return;
          sendTo(target, {
            t: 'call', action, callId, from: me.username,
            ep: msg.ep ? String(msg.ep).slice(0, 200) : undefined,
            epSig: msg.epSig ? String(msg.epSig).slice(0, 200) : undefined,
            blob: msg.blob ? String(msg.blob).slice(0, 400000) : undefined,
            kind: call.kind,
          });
          if (['decline', 'cancel', 'hangup'].includes(action)) calls.delete(callId);
          return;
        }

        if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: Date.now() }));
      } catch (err) {
        console.error('[ws]', err);
      }
    });

    ws.on('close', () => {
      const set = sockets.get(name);
      if (set) {
        set.delete(ws);
        if (!set.size) {
          sockets.delete(name);
          broadcastToContacts(name, { t: 'presence', user: name, online: false });
        }
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
    // drop stale calls
    for (const [id, call] of calls) {
      if (Date.now() - call.startedAt > 1000 * 60 * 60) calls.delete(id);
    }
  }, 25000);

  const close = () => new Promise((resolve) => {
    clearInterval(heartbeat);
    if (turnServer) turnServer.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close(() => {
      // KV-backed stores flush their last writes asynchronously; resolve once
      // that settles (or soon after — shutdown budgets are tight).
      const done = Promise.resolve(store && store.close()).catch(() => {});
      done.then(resolve);
      const late = setTimeout(resolve, 4000);
      if (late.unref) late.unref();
    });
  });

  const listen = () => boot().then(() => new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('error', onError);
      // Stop spinning the TURN listener on a relay level bind failure or a
      // leaked listener would steal (and then never answer) UDP traffic.
      if (turnServer) {
        try { turnServer.close(); } catch {}
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, async () => {
      server.off('error', onError);
      if (turnServer) {
        try {
          turn.turnPort = await turnServer.listen().then((a) => a.port);
          console.log(`[turn] relay listening on udp ${turn.turnPort}`);
        } catch (err) {
          turn.turnPort = 0;
          console.error('[turn] failed to listen:', err.message);
          try { turnServer.close(); } catch {}
        }
      }
      resolve(server.address().port);
    });
  }));

  return {
    server, wss, store, listen, close, presence, dataDir, tls: Boolean(tls), host,
    turn: turnServer,
    turnStats: () => (turnServer ? turnServer.stats() : null),
  };
}

module.exports = { createGoatServer };

if (require.main === module) {
  const isDeno = typeof Deno !== 'undefined';
  // Deno Deploy fronts external HTTPS traffic; the listener must bind the
  // wildcard address and can pick its own port.
  const port = Number(process.env.PORT || (isDeno ? 8787 : 4040));
  const host = process.env.HOST || (isDeno ? '0.0.0.0' : '127.0.0.1');
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  let tls = null;
  if (process.env.TLS_CERT && process.env.TLS_KEY) {
    tls = {
      cert: fs.readFileSync(process.env.TLS_CERT),
      key: fs.readFileSync(process.env.TLS_KEY),
    };
  }
  const turn = process.env.TURN_PORT
    ? {
      id: 'relay-standalone',
      port: Number(process.env.TURN_PORT),
      publicIp: process.env.TURN_PUBLIC_IP || null,
      user: process.env.TURN_USER || 'goat',
      pass: process.env.TURN_PASS || 'goat-turn',
      realm: process.env.TURN_REALM || 'goatmessenger',
      statsToken: process.env.TURN_STATS_TOKEN || '',
      host: process.env.TURN_HOST || '0.0.0.0',
    }
    : null;
  const goat = createGoatServer({ port, dataDir, host, tls, turn });
  goat.listen().then((actual) => {
    const scheme = tls ? 'https' : 'http';
    const shown = host === '0.0.0.0' ? '<this-machine-ip>' : host;
    console.log(`[goatmessenger] relay listening on ${scheme}://${shown}:${actual}`);
    console.log(`[goatmessenger] data directory: ${dataDir}`);
    if (turn) {
      console.log(`[goatmessenger] TURN relay on udp ${turn.host}:${goat.turn?.port} (public ip ${turn.publicIp || 'auto'})`);
      console.log(`[goatmessenger] TURN credentials: ${turn.user} / ${turn.pass === 'goat-turn' ? 'goat-turn (default — change TURN_PASS to share publicly)' : '••••••'}`);
    }
    if (host === '0.0.0.0') {
      const nets = require('os').networkInterfaces();
      for (const list of Object.values(nets)) {
        for (const net of list || []) {
          if (net.family === 'IPv4' && !net.internal) {
            console.log(`[goatmessenger] reachable on your network at ${scheme}://${net.address}:${actual}`);
          }
        }
      }
    }
  }).catch((err) => {
    console.error('[goatmessenger] failed to start:', err);
    process.exit(1);
  });
  const bye = () => { goat.close().then(() => process.exit(0)); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
