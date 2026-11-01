// Encrypted-on-the-wire audit.
//
// Runs a real conversation (text, attachment, call handshake) through the real
// relay, then reads every byte the relay wrote to disk and looks for the
// plaintext markers and for any private key material. If end-to-end encryption
// holds, none of it can be there.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

(async () => {
  const C = await import('../app/shared/crypto.mjs');
  const { createGoatServer } = require('../server/index');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goatmessenger-audit-'));
  const goat = createGoatServer({ port: 0, dataDir, host: '127.0.0.1' });
  const port = await goat.listen();
  const base = `http://127.0.0.1:${port}`;
  const lines = [];
  const check = (name, ok, detail = '') => {
    lines.push(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
    if (!ok) process.exitCode = 1;
  };

  const api = async (route, { method = 'GET', body, token, raw, headers = {} } = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : raw,
    });
    const type = res.headers.get('content-type') || '';
    if (type.includes('octet-stream')) return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };

  const account = async (username) => {
    const identity = C.createIdentity();
    const keys = C.derivePassphraseKeys('audit-passphrase', username);
    const backup = await C.wrapIdentity(C.exportIdentity(identity), keys.wrapKey);
    const res = await api('/api/signup', {
      method: 'POST',
      body: { username, authToken: keys.authToken, identityBackup: backup, keys: C.publicBundle(identity) },
    });
    assert.strictEqual(res.status, 200, `signup ${username}: ${JSON.stringify(res)}`);
    return { username, identity, token: res.token, call: (r, o = {}) => api(r, { ...o, token: res.token }) };
  };

  const connect = (token) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(msg)) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(msg);
        }
      }
    });
    ws.on('open', () => resolve({
      send: (m) => ws.send(JSON.stringify(m)),
      wait: (match, ms = 4000) => {
        const hit = inbox.find(match);
        if (hit) return Promise.resolve(hit);
        return new Promise((res2, rej2) => {
          const timer = setTimeout(() => rej2(new Error('timeout on ws')), ms);
          waiters.push({ match, resolve: (m) => { clearTimeout(timer); res2(m); } });
        });
      },
      close: () => ws.close(),
    }));
    ws.on('error', reject);
  });

  const tag = crypto.randomBytes(6).toString('hex');
  const TEXT_MARK = `GOATMARK-text-${tag}`;
  const FILE_MARK = `GOATMARK-file-${tag}`;
  const SDP_MARK = `GOATMARK-sdp-${tag}`;

  const alice = await account(`audit_alice${tag}`);
  const bob = await account(`audit_bob${tag}`);
  await alice.call('/api/contacts', { method: 'POST', body: { username: bob.username } });
  await bob.call('/api/contacts/accept', { method: 'POST', body: { username: alice.username } });

  /* 1. an encrypted message */
  const bobBundle = (await alice.call(`/api/keys?username=${bob.username}`)).keys;
  const aliceState = C.initiatorSession(alice.identity, bobBundle);
  const envelope = await C.encryptMessage(aliceState, { kind: 'text', text: TEXT_MARK });
  const posted = await alice.call('/api/messages', { method: 'POST', body: { to: bob.username, env: envelope, clientId: 'audit-1' } });
  assert.strictEqual(posted.status, 200);
  const stored = await bob.call(`/api/messages?username=${alice.username}&after=0`);
  const bobState = C.responderSession(bob.identity, stored.messages[0].env.prekey);
  const clear = await C.decryptMessage(bobState, stored.messages[0].env);
  check('the message decrypts on the receiving side', clear.text === TEXT_MARK);

  /* 2. an encrypted attachment */
  const original = new Uint8Array(64 * 1024).map((_, i) => (i * 31) % 256);
  original.set(Buffer.from(FILE_MARK), 1000);
  const sealed = await C.encryptBytes(original);
  const upload = await alice.call('/api/upload', {
    method: 'POST', raw: Buffer.from(sealed.data), headers: { 'x-file-name': 'audit.bin', 'x-file-type': 'application/octet-stream' },
  });
  assert.strictEqual(upload.status, 200);
  const download = await bob.call(`/api/file/${upload.id}`);
  const unsealed = await C.decryptBytes(sealed.keyB64, download.bytes);
  check('the attachment decrypts byte-for-byte for its recipient',
    Buffer.compare(Buffer.from(unsealed), Buffer.from(original)) === 0);

  /* 3. an encrypted call handshake */
  const bobWs = await connect(bob.token);
  const aliceWs = await connect(alice.token);
  const epA = C.createCallEphemeral();
  const sigA = C.signCallEphemeral(alice.identity, epA.pub);
  aliceWs.send({ t: 'call', action: 'invite', callId: `audit-${tag}`, to: bob.username, kind: 'audio', ep: epA.pub, epSig: sigA });
  const invite = await bobWs.wait((m) => m.t === 'call' && m.action === 'invite');
  const epB = C.createCallEphemeral();
  bobWs.send({ t: 'call', action: 'ring', callId: invite.callId, to: alice.username, ep: epB.pub, epSig: C.signCallEphemeral(bob.identity, epB.pub) });
  const ring = await aliceWs.wait((m) => m.t === 'call' && m.action === 'ring');
  const keyA = C.deriveCallKey(epA.priv, ring.ep, epA.pub, ring.ep);
  const keyB = C.deriveCallKey(epB.priv, invite.ep, epB.pub, invite.ep);
  const sdp = { type: 'offer', sdp: `v=0\r\na=${SDP_MARK}\r\n` };
  aliceWs.send({ t: 'call', action: 'signal', callId: invite.callId, to: bob.username, blob: await C.encryptSignal(keyA, sdp) });
  const forwarded = await bobWs.wait((m) => m.t === 'call' && m.action === 'signal');
  const plainSdp = await C.decryptSignal(keyB, forwarded.blob);
  check('the call handshake decrypts only under the derived call key', plainSdp.sdp.includes(SDP_MARK));
  aliceWs.send({ t: 'call', action: 'hangup', callId: invite.callId, to: bob.username });
  aliceWs.close();
  bobWs.close();

  /* 4. read everything the relay persisted and look for plaintext */
  await goat.close(); // flush the store to disk

  const collect = (dir, acc = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full, acc);
      else acc.push(full);
    }
    return acc;
  };
  const files = collect(dataDir);
  let totalBytes = 0;
  const hits = [];
  const scanFor = (needle, label, filesToScan) => {
    const buf = Buffer.from(needle);
    for (const file of filesToScan) {
      const data = fs.readFileSync(file);
      if (data.includes(buf)) hits.push(`${label} found in ${path.relative(dataDir, file)}`);
    }
  };

  for (const file of files) totalBytes += fs.statSync(file).size;
  scanFor(TEXT_MARK, 'message plaintext', files);
  scanFor(FILE_MARK, 'attachment plaintext', files);
  scanFor(SDP_MARK, 'call SDP plaintext', files);

  const secrets = C.exportIdentity(alice.identity);
  scanFor(secrets.ikPriv, 'identity private key', files);
  scanFor(secrets.sigPriv, 'signing private key', files);
  scanFor(secrets.spkPriv, 'signed prekey (private)', files);
  if (secrets.opkPriv) scanFor(secrets.opkPriv, 'one-time prekey (private)', files);

  const dbRaw = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  const db = JSON.parse(dbRaw);
  const room = Object.keys(db.messages)[0];
  const storedEnvelope = db.messages[room][0].env;
  const allowedFields = new Set(['v', 'type', 'header', 'ct', 'prekey']);
  const strayFields = Object.keys(storedEnvelope).filter((k) => !allowedFields.has(k));
  const envSerialized = JSON.stringify(storedEnvelope);

  check('the relay did store the traffic (so the scan is not vacuous)',
    db.messages[room].length === 1 && storedEnvelope.ct.length > 40 && files.some((f) => f.endsWith('.bin')),
    `messages=${db.messages[room].length} ctLen=${storedEnvelope.ct.length} files=${files.length}`);
  check('stored envelopes contain only ratchet header + ciphertext', strayFields.length === 0, String(strayFields));
  check('message plaintext is absent from relay storage', !envSerialized.includes(TEXT_MARK) && !hits.some((h) => h.includes('message plaintext')));
  check('no plaintext markers found anywhere on the relay disk', hits.length === 0, hits.join(' | '));
  check('no private key material on the relay disk', !hits.some((h) => h.includes('private') || h.includes('prekey (private)')));
  check('the stored key backup is opaque to the relay (no private keys inside)', !dbRaw.includes('"ikPriv"'));

  const keyFiles = Object.keys(db.users).length;
  console.log(`relay storage audit (${files.length} files, ${(totalBytes / 1024).toFixed(0)} KB, ${keyFiles} accounts):`);
  console.log(lines.join('\n'));
  console.log(`  scanned for: text marker, attachment marker, SDP marker, 4 private keys`);
  const failed = lines.filter((l) => l.includes('FAIL')).length;
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${lines.length} checks passed`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})();
