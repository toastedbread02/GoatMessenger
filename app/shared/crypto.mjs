// GoatMessenger end-to-end encryption core.
//
// Design
//   Identity ...... X25519 identity key (DH) + Ed25519 signing key (authenticates
//                   the signed prekey and call handshakes).
//   Session ....... X3DH (4-DH variant) -> Double Ratchet (Signal specification):
//                   one DH ratchet per message direction-change, symmetric chain
//                   per message, skipped-message keys for out-of-order delivery.
//   AEAD .......... AES-256-GCM with a key + nonce derived per message; the
//                   ratchet header is authenticated as additional data.
//   Calls ......... Each side publishes a fresh X25519 ephemeral key signed with
//                   its Ed25519 identity key; the call key is HKDF(ECDH, both
//                   ephemeral public keys). SDP/ICE travel encrypted under it.
//
// The server only ever sees public keys, ciphertext, and routing metadata.

import {
  x25519,
  ed25519,
  hkdf,
  hmac,
  sha256,
  scrypt,
  randomBytes,
} from '../vendor/noble.mjs';

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const PROTOCOL = 'goatmessenger/1';
const ZERO32 = new Uint8Array(32);
const MAX_SKIP = 1000;

/* ------------------------------------------------------------------ bytes -- */

export function b64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

export function b64d(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function concat(...parts) {
  const list = parts.filter((p) => p && p.length);
  const len = list.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of list) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* -------------------------------------------------------------------- KDFs -- */

function kdfX3DH(dhOutputs) {
  return hkdf(sha256, concat(...dhOutputs), ZERO32, te.encode('goatmessenger/x3dh/v1'), 32);
}

function kdfRoot(rootKey, dhOutput) {
  const okm = hkdf(sha256, dhOutput, rootKey, te.encode('goatmessenger/ratchet/v1'), 64);
  return [okm.slice(0, 32), okm.slice(32, 64)];
}

function kdfChain(chainKey) {
  return {
    messageKey: hmac(sha256, chainKey, new Uint8Array([0x01])),
    chainKey: hmac(sha256, chainKey, new Uint8Array([0x02])),
  };
}

function aeadMaterial(messageKey) {
  return {
    key: hkdf(sha256, messageKey, ZERO32, te.encode('goatmessenger/aead/key'), 32),
    nonce: hkdf(sha256, messageKey, ZERO32, te.encode('goatmessenger/aead/nonce'), 12),
  };
}

const headerAD = (h) => te.encode(`${PROTOCOL}|${h.dh}|${h.pn}|${h.n}`);

async function seal(key, nonce, plaintext, ad) {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: ad, tagLength: 128 }, k, plaintext);
  return new Uint8Array(ct);
}

async function open(key, nonce, ciphertext, ad) {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: ad, tagLength: 128 }, k, ciphertext);
  return new Uint8Array(pt);
}

/* ---------------------------------------------------------------- identity -- */

const dhKeypair = () => {
  const priv = randomBytes(32);
  return { priv, pub: x25519.getPublicKey(priv) };
};

/** Creates a fresh identity: signing key, identity key, signed prekey, one-time prekey. */
export function createIdentity() {
  const sigPriv = randomBytes(32);
  const ik = dhKeypair();
  const spk = dhKeypair();
  const opk = dhKeypair();
  const spkSig = ed25519.sign(spk.pub, sigPriv);
  return {
    // secret half — never leaves the device unencrypted
    sigPriv, ikPriv: ik.priv, spkPriv: spk.priv, opkPriv: opk.priv,
    // public half
    ikPub: ik.pub, sigPub: ed25519.getPublicKey(sigPriv), spkPub: spk.pub, opkPub: opk.pub, spkSig,
  };
}

/** The public bundle a peer needs in order to start a session with us. */
export function publicBundle(identity) {
  return {
    ik: b64(identity.ikPub),
    sig: b64(identity.sigPub),
    spk: b64(identity.spkPub),
    spkSig: b64(identity.spkSig),
    opk: identity.opkPub ? b64(identity.opkPub) : null,
  };
}

/** Rebuilds the secret half from a decrypted on-disk record. */
export function importIdentity(record) {
  return {
    sigPriv: b64d(record.sigPriv),
    ikPriv: b64d(record.ikPriv),
    spkPriv: b64d(record.spkPriv),
    opkPriv: record.opkPriv ? b64d(record.opkPriv) : null,
    ikPub: b64d(record.ikPub),
    sigPub: b64d(record.sigPub),
    spkPub: b64d(record.spkPub),
    opkPub: record.opkPub ? b64d(record.opkPub) : null,
    spkSig: b64d(record.spkSig),
  };
}

export function exportIdentity(identity) {
  return {
    sigPriv: b64(identity.sigPriv), ikPriv: b64(identity.ikPriv),
    spkPriv: b64(identity.spkPriv), opkPriv: identity.opkPriv ? b64(identity.opkPriv) : null,
    ikPub: b64(identity.ikPub), sigPub: b64(identity.sigPub),
    spkPub: b64(identity.spkPub), opkPub: identity.opkPub ? b64(identity.opkPub) : null,
    spkSig: b64(identity.spkSig),
  };
}

/** Verifies a peer's signed prekey. Throws if the bundle is forged. */
export function verifyBundle(bundle) {
  if (!bundle || !bundle.spk || !bundle.spkSig || !bundle.sig) throw new Error('incomplete key bundle');
  const ok = ed25519.verify(b64d(bundle.spkSig), b64d(bundle.spk), b64d(bundle.sig));
  if (!ok) throw new Error('signed prekey failed verification');
  return true;
}

/**
 * Safety number: a 60-digit fingerprint both parties can read to each other.
 * Stable regardless of which side computes it.
 */
export function safetyNumber(a, b) {
  const A = { ik: a.ik, sig: a.sig };
  const B = { ik: b.ik, sig: b.sig };
  const [first, second] = String(A.ik) < String(B.ik) ? [A, B] : [B, A];
  const digest = sha256(concat(
    te.encode('goatmessenger/safety/v1'),
    b64d(first.ik), b64d(first.sig),
    b64d(second.ik), b64d(second.sig),
  ));
  let digits = '';
  for (let i = 0; i < 12; i++) {
    const slice = sha256(concat(digest, new Uint8Array([i])));
    digits += (new DataView(slice.buffer).getUint32(0) % 100000).toString().padStart(5, '0');
  }
  return digits.match(/.{1,5}/g).join(' ');
}

/* ----------------------------------------------------------------- session -- */

function blankState() {
  return {
    rk: null,               // root key
    DHs: null,              // our ratchet keypair {priv,pub}
    DHr: null,              // their ratchet public key (b64)
    CKs: null,              // sending chain key
    CKr: null,              // receiving chain key
    Ns: 0, Nr: 0, PN: 0,
    skipped: {},            // "dhB64|n" -> b64 message key
    pendingPrekey: null,    // prekey header we must attach until we hear back
  };
}

/** Alice: X3DH from a verified peer bundle. */
export function initiatorSession(identity, bundle, { consumeOpk = true } = {}) {
  verifyBundle(bundle);
  const ek = dhKeypair();
  const dh1 = x25519.getSharedSecret(identity.ikPriv, b64d(bundle.spk));
  const dh2 = x25519.getSharedSecret(ek.priv, b64d(bundle.ik));
  const dh3 = x25519.getSharedSecret(ek.priv, b64d(bundle.spk));
  const dh4 = consumeOpk && bundle.opk ? x25519.getSharedSecret(ek.priv, b64d(bundle.opk)) : new Uint8Array(0);
  const sk = kdfX3DH([dh1, dh2, dh3, dh4]);

  const state = blankState();
  state.rk = sk;
  const ratchet = dhKeypair();
  state.DHs = ratchet;
  state.DHr = bundle.spk;
  [state.rk, state.CKs] = kdfRoot(state.rk, x25519.getSharedSecret(ratchet.priv, b64d(bundle.spk)));
  state.pendingPrekey = {
    ik: b64(identity.ikPub),
    ek: b64(ek.pub),
    usedOpk: Boolean(consumeOpk && bundle.opk),
  };
  return state;
}

/** Bob: X3DH from the prekey header attached to the peer's first message. */
export function responderSession(identity, prekey) {
  const ikA = b64d(prekey.ik);
  const ekA = b64d(prekey.ek);
  const dh1 = x25519.getSharedSecret(identity.spkPriv, ikA);
  const dh2 = x25519.getSharedSecret(identity.ikPriv, ekA);
  const dh3 = x25519.getSharedSecret(identity.spkPriv, ekA);
  const dh4 = prekey.usedOpk && identity.opkPriv ? x25519.getSharedSecret(identity.opkPriv, ekA) : new Uint8Array(0);
  const sk = kdfX3DH([dh1, dh2, dh3, dh4]);

  const state = blankState();
  state.rk = sk;
  state.DHs = { priv: identity.spkPriv, pub: identity.spkPub };
  return state;
}

/* ---- ratchet ------------------------------------------------------------- */

function skipMessageKeys(state, until) {
  if (state.Nr + MAX_SKIP < until) throw new Error('too many skipped messages');
  if (!state.CKr) {
    if (until !== 0) throw new Error('cannot skip without a receiving chain');
    return;
  }
  while (state.Nr < until) {
    const { messageKey, chainKey } = kdfChain(state.CKr);
    state.skipped[`${state.DHr}|${state.Nr}`] = b64(messageKey);
    state.CKr = chainKey;
    state.Nr++;
  }
  pruneSkipped(state);
}

function pruneSkipped(state) {
  const keys = Object.keys(state.skipped);
  if (keys.length <= MAX_SKIP / 2) return;
  for (const k of keys.slice(0, keys.length - MAX_SKIP / 2)) delete state.skipped[k];
}

function dhRatchet(state, remotePubB64) {
  state.PN = state.Ns;
  state.Ns = 0;
  state.Nr = 0;
  state.DHr = remotePubB64;
  const remote = b64d(remotePubB64);
  let pair = kdfRoot(state.rk, x25519.getSharedSecret(state.DHs.priv, remote));
  state.rk = pair[0];
  state.CKr = pair[1];
  state.DHs = dhKeypair();
  pair = kdfRoot(state.rk, x25519.getSharedSecret(state.DHs.priv, remote));
  state.rk = pair[0];
  state.CKs = pair[1];
}

/** Encrypts a JSON payload; returns the wire envelope. */
export async function encryptMessage(state, payload) {
  if (!state.CKs) throw new Error('no sending chain');
  const step = kdfChain(state.CKs);
  state.CKs = step.chainKey;
  const messageKey = step.messageKey;

  const header = { dh: b64(state.DHs.pub), pn: state.PN, n: state.Ns };
  state.Ns += 1;

  const { key, nonce } = aeadMaterial(messageKey);
  const ct = await seal(key, nonce, te.encode(JSON.stringify(payload)), headerAD(header));

  const envelope = { v: 1, header, ct: b64(ct) };
  if (state.pendingPrekey) {
    envelope.type = 'prekey';
    envelope.prekey = state.pendingPrekey;
  } else {
    envelope.type = 'msg';
  }
  return envelope;
}

/** Decrypts an envelope. Mutates `state`. Throws on tamper/replay. */
export async function decryptMessage(state, envelope) {
  if (!envelope || envelope.v !== 1) throw new Error('unsupported envelope');
  const header = envelope.header;
  if (!header || typeof header.n !== 'number') throw new Error('malformed header');

  const skippedKey = `${header.dh}|${header.n}`;
  if (state.skipped[skippedKey]) {
    const mk = b64d(state.skipped[skippedKey]);
    delete state.skipped[skippedKey];
    return decryptWith(mk, header, envelope.ct);
  }

  if (state.DHr !== header.dh) {
    skipMessageKeys(state, header.pn);
    dhRatchet(state, header.dh);
  }
  if (header.n < state.Nr) throw new Error('replayed or stale message');
  skipMessageKeys(state, header.n);

  const step = kdfChain(state.CKr);
  state.CKr = step.chainKey;
  state.Nr += 1;
  return decryptWith(step.messageKey, header, envelope.ct);
}

async function decryptWith(messageKey, header, ctB64) {
  const { key, nonce } = aeadMaterial(messageKey);
  const pt = await open(key, nonce, b64d(ctB64), headerAD(header));
  return JSON.parse(td.decode(pt));
}

/** Clear the prekey header once the peer has answered (they now know us). */
export function confirmSession(state) {
  state.pendingPrekey = null;
}

/* ------------------------------------------------------------ serialisation -- */

export function serializeSession(state) {
  const skipped = {};
  for (const [k, v] of Object.entries(state.skipped)) skipped[k] = typeof v === 'string' ? v : b64(v);
  return {
    rk: state.rk ? b64(state.rk) : null,
    DHs: state.DHs ? { priv: b64(state.DHs.priv), pub: b64(state.DHs.pub) } : null,
    DHr: state.DHr || null,
    CKs: state.CKs ? b64(state.CKs) : null,
    CKr: state.CKr ? b64(state.CKr) : null,
    Ns: state.Ns, Nr: state.Nr, PN: state.PN,
    skipped,
    pendingPrekey: state.pendingPrekey || null,
  };
}

export function deserializeSession(data) {
  if (!data) return null;
  const skipped = {};
  for (const [k, v] of Object.entries(data.skipped || {})) skipped[k] = b64d(v);
  return {
    rk: data.rk ? b64d(data.rk) : null,
    DHs: data.DHs ? { priv: b64d(data.DHs.priv), pub: b64d(data.DHs.pub) } : null,
    DHr: data.DHr || null,
    CKs: data.CKs ? b64d(data.CKs) : null,
    CKr: data.CKr ? b64d(data.CKr) : null,
    Ns: data.Ns | 0, Nr: data.Nr | 0, PN: data.PN | 0,
    skipped,
    pendingPrekey: data.pendingPrekey || null,
  };
}

/* ------------------------------------------------------------- call crypto -- */

export function createCallEphemeral() {
  const pair = dhKeypair();
  return { priv: b64(pair.priv), pub: b64(pair.pub) };
}

export function signCallEphemeral(identity, pubB64) {
  return b64(ed25519.sign(b64d(pubB64), identity.sigPriv));
}

export function verifyCallEphemeral(peerBundle, pubB64, sigB64) {
  return ed25519.verify(b64d(sigB64), b64d(pubB64), b64d(peerBundle.sig));
}

/**
 * Both sides derive the same key: HKDF over the ECDH of the two ephemerals,
 * with both public keys bound into the info string (prevents key-reuse tricks).
 */
export function deriveCallKey(myEphemeralPrivB64, peerEphemeralPubB64, epA, epB) {
  const shared = x25519.getSharedSecret(b64d(myEphemeralPrivB64), b64d(peerEphemeralPubB64));
  const bound = [epA, epB].sort().join('|');
  return hkdf(sha256, shared, ZERO32, te.encode(`goatmessenger/call/v1|${bound}`), 32);
}

/** Short displayable call security code (both sides see the same 6 digits). */
export function callSafetyCode(callKey) {
  const digest = sha256(concat(te.encode('goatmessenger/call/code'), callKey));
  return (new DataView(digest.buffer).getUint32(0) % 1000000).toString().padStart(6, '0');
}

export async function encryptSignal(callKey, payload) {
  const nonce = randomBytes(12);
  const ct = await seal(callKey, nonce, te.encode(JSON.stringify(payload)), te.encode('goatmessenger/call/signal'));
  return b64(concat(nonce, ct));
}

export async function decryptSignal(callKey, blob) {
  const raw = b64d(blob);
  const pt = await open(callKey, raw.slice(0, 12), raw.slice(12), te.encode('goatmessenger/call/signal'));
  return JSON.parse(td.decode(pt));
}

/* ------------------------------------------------------------------- files -- */

/** Encrypts arbitrary bytes with a fresh key. Returns the key + opaque blob. */
export async function encryptBytes(bytes) {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const ct = await seal(key, nonce, bytes, te.encode('goatmessenger/file/v1'));
  return { keyB64: b64(key), data: concat(nonce, ct) };
}

export async function decryptBytes(keyB64, data) {
  const raw = data instanceof Uint8Array ? data : b64d(data);
  return open(b64d(keyB64), raw.slice(0, 12), raw.slice(12), te.encode('goatmessenger/file/v1'));
}

/* ------------------------------------------------- passphrase / key backup -- */

const SCRYPT = { N: 16384, r: 8, p: 1, dkLen: 32 };

/**
 * Passphrase -> independent auth token and key-wrapping key. The server only
 * ever receives the auth token (and re-hashes it), so it cannot derive the
 * wrapping key that protects the identity backup.
 */
export function derivePassphraseKeys(passphrase, username) {
  const salt = sha256(te.encode(`goatmessenger/salt/v1|${username.trim().toLowerCase()}`));
  const master = scrypt(te.encode(passphrase.normalize('NFKC')), salt, SCRYPT);
  return {
    authToken: hex(hkdf(sha256, master, salt, te.encode('goatmessenger/auth/v1'), 32)),
    wrapKey: hkdf(sha256, master, salt, te.encode('goatmessenger/wrap/v1'), 32),
    salt: b64(salt),
  };
}

export async function wrapIdentity(identityJson, wrapKey) {
  const nonce = randomBytes(12);
  const ct = await seal(wrapKey, nonce, te.encode(JSON.stringify(identityJson)), te.encode('goatmessenger/backup/v1'));
  return b64(concat(nonce, ct));
}

export async function unwrapIdentity(blobB64, wrapKey) {
  const raw = b64d(blobB64);
  const pt = await open(wrapKey, raw.slice(0, 12), raw.slice(12), te.encode('goatmessenger/backup/v1'));
  return JSON.parse(td.decode(pt));
}

/* -------------------------------------------------------------- self-check -- */

export function fingerprintKey(bytes) {
  return hex(sha256(bytes)).slice(0, 16);
}

export const __internal = { kdfRoot, kdfChain, headerAD, equalBytes };
