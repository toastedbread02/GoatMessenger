// A small TURN server (RFC 5766 / RFC 5389), enough for WebRTC media.
//
// Why it exists: two machines on different continents are almost always behind
// NAT, so a peer-to-peer call cannot always form. TURN relays the *already
// encrypted* DTLS-SRTP packets — it forwards opaque UDP, it cannot decrypt or
// inspect media. Running your own means the relay is yours, not a stranger's.
//
// Supported: Binding, Allocate, Refresh, CreatePermission, ChannelBind, Send /
// Data indications, ChannelData, long-term credentials (MESSAGE-INTEGRITY),
// nonce + realm auth, allocation lifetime and expiry.
const dgram = require('dgram');
const crypto = require('crypto');

const MAGIC = 0x2112a442;
const DEFAULT_LIFETIME = 600;
const MAX_LIFETIME = 3600;

// Every attribute this server reads or writes.
const A = {
  MAPPED: 0x0001,
  USERNAME: 0x0006,
  INTEGRITY: 0x0008,
  ERROR: 0x0009,
  UNKNOWN: 0x000a,
  CHANNEL: 0x000b,
  LIFETIME: 0x000d,
  XOR_PEER: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED: 0x0016,
  REQUESTED_FAMILY: 0x0017,
  EVEN_PORT: 0x0018,
  REQUESTED_TRANSPORT: 0x0019,
  DONT_FRAGMENT: 0x001a,
  SOFTWARE: 0x8022,
  FINGERPRINT: 0x8028,
  XOR_MAPPED: 0x0020,
};

/* ---------------------------------------------------------------- stun codec */

// Class: 0 request, 1 indication, 2 success, 3 error.
function msgType(method, cls) {
  return (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2)
    | ((cls & 0x2) << 7) | ((cls & 0x1) << 4);
}

const METHOD = {
  BINDING: 0x001,
  ALLOCATE: 0x003,
  REFRESH: 0x004,
  SEND: 0x006,
  DATA: 0x007,
  CREATE_PERMISSION: 0x008,
  CHANNEL_BIND: 0x009,
};

const T = {
  BINDING_REQUEST: msgType(METHOD.BINDING, 0),
  BINDING_SUCCESS: msgType(METHOD.BINDING, 2),
  ALLOCATE_REQUEST: msgType(METHOD.ALLOCATE, 0),
  ALLOCATE_SUCCESS: msgType(METHOD.ALLOCATE, 2),
  REFRESH_REQUEST: msgType(METHOD.REFRESH, 0),
  REFRESH_SUCCESS: msgType(METHOD.REFRESH, 2),
  SEND_INDICATION: msgType(METHOD.SEND, 1),
  DATA_INDICATION: msgType(METHOD.DATA, 1),
  CREATE_PERMISSION_REQUEST: msgType(METHOD.CREATE_PERMISSION, 0),
  CREATE_PERMISSION_SUCCESS: msgType(METHOD.CREATE_PERMISSION, 2),
  CHANNEL_BIND_REQUEST: msgType(METHOD.CHANNEL_BIND, 0),
  CHANNEL_BIND_SUCCESS: msgType(METHOD.CHANNEL_BIND, 2),
};

function methodOf(type) {
  return (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2);
}
function classOf(type) {
  return ((type >> 7) & 0x2) | ((type >> 4) & 0x1);
}

function parse(buf) {
  if (buf.length < 20) return null;
  if (buf.readUInt16BE(0) & 0xc000) return null; // not a STUN message
  if (buf.readUInt32BE(4) !== MAGIC) return null;
  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  const txid = buf.subarray(8, 20);
  const attrs = [];
  let offset = 20;
  const end = Math.min(buf.length, 20 + length);
  while (offset + 4 <= end) {
    const kind = buf.readUInt16BE(offset);
    const len = buf.readUInt16BE(offset + 2);
    const value = buf.subarray(offset + 4, offset + 4 + len);
    attrs.push({ type: kind, value, offset });
    offset += 4 + len + ((4 - (len % 4)) % 4);
  }
  return { type, method: methodOf(type), cls: classOf(type), txid, attrs };
}

function attr(parsed, type) {
  return parsed.attrs.find((a) => a.type === type) || null;
}

function pad4(n) { return (4 - (n % 4)) % 4; }

function encodeAttrs(list) {
  const parts = [];
  for (const { type, value } of list) {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(value.length, 2);
    parts.push(head, value, Buffer.alloc(pad4(value.length)));
  }
  return Buffer.concat(parts);
}

function header(type, length, txid) {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(type, 0);
  buf.writeUInt16BE(length, 2);
  buf.writeUInt32BE(MAGIC, 4);
  txid.copy(buf, 8);
  return buf;
}

function xorAddress(ip, port, txid) {
  const fam = ip.includes(':') ? 0x02 : 0x01;
  const buf = Buffer.alloc(fam === 0x02 ? 20 : 8);
  buf.writeUInt8(0, 0);
  buf.writeUInt8(fam, 1);
  buf.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const mask = Buffer.alloc(16);
  mask.writeUInt32BE(MAGIC, 0);
  txid.copy(mask, 4);
  if (fam === 0x01) {
    ip.split('.').forEach((oct, i) => buf.writeUInt8(Number(oct) ^ mask[i], 4 + i));
  } else {
    // not needed for IPv4 deployments; keep the code honest rather than wrong
    const bytes = ipv6Bytes(ip);
    for (let i = 0; i < 16; i++) buf.writeUInt8(bytes[i] ^ mask[i], 4 + i);
  }
  return buf;
}

function ipv6Bytes(ip) {
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  const out = Buffer.alloc(16);
  groups.slice(0, 8).forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return out;
}

function decodeAddress(value) {
  if (value.length < 8) return null;
  const fam = value.readUInt8(1);
  const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
  if (fam !== 0x01) return null;
  const mask = Buffer.alloc(4);
  mask.writeUInt32BE(MAGIC, 0);
  const ip = [0, 1, 2, 3].map((i) => value.readUInt8(4 + i) ^ mask[i]).join('.');
  return { ip, port };
}

function errorAttr(code, reason) {
  const buf = Buffer.alloc(4 + reason.length);
  buf.writeUInt16BE(0, 0);
  buf.writeUInt8(code / 100, 2);
  buf.writeUInt8(code % 100, 3);
  buf.write(reason, 4, 'utf8');
  return buf;
}

const longTermKey = (username, realm, password) =>
  crypto.createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest();

// HMAC over the message with its header length covering the integrity attribute.
function integrity(buf, key, miOffset) {
  const copy = Buffer.from(buf.subarray(0, miOffset));
  copy.writeUInt16BE(miOffset - 20 + 24, 2);
  return crypto.createHmac('sha1', key).update(copy).digest();
}

function verifyIntegrity(buf, parsed, key) {
  const mi = attr(parsed, A.INTEGRITY);
  if (!mi) return false;
  const expected = integrity(buf, key, mi.offset);
  return expected.length === mi.value.length && crypto.timingSafeEqual(expected, mi.value);
}

// CRC-32 (IEEE), for the STUN FINGERPRINT attribute. Chromium's ICE stack
// drops responses that carry no fingerprint, so every reply gets one.
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function withFingerprint(type, txid, body) {
  const head = header(type, body.length + 8, txid);
  const crc = (crc32(Buffer.concat([head, body])) ^ 0x5354554e) >>> 0;
  const fp = Buffer.alloc(8);
  fp.writeUInt16BE(A.FINGERPRINT, 0);
  fp.writeUInt16BE(4, 2);
  fp.writeUInt32BE(crc, 4);
  return Buffer.concat([header(type, body.length + 8, txid), body, fp]);
}

function build({ type, txid, attrs, key }) {
  let body = encodeAttrs(attrs);
  if (key) {
    const withLen = header(type, body.length + 24, txid);
    const mac = integrity(Buffer.concat([withLen, body]), key, 20 + body.length);
    body = Buffer.concat([body, encodeAttrs([{ type: A.INTEGRITY, value: mac }])]);
  }
  return withFingerprint(type, txid, body);
}

/* ------------------------------------------------------------------- server */

function createTurnServer({
  port = 3478,
  host = '0.0.0.0',
  publicIp = null,
  realm = 'goatmessenger',
  user = 'goat',
  pass = 'goat-turn',
  verbose = false,
  id = 'turn',
} = {}) {
  // One socket per local IPv4 address, all on the same port. Chromium binds an
  // ICE socket to a specific interface and discards replies whose source
  // address differs from the server it dialled, so replying from a wildcard
  // socket silently breaks on multi-homed machines. Binding the exact address
  // that received the request guarantees the reply looks right.
  const sockets = new Map(); // local address -> dgram socket
  let boundPort = port;
  const allocations = new Map(); // `${addr}:${port}` -> allocation
  const nonces = new Map();      // nonce -> expiresAt
  const stats = state();
  const log = verbose ? (...args) => console.log(`[turn:${id}]`, ...args) : () => {};

  function state() {
    return { allocations: 0, channels: 0, allocationsTotal: 0, bytesRelayed: 0, packetsRelayed: 0, requests: 0, denied: 0 };
  }

  const credentials = new Map([[String(user), String(pass)]]);
  const now = () => Date.now();

  function keyFor(parsed) {
    const username = attr(parsed, A.USERNAME);
    if (!username) return null;
    const name = username.value.toString('utf8');
    const password = credentials.get(name);
    if (!password) return null;
    return { username: name, key: longTermKey(name, realm, password) };
  }

  function issueNonce() {
    const nonce = crypto.randomBytes(12).toString('hex');
    nonces.set(nonce, now() + 3600 * 1000);
    return nonce;
  }

  function authChallenge(parsed, reply) {
    const nonce = issueNonce();
    reply(build({
      type: msgType(parsed.method, 3),
      txid: parsed.txid,
      attrs: [
        { type: A.ERROR, value: errorAttr(401, 'Unauthorized') },
        { type: A.REALM, value: Buffer.from(realm, 'utf8') },
        { type: A.NONCE, value: Buffer.from(nonce, 'utf8') },
        { type: A.SOFTWARE, value: Buffer.from('GoatMessenger TURN', 'utf8') },
      ],
    }));
  }

  // Returns the credential key, or null after sending the appropriate error.
  function authorize(buf, parsed, reply) {
    if (classOf(parsed.type) === 1) return null; // indications carry no integrity
    const nonceAttr = attr(parsed, A.NONCE);
    const realmAttr = attr(parsed, A.REALM);
    const cred = keyFor(parsed);
    if (!cred || !realmAttr || !nonceAttr) {
      authChallenge(parsed, reply);
      return null;
    }
    const nonce = nonceAttr.value.toString('utf8');
    const expires = nonces.get(nonce);
    if (!expires || expires < now()) {
      authChallenge(parsed, reply);
      return null;
    }
    if (!verifyIntegrity(buf, parsed, cred.key)) {
      stats.denied++;
      reply(build({
        type: msgType(parsed.method, 3),
        txid: parsed.txid,
        attrs: [{ type: A.ERROR, value: errorAttr(401, 'Unauthorized') }],
      }));
      return null;
    }
    return cred;
  }

  const allocKey = (addr, p) => `${addr}:${p}`;

  function closeAllocation(alloc) {
    if (!alloc) return;
    allocations.delete(alloc.key);
    stats.allocations = allocations.size;
    stats.channels = [...allocations.values()].reduce((n, a) => n + a.channels.size, 0);
    try { alloc.relay.close(); } catch {}
    log('allocation closed', alloc.key);
  }

  function replyTo(ctx, buf) {
    if (!ctx.socket) return;
    ctx.socket.send(buf, ctx.rinfo.port, ctx.rinfo.address, () => {});
  }

  function handleBinding(ctx, parsed) {
    const { rinfo } = ctx;
    const attrs = [
      { type: A.XOR_MAPPED, value: xorAddress(rinfo.address, rinfo.port, parsed.txid) },
      { type: A.MAPPED, value: mappedAddress(rinfo.address, rinfo.port) },
      { type: A.SOFTWARE, value: Buffer.from('GoatMessenger TURN', 'utf8') },
    ];
    replyTo(ctx, build({ type: T.BINDING_SUCCESS, txid: parsed.txid, attrs }));
  }

  function mappedAddress(ip, p) {
    const buf = Buffer.alloc(8);
    buf.writeUInt8(0, 0);
    buf.writeUInt8(0x01, 1);
    buf.writeUInt16BE(p, 2);
    ip.split('.').forEach((oct, i) => buf.writeUInt8(Number(oct), 4 + i));
    return buf;
  }

  function makeAllocation(ctx, txid, key, lifetime) {
    const { rinfo } = ctx;
    const alloc = {
      key: allocKey(rinfo.address, rinfo.port),
      clientAddr: rinfo.address,
      clientPort: rinfo.port,
      socket: ctx.socket,
      relay: dgram.createSocket('udp4'),
      relayPort: 0,
      permissions: new Map(), // ip -> expiresAt
      channels: new Map(),    // channel -> {ip, port, expiresAt}
      expiresAt: now() + lifetime * 1000,
      lifetime,
      username: key.username,
    };
    alloc.relay.on('message', (data, from) => onRelayed(alloc, data, from));
    alloc.relay.on('error', () => {});
    return alloc;
  }

  // Peer -> TURN: wrap in ChannelData if a channel is bound, else Data Indication.
  function onRelayed(alloc, data, from) {
    if (alloc.expiresAt < now()) return closeAllocation(alloc);
    const perm = alloc.permissions.get(from.address);
    if (!perm || perm < now()) return;
    let channel = 0;
    for (const [num, binding] of alloc.channels) {
      if (binding.ip === from.address && binding.port === from.port) { channel = num; break; }
    }
    if (channel) {
      const head = Buffer.alloc(4);
      head.writeUInt16BE(channel, 0);
      head.writeUInt16BE(data.length, 2);
      sendToClient(alloc, Buffer.concat([head, data]));
    } else {
      const txid = crypto.randomBytes(12);
      const msg = build({
        type: T.DATA_INDICATION,
        txid,
        attrs: [
          { type: A.XOR_PEER, value: xorAddress(from.address, from.port, txid) },
          { type: A.DATA, value: data },
        ],
      });
      sendToClient(alloc, msg);
    }
    stats.bytesRelayed += data.length;
    stats.packetsRelayed++;
  }

  function sendToClient(alloc, buf) {
    const sock = alloc.socket;
    if (sock) sock.send(buf, alloc.clientPort, alloc.clientAddr, () => {});
  }

  function relayFor(alloc, peer) {
    const perm = alloc.permissions.get(peer.ip);
    if (!perm || perm < now()) return false;
    alloc.relay.send(peer.data, peer.port, peer.ip, () => {});
    stats.bytesRelayed += peer.data.length;
    stats.packetsRelayed++;
    return true;
  }

  function onMessage(ctx, buf) {
    const { rinfo } = ctx;
    if (buf.length >= 4 && (buf.readUInt16BE(0) & 0xc000) === 0x4000) {
      // ChannelData from the client
      const channel = buf.readUInt16BE(0);
      const len = buf.readUInt16BE(2);
      const alloc = allocations.get(allocKey(rinfo.address, rinfo.port));
      if (!alloc) return;
      const binding = alloc.channels.get(channel);
      if (!binding) return;
      relayFor(alloc, { ip: binding.ip, port: binding.port, data: buf.subarray(4, 4 + len) });
      return;
    }

    const parsed = parse(buf);
    if (!parsed) return;
    stats.requests++;
    const reply = (out) => replyTo(ctx, out);
    if (verbose) {
      log('in', 'method', parsed.method.toString(16), 'class', parsed.cls,
        'attrs', parsed.attrs.map((a) => a.type.toString(16)).join(','),
        'from', `${rinfo.address}:${rinfo.port}`, 'to', `${ctx.socket.address().address}:${ctx.socket.address().port}`);
    }

    if (parsed.method === METHOD.BINDING && parsed.cls === 0) {
      return handleBinding(ctx, parsed);
    }

    const key = authorize(buf, parsed, reply);
    if (!key && parsed.cls !== 1) return;

    const existing = allocations.get(allocKey(rinfo.address, rinfo.port));
    const lifetimeAttr = attr(parsed, A.LIFETIME);
    const requested = lifetimeAttr ? lifetimeAttr.value.readUInt32BE(0) : DEFAULT_LIFETIME;

    if (parsed.method === METHOD.ALLOCATE && parsed.cls === 0) {
      if (existing) {
        return reply(build({
          type: msgType(METHOD.ALLOCATE, 3),
          txid: parsed.txid,
          attrs: [{ type: A.ERROR, value: errorAttr(437, 'Allocation Mismatch') }],
          key: key.key,
        }));
      }
      const transport = attr(parsed, A.REQUESTED_TRANSPORT);
      if (!transport || transport.value.readUInt8(0) !== 17) {
        return reply(build({
          type: msgType(METHOD.ALLOCATE, 3),
          txid: parsed.txid,
          attrs: [{ type: A.ERROR, value: errorAttr(442, 'Unsupported Transport Protocol') }],
          key: key.key,
        }));
      }
      const lifetime = Math.min(MAX_LIFETIME, Math.max(60, requested || DEFAULT_LIFETIME));
      const alloc = makeAllocation(ctx, parsed.txid, key, lifetime);
      alloc.relay.bind(0, '0.0.0.0', () => {
        alloc.relayPort = alloc.relay.address().port;
        allocations.set(alloc.key, alloc);
        stats.allocations = allocations.size;
        stats.allocationsTotal++;
        log('allocation', alloc.key, 'relay port', alloc.relayPort, 'lifetime', lifetime);
        reply(build({
          type: T.ALLOCATE_SUCCESS,
          txid: parsed.txid,
          key: key.key,
          attrs: [
            { type: A.XOR_RELAYED, value: xorAddress(publicIp || rinfo.address, alloc.relayPort, parsed.txid) },
            { type: A.LIFETIME, value: lifetimeBuf(lifetime) },
            { type: A.XOR_MAPPED, value: xorAddress(rinfo.address, rinfo.port, parsed.txid) },
            { type: A.SOFTWARE, value: Buffer.from('GoatMessenger TURN', 'utf8') },
          ],
        }));
      });
      return;
    }

    if (parsed.method === METHOD.REFRESH) {
      if (!existing) {
        return reply(build({
          type: msgType(METHOD.REFRESH, 3),
          txid: parsed.txid,
          attrs: [{ type: A.ERROR, value: errorAttr(437, 'Allocation Mismatch') }],
          key: key?.key,
        }));
      }
      if (requested === 0) {
        closeAllocation(existing);
        return reply(build({
          type: T.REFRESH_SUCCESS,
          txid: parsed.txid,
          key: key.key,
          attrs: [{ type: A.LIFETIME, value: lifetimeBuf(0) }],
        }));
      }
      existing.lifetime = Math.min(MAX_LIFETIME, Math.max(60, requested));
      existing.expiresAt = now() + existing.lifetime * 1000;
      return reply(build({
        type: T.REFRESH_SUCCESS,
        txid: parsed.txid,
        key: key.key,
        attrs: [{ type: A.LIFETIME, value: lifetimeBuf(existing.lifetime) }],
      }));
    }

    if (parsed.method === METHOD.CREATE_PERMISSION) {
      if (!existing) {
        return reply(build({
          type: msgType(METHOD.CREATE_PERMISSION, 3),
          txid: parsed.txid,
          attrs: [{ type: A.ERROR, value: errorAttr(437, 'Allocation Mismatch') }],
          key: key?.key,
        }));
      }
      for (const a of parsed.attrs) {
        if (a.type !== A.XOR_PEER) continue;
        const peer = decodeAddress(a.value);
        if (peer) existing.permissions.set(peer.ip, now() + 300 * 1000);
      }
      return reply(build({
        type: T.CREATE_PERMISSION_SUCCESS,
        txid: parsed.txid,
        key: key.key,
        attrs: [],
      }));
    }

    if (parsed.method === METHOD.CHANNEL_BIND) {
      if (!existing) return;
      const chAttr = attr(parsed, A.CHANNEL);
      const peerAttr = attr(parsed, A.XOR_PEER);
      if (!chAttr || !peerAttr) return;
      const channel = chAttr.value.readUInt16BE(0);
      const peer = decodeAddress(peerAttr.value);
      if (!peer || channel < 0x4000 || channel > 0x7fff) {
        return reply(build({
          type: msgType(METHOD.CHANNEL_BIND, 3),
          txid: parsed.txid,
          attrs: [{ type: A.ERROR, value: errorAttr(400, 'Bad Request') }],
          key: key.key,
        }));
      }
      existing.permissions.set(peer.ip, now() + 300 * 1000);
      for (const [num, binding] of existing.channels) {
        if (binding.ip === peer.ip && binding.port === peer.port) existing.channels.delete(num);
      }
      existing.channels.set(channel, { ip: peer.ip, port: peer.port, expiresAt: now() + 600 * 1000 });
      stats.channels = [...allocations.values()].reduce((n, a) => n + a.channels.size, 0);
      return reply(build({
        type: T.CHANNEL_BIND_SUCCESS,
        txid: parsed.txid,
        key: key.key,
        attrs: [],
      }));
    }

    if (parsed.method === METHOD.SEND) {
      if (!existing) return;
      const dataAttr = attr(parsed, A.DATA);
      const peerAttr = attr(parsed, A.XOR_PEER);
      if (!dataAttr || !peerAttr) return;
      const peer = decodeAddress(peerAttr.value);
      if (!peer) return;
      relayFor(existing, { ip: peer.ip, port: peer.port, data: dataAttr.value });
      return;
    }

    // Anything else (e.g. TURN-TCP allocate from a UDP socket) gets a clean 400.
    if (parsed.cls === 0) {
      reply(build({
        type: msgType(parsed.method, 3),
        txid: parsed.txid,
        attrs: [{ type: A.ERROR, value: errorAttr(400, 'Bad Request') }],
        key: key?.key,
      }));
    }
  }

  function lifetimeBuf(seconds) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(seconds, 0);
    return b;
  }

  function bindSocket(address) {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('message', (buf, rinfo) => onMessage({ socket: sock, rinfo }, buf));
      sock.on('error', (err) => {
        if (verbose) console.error('[turn] socket error:', address, err.message);
      });
      const finish = () => resolve(sock);
      sock.once('error', () => resolve(null));
      sock.bind(boundPort, address, () => {
        if (!boundPort) boundPort = sock.address().port;
        resolve(sock);
      });
      setTimeout(() => resolve(sock.address() ? sock : null), 3000);
    });
  }

  function localAddresses() {
    if (host && host !== '0.0.0.0') return [host];
    const out = new Set(['127.0.0.1']);
    const nets = require('os').networkInterfaces();
    for (const list of Object.values(nets)) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) out.add(net.address);
      }
    }
    return [...out];
  }

  // Pick up addresses that appear later (Wi-Fi joins, VPN connects).
  const refresh = setInterval(async () => {
    for (const address of localAddresses()) {
      if (sockets.has(address)) continue;
      const sock = await bindSocket(address);
      if (sock) {
        sockets.set(address, sock);
        log('bound', address, sock.address().port);
      }
    }
  }, 15000);
  refresh.unref?.();

  const sweeper = setInterval(() => {
    const t = now();
    if (verbose) log('stats', JSON.stringify({ ...stats, allocations: allocations.size }));
    for (const alloc of allocations.values()) {
      if (alloc.expiresAt < t) closeAllocation(alloc);
      for (const [ip, exp] of alloc.permissions) if (exp < t) alloc.permissions.delete(ip);
      for (const [num, ch] of alloc.channels) if (ch.expiresAt < t) alloc.channels.delete(num);
    }
    for (const [nonce, exp] of nonces) if (exp < t) nonces.delete(nonce);
  }, 30000);
  sweeper.unref?.();

  async function listen() {
    const addresses = localAddresses();
    // First socket owns the port (or picks a free one), the rest join it.
    const [first, ...rest] = addresses;
    const primary = await bindSocket(first);
    if (!primary) throw new Error(`TURN could not bind ${first}:${boundPort}`);
    sockets.set(first, primary);
    boundPort = primary.address().port;
    for (const address of rest) {
      const sock = await bindSocket(address);
      if (sock) sockets.set(address, sock);
    }
    log('listening on', [...sockets.keys()].join(','), 'port', boundPort);
    return { port: boundPort, host: [...sockets.keys()].join(',') };
  }

  function close() {
    clearInterval(sweeper);
    for (const alloc of [...allocations.values()]) closeAllocation(alloc);
    clearInterval(refresh);
    for (const sock of sockets.values()) {
      try { sock.close(); } catch {}
    }
    sockets.clear();
  }

  return {
    listen,
    close,
    stats: () => ({ ...stats, allocations: allocations.size, channels: [...allocations.values()].reduce((n, a) => n + a.channels.size, 0) }),
    // 0 until a socket actually bound, so callers never advertise a dead relay.
    get port() { return sockets.size ? boundPort : 0; },
    addresses: () => [...sockets.keys()],
    addUser: (name, password) => credentials.set(String(name), String(password)),
  };
}

module.exports = { createTurnServer };
