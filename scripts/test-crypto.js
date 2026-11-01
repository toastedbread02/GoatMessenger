// Verification harness for app/shared/crypto.mjs — real protocol behaviour, not mocks.
const assert = require('assert');

(async () => {
  const C = await import('../app/shared/crypto.mjs');
  const results = [];
  const test = async (name, fn) => {
    try {
      await fn();
      results.push(`  ok   ${name}`);
    } catch (err) {
      results.push(`  FAIL ${name}\n       ${err.message}`);
      process.exitCode = 1;
    }
  };

  const aliceId = C.createIdentity();
  const bobId = C.createIdentity();
  const aliceBundle = C.publicBundle(aliceId);
  const bobBundle = C.publicBundle(bobId);

  const say = (who) => ({ from: who, text: 'baa', at: Date.now() });

  await test('peer bundle verifies and a forged prekey is rejected', () => {
    assert.ok(C.verifyBundle(bobBundle));
    const forged = { ...bobBundle };
    forged.spk = C.b64(new Uint8Array(32).fill(7));
    assert.throws(() => C.verifyBundle(forged), /verification/);
  });

  await test('X3DH establishes and both directions decrypt', async () => {
    const a = C.initiatorSession(aliceId, bobBundle);
    let env = await C.encryptMessage(a, { text: 'hello goat' });
    assert.strictEqual(env.type, 'prekey');
    const b = C.responderSession(bobId, env.prekey);
    const got = await C.decryptMessage(b, env);
    assert.strictEqual(got.text, 'hello goat');

    let reply = await C.encryptMessage(b, { text: 'baa back' });
    assert.strictEqual(reply.type, 'msg');
    const got2 = await C.decryptMessage(a, reply);
    assert.strictEqual(got2.text, 'baa back');
  });

  await test('long bidirectional conversation with DH ratchet turns', async () => {
    const a = C.initiatorSession(aliceId, bobBundle);
    const first = await C.encryptMessage(a, say('alice'));
    const b = C.responderSession(bobId, first.prekey);
    await C.decryptMessage(b, first);
    let lastAlicePub = null;
    let ratchets = 0;
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 3; i++) {
        const env = await C.encryptMessage(a, { text: `a${round}-${i}` });
        if (lastAlicePub && env.header.dh !== lastAlicePub) ratchets++;
        lastAlicePub = env.header.dh;
        const out = await C.decryptMessage(b, env);
        assert.strictEqual(out.text, `a${round}-${i}`);
      }
      for (let i = 0; i < 2; i++) {
        const env = await C.encryptMessage(b, { text: `b${round}-${i}` });
        const out = await C.decryptMessage(a, env);
        assert.strictEqual(out.text, `b${round}-${i}`);
      }
    }
    assert.ok(ratchets >= 1, 'expected the DH ratchet to step');
  });

  await test('out-of-order delivery within a chain is recovered', async () => {
    const a = C.initiatorSession(aliceId, bobBundle);
    const b = C.responderSession(bobId, (await C.encryptMessage(a, { text: 'hi' })).prekey);
    const envs = [];
    envs.push(await C.encryptMessage(a, { text: 'one' }));
    envs.push(await C.encryptMessage(a, { text: 'two' }));
    envs.push(await C.encryptMessage(a, { text: 'three' }));
    const reversed = [...envs].reverse();
    const seen = [];
    for (const env of reversed) seen.push((await C.decryptMessage(b, env)).text);
    assert.deepStrictEqual(seen, ['three', 'two', 'one']);
  });

  await test('replay and tampering are rejected', async () => {
    const a = C.initiatorSession(aliceId, bobBundle);
    const first = await C.encryptMessage(a, { text: 'hi' });
    const b = C.responderSession(bobId, first.prekey);
    await C.decryptMessage(b, first);
    const env = await C.encryptMessage(a, { text: 'secret' });
    await C.decryptMessage(b, env);
    await assert.rejects(() => C.decryptMessage(b, env), /replayed/);

    const env2 = await C.encryptMessage(a, { text: 'another' });
    const raw = C.b64d(env2.ct);
    raw[raw.length - 1] ^= 0xff;
    env2.ct = C.b64(raw);
    await assert.rejects(() => C.decryptMessage(b, env2));
  });

  await test('session state survives serialisation mid-conversation', async () => {
    const a = C.initiatorSession(aliceId, bobBundle);
    const b = C.responderSession(bobId, (await C.encryptMessage(a, { text: 'x' })).prekey);
    for (let i = 0; i < 3; i++) await C.decryptMessage(b, await C.encryptMessage(a, { text: 'warm' }));

    let aState = C.deserializeSession(C.serializeSession(a));
    let bState = C.deserializeSession(C.serializeSession(b));    for (let i = 0; i < 4; i++) {
      const env = await C.encryptMessage(bState, { text: `persisted${i}` });
      assert.strictEqual((await C.decryptMessage(aState, env)).text, `persisted${i}`);
      const env2 = await C.encryptMessage(aState, { text: `back${i}` });
      assert.strictEqual((await C.decryptMessage(bState, env2)).text, `back${i}`);
    }
  });

  await test('skipped message keys are consumed once', async () => {
    const a = C.initiatorSession(aliceId, bobBundle);
    const b = C.responderSession(bobId, (await C.encryptMessage(a, { text: 'hi' })).prekey);
    const m1 = await C.encryptMessage(a, { text: 'first' });
    const m2 = await C.encryptMessage(a, { text: 'second' });
    const out2 = await C.decryptMessage(b, m2);
    assert.strictEqual(out2.text, 'second');
    assert.strictEqual((await C.decryptMessage(b, m1)).text, 'first');
    await assert.rejects(() => C.decryptMessage(b, m1), () => true);
  });

  await test('safety numbers match on both sides and are stable', () => {
    const x = C.safetyNumber(aliceBundle, bobBundle);
    const y = C.safetyNumber(bobBundle, aliceBundle);
    assert.strictEqual(x, y);
    assert.strictEqual(x.replace(/ /g, '').length, 60);
    assert.strictEqual(C.safetyNumber(aliceBundle, C.publicBundle(C.createIdentity())) === x, false);
  });

  await test('call key derives identically on both sides', () => {
    const ea = C.createCallEphemeral();
    const eb = C.createCallEphemeral();
    const sigA = C.signCallEphemeral(aliceId, ea.pub);
    const sigB = C.signCallEphemeral(bobId, eb.pub);
    assert.ok(C.verifyCallEphemeral(aliceBundle, ea.pub, sigA));
    assert.ok(C.verifyCallEphemeral(bobBundle, eb.pub, sigB));
    assert.strictEqual(C.verifyCallEphemeral(bobBundle, ea.pub, sigA), false, 'wrong signer must fail');

    const kA = C.deriveCallKey(ea.priv, eb.pub, ea.pub, eb.pub);
    const kB = C.deriveCallKey(eb.priv, ea.pub, eb.pub, ea.pub);
    assert.deepStrictEqual(Buffer.from(kA), Buffer.from(kB));
    assert.strictEqual(C.callSafetyCode(kA), C.callSafetyCode(kB));
  });

  await test('call signalling is encrypted under the call key only', async () => {
    const ea = C.createCallEphemeral();
    const eb = C.createCallEphemeral();
    const kA = C.deriveCallKey(ea.priv, eb.pub, ea.pub, eb.pub);
    const kB = C.deriveCallKey(eb.priv, ea.pub, eb.pub, ea.pub);
    const sdp = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
    const blob = await C.encryptSignal(kA, sdp);
    assert.deepStrictEqual(await C.decryptSignal(kB, blob), sdp);

    const other = C.createCallEphemeral();
    const kMallory = C.deriveCallKey(other.priv, eb.pub, other.pub, eb.pub);
    await assert.rejects(() => C.decryptSignal(kMallory, blob));
  });

  await test('passphrase keys are deterministic and wrap the identity', async () => {
    const k1 = C.derivePassphraseKeys('correct horse battery', 'GoatJane');
    const k2 = C.derivePassphraseKeys('correct horse battery', 'goatjane');
    assert.strictEqual(k1.authToken, k2.authToken);
    assert.notStrictEqual(k1.authToken, Buffer.from(k1.wrapKey).toString('hex'));

    const blob = await C.wrapIdentity(C.exportIdentity(aliceId), k1.wrapKey);
    const back = await C.unwrapIdentity(blob, k2.wrapKey);
    assert.strictEqual(C.b64(C.importIdentity(back).ikPub), C.b64(aliceId.ikPub));

    const wrong = C.derivePassphraseKeys('wrong passphrase', 'goatjane');
    await assert.rejects(() => C.unwrapIdentity(blob, wrong.wrapKey));
  });

  await test('attachments encrypt/decrypt with a one-off key', async () => {
    const bytes = new Uint8Array(4096).map((_, i) => i % 251);
    const enc = await C.encryptBytes(bytes);
    assert.notStrictEqual(Buffer.from(enc.data).toString('hex'), Buffer.from(bytes).toString('hex'));
    const dec = await C.decryptBytes(enc.keyB64, enc.data);
    assert.deepStrictEqual(Buffer.from(dec), Buffer.from(bytes));
    const other = C.createIdentity();
    await assert.rejects(() => C.decryptBytes(enc.keyB64, C.concat(enc.data, new Uint8Array([0]))));
    void other;
  });

  console.log('crypto checks:');
  console.log(results.join('\n'));
  const failed = results.filter((r) => r.includes('FAIL')).length;
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
})();
