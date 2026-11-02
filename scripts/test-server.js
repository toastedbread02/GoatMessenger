// Integration test: real HTTP + WebSocket server, two real clients, real crypto.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

(async () => {
  const C = await import('../app/shared/crypto.mjs');
  const { createGoatServer } = require('../server/index');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goatmessenger-test-'));
  const goat = createGoatServer({ port: 0, dataDir, host: '127.0.0.1' });
  const port = await goat.listen();
  const base = `http://127.0.0.1:${port}`;
  const log = [];
  const check = async (name, fn) => {
    try {
      await fn();
      log.push(`  ok   ${name}`);
    } catch (err) {
      log.push(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 3).join('\n       ')}`);
      process.exitCode = 1;
    }
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
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  };

  const client = async (username, displayName) => {
    const identity = C.createIdentity();
    const keys = C.derivePassphraseKeys('passphrase-' + username, username);
    const backup = await C.wrapIdentity(C.exportIdentity(identity), keys.wrapKey);
    const res = await api('/api/signup', {
      method: 'POST',
      body: {
        username,
        displayName,
        authToken: keys.authToken,
        identityBackup: backup,
        keys: C.publicBundle(identity),
        accent: 30,
      },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res));
    return { username, identity, keys, token: res.token, api: (r, o = {}) => api(r, { ...o, token: res.token }) };
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
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
    });
    ws.on('open', () => resolve({
      ws,
      send: (m) => ws.send(JSON.stringify(m)),
      seen: inbox,
      wait: (match, ms = 4000) => {
        const hit = inbox.find(match);
        if (hit) return Promise.resolve(hit);
        return new Promise((res2, rej2) => {
          const timer = setTimeout(() => rej2(new Error('timeout waiting for ws event')), ms);
          waiters.push({ match, resolve: res2, timer });
        });
      },
      close: () => ws.close(),
    }));
    ws.on('error', reject);
  });

  await check('health endpoint responds', async () => {
    const res = await api('/api/health');
    assert.strictEqual(res.ok, true);
  });

  const alice = await client('alice', 'Alice the Goat');
  const bob = await client('bob', 'Billy');
  let carol;

  await check('signup returns a session and rejects duplicates', async () => {
    assert.ok(alice.token.length > 20);
    const dup = await client('alice', 'impostor').catch((e) => e);
    assert.ok(dup instanceof Error || dup.status === 409, 'duplicate signup must fail');
  });

  await check('login rejects a wrong passphrase and accepts the right one', async () => {
    const bad = await api('/api/login', {
      method: 'POST',
      body: { username: 'alice', authToken: C.derivePassphraseKeys('nope', 'alice').authToken },
    });
    assert.strictEqual(bad.status, 401);
    const good = await api('/api/login', {
      method: 'POST',
      body: { username: 'alice', authToken: alice.keys.authToken },
    });
    assert.strictEqual(good.status, 200);
    assert.ok(good.identityBackup, 'login returns the encrypted key backup');
    const restored = C.importIdentity(await C.unwrapIdentity(good.identityBackup, alice.keys.wrapKey));
    assert.strictEqual(C.b64(restored.ikPub), C.b64(alice.identity.ikPub), 'keys are recoverable from the passphrase');
  });

  await check('contact request + accept both reach the other side', async () => {
    const bobWs = await connect(bob.token);
    const req = await alice.api('/api/contacts', { method: 'POST', body: { username: 'bob' } });
    assert.strictEqual(req.status, 200);
    await bobWs.wait((m) => m.t === 'contact-request' && m.user.username === 'alice');

    const bs = await bob.api('/api/bootstrap');
    const rel = bs.contacts.find((c) => c.username === 'alice');
    assert.strictEqual(rel.state, 'in');

    const accepted = await bob.api('/api/contacts/accept', { method: 'POST', body: { username: 'alice' } });
    assert.strictEqual(accepted.status, 200);
    const as = await alice.api('/api/bootstrap');
    assert.strictEqual(as.contacts.find((c) => c.username === 'bob').state, 'accepted');
    bobWs.close();
  });

  await check('outsiders cannot fetch keys', async () => {
    carol = await client('carol', 'Carol');
    const res = await carol.api('/api/keys?username=bob');
    assert.strictEqual(res.status, 403);
  });

  await check('E2EE message round-trip through the relay', async () => {
    const [aliceWs, bobWs] = await Promise.all([connect(alice.token), connect(bob.token)]);

    const keysRes = await alice.api('/api/keys?username=bob');
    assert.strictEqual(keysRes.status, 200);
    const bundle = { ...keysRes.keys };
    C.verifyBundle(bundle);

    // Alice starts a session and sends the prekey message.
    const aliceState = C.initiatorSession(alice.identity, bundle);
    const env1 = await C.encryptMessage(aliceState, { kind: 'text', text: 'hello goat 🐐', sentAt: Date.now() });
    const posted = await alice.api('/api/messages', {
      method: 'POST',
      body: { to: 'bob', env: env1, clientId: 'c1' },
    });
    assert.strictEqual(posted.status, 200);

    const delivered = await bobWs.wait((m) => m.t === 'message' && m.msg.from === 'alice');
    const bobState = C.responderSession(bob.identity, delivered.msg.env.prekey);
    const plain = await C.decryptMessage(bobState, delivered.msg.env);
    assert.strictEqual(plain.text, 'hello goat 🐐');

    // Reply travels the other way on the same session.
    C.confirmSession(aliceState);
    const env2 = await C.encryptMessage(bobState, { kind: 'text', text: 'baa', sentAt: Date.now() });
    await bob.api('/api/messages', { method: 'POST', body: { to: 'alice', env: env2, clientId: 'c2' } });
    const back = await aliceWs.wait((m) => m.t === 'message' && m.msg.from === 'bob');
    const reply = await C.decryptMessage(aliceState, back.msg.env);
    assert.strictEqual(reply.text, 'baa');

    const history = await alice.api('/api/messages?username=bob&after=0');
    assert.strictEqual(history.messages.length, 2);
    assert.ok(history.messages[0].env.ct !== plain.text, 'server stores ciphertext only');

    aliceWs.close();
    bobWs.close();
  });

  await check('encrypted attachment upload/download', async () => {
    const original = new Uint8Array(5000).map((_, i) => (i * 37) % 256);
    const enc = await C.encryptBytes(original);
    const up = await alice.api('/api/upload', {
      method: 'POST',
      raw: Buffer.from(enc.data),
      headers: { 'x-file-name': 'hay.bin', 'x-file-type': 'application/octet-stream' },
    });
    assert.strictEqual(up.status, 200);
    const down = await bob.api(`/api/file/${up.id}`);
    assert.strictEqual(down.status, 200);
    assert.deepStrictEqual(Buffer.from(await C.decryptBytes(enc.keyB64, down.bytes)), Buffer.from(original));

    const stolen = await carol.api(`/api/file/${up.id}`);
    assert.strictEqual(stolen.status, 403, 'non-contacts cannot download');
  });

  await check('encrypted call: invite, ring, offer, answer', async () => {
    const [aliceWs, bobWs] = await Promise.all([connect(alice.token), connect(bob.token)]);
    const bobKeys = (await alice.api('/api/keys?username=bob')).keys;
    const aliceKeys = (await bob.api('/api/keys?username=alice')).keys;

    const epA = C.createCallEphemeral();
    const sigA = C.signCallEphemeral(alice.identity, epA.pub);
    const callId = 'call-test-1';
    aliceWs.send({
      t: 'call', action: 'invite', callId, to: 'bob', kind: 'video', ep: epA.pub, epSig: sigA,
    });

    const invite = await bobWs.wait((m) => m.t === 'call' && m.action === 'invite');
    assert.strictEqual(invite.kind, 'video');
    assert.ok(C.verifyCallEphemeral(aliceKeys, invite.ep, invite.epSig), 'call ephemeral is identity-signed');

    const epB = C.createCallEphemeral();
    const sigB = C.signCallEphemeral(bob.identity, epB.pub);
    bobWs.send({ t: 'call', action: 'ring', callId, to: 'alice', ep: epB.pub, epSig: sigB });
    const ring = await aliceWs.wait((m) => m.t === 'call' && m.action === 'ring');
    assert.ok(C.verifyCallEphemeral(bobKeys, ring.ep, ring.epSig));

    const keyA = C.deriveCallKey(epA.priv, ring.ep, epA.pub, ring.ep);
    const keyB = C.deriveCallKey(epB.priv, invite.ep, epB.pub, invite.ep);
    assert.deepStrictEqual(Buffer.from(keyA), Buffer.from(keyB));
    assert.strictEqual(C.callSafetyCode(keyA), C.callSafetyCode(keyB));

    const offer = { type: 'offer', sdp: 'v=0\r\nfake-sdp' };
    aliceWs.send({ t: 'call', action: 'signal', callId, to: 'bob', blob: await C.encryptSignal(keyA, offer) });
    const sig = await bobWs.wait((m) => m.t === 'call' && m.action === 'signal');
    assert.deepStrictEqual(await C.decryptSignal(keyB, sig.blob), offer);
    assert.ok(!sig.blob.includes('fake-sdp'), 'SDP never travels in the clear');

    const answer = { type: 'answer', sdp: 'v=0\r\nfake-answer' };
    bobWs.send({ t: 'call', action: 'signal', callId, to: 'alice', blob: await C.encryptSignal(keyB, answer) });
    const ans = await aliceWs.wait((m) => m.t === 'call' && m.action === 'signal');
    assert.deepStrictEqual(await C.decryptSignal(keyA, ans.blob), answer);

    aliceWs.send({ t: 'call', action: 'hangup', callId, to: 'bob' });
    await bobWs.wait((m) => m.t === 'call' && m.action === 'hangup');
    aliceWs.close();
    bobWs.close();
  });

  await check('presence is broadcast to contacts', async () => {
    const aliceWs = await connect(alice.token);
    const bobWs = await connect(bob.token);
    await aliceWs.wait((m) => m.t === 'presence' && m.user === 'bob' && m.online === true);
    bobWs.close();
    await aliceWs.wait((m) => m.t === 'presence' && m.user === 'bob' && m.online === false);
    aliceWs.close();
  });

  await check('typing and read receipts route to the contact', async () => {
    const aliceWs = await connect(alice.token);
    const bobWs = await connect(bob.token);
    aliceWs.send({ t: 'typing', to: 'bob', on: true });
    await bobWs.wait((m) => m.t === 'typing' && m.from === 'alice' && m.on === true);
    bobWs.send({ t: 'read', to: 'alice', upTo: 2, ids: ['x'] });
    await aliceWs.wait((m) => m.t === 'read' && m.from === 'bob' && m.upTo === 2);
    aliceWs.close();
    bobWs.close();
  });

  await check('account deletion erases everything the relay held', async () => {
    const dave = await client('dave', 'Dave the Goat');
    const daveWs = await connect(dave.token);
    const aliceWs = await connect(alice.token);
    // become contacts + exchange a message + an upload
    const sent = await dave.api('/api/contacts', { method: 'POST', body: { username: 'alice' } });
    assert.strictEqual(sent.status, 200);
    await alice.api('/api/contacts/accept', { method: 'POST', body: { username: 'dave' } });
    const env = { ct: 'opaque-ciphertext-blob', header: { h1: 'x' } };
    const msg = await dave.api('/api/messages', { method: 'POST', body: { to: 'alice', env, clientId: 'del-1' } });
    assert.strictEqual(msg.status, 200);
    const up = await dave.api('/api/upload', { method: 'POST', raw: new Uint8Array([9, 9, 9]), headers: { 'x-file-name': 'hay.bin', 'x-file-type': 'application/octet-stream' } });
    assert.strictEqual(up.status, 200);

    // wrong confirmation must not delete anything
    const nope = await api('/api/account', { method: 'DELETE', body: { confirm: 'someone-else' }, token: dave.token });
    assert.strictEqual(nope.status, 400);

    // the real thing, confirmed
    const gone = await api('/api/account', { method: 'DELETE', body: { confirm: 'dave' }, token: dave.token });
    assert.strictEqual(gone.status, 200);
    // the relay told alice, and dave's socket was closed
    await aliceWs.wait((m) => m.t === 'contact-removed' && m.user === 'dave');
    // account is unreachable
    const login = await api('/api/login', { method: 'POST', body: { username: 'dave', authToken: dave.keys.authToken } });
    assert.strictEqual(login.status, 401, 'deleted account cannot log in');
    const lookup = await api('/api/lookup?username=dave', { token: alice.token });
    assert.strictEqual(lookup.status, 404, 'deleted account cannot be looked up');
    // the queued messages and the stored file vanished with the account
    // (the conversation itself 404s now — there is no goat on the other end)
    const history = await alice.api('/api/messages?username=dave');
    assert.strictEqual(history.status, 404, 'conversation is unreachable after deletion');
    const blob = await alice.api(`/api/file/${up.id}`);
    assert.ok(blob.status === 404 || blob.status === 410, 'uploaded file record is gone');
    daveWs.close();
    aliceWs.close();
  });

  await check('persistence survives a restart', async () => {
    await goat.close();
    const again = createGoatServer({ port: 0, dataDir, host: '127.0.0.1' });
    const p2 = await again.listen();
    const res = await fetch(`http://127.0.0.1:${p2}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', authToken: alice.keys.authToken }),
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.contacts.find((c) => c.username === 'bob').state, 'accepted');
    await again.close();
  });

  console.log('server checks:');
  console.log(log.join('\n'));
  const failed = log.filter((l) => l.includes('FAIL')).length;
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${log.length} checks passed`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})();
