// Account migration checks: an account made on one relay must be usable on
// another — same name and passphrase, with contacts and ciphertext history.
//
// Two throwaway relays are started in-process. The target binds the LAN address
// on purpose, so imports arrive from a non-loopback IP and the public path
// (signup proof of work) is exercised exactly as on a hosted relay.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createGoatServer } = require('../server/index.js');

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `gm-${tag}-`));
const rand = () => crypto.randomBytes(32).toString('hex');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const lanIp = Object.values(os.networkInterfaces()).flat()
  .find((n) => n && n.family === 'IPv4' && !n.internal)?.address || '127.0.0.1';

// One retry on a transport failure: solving the proof of work blocks this
// process for a while, and a socket idled that long can be closed underneath
// the next request. A real client simply connects again.
async function call(base, route, { method = 'POST', body, token, attempt = 1 } = {}) {
  let res;
  try {
    res = await fetch(base + route, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return call(base, route, { method, body, token, attempt: attempt - 1 });
    }
    throw new Error(`${method} ${base}${route}: ${err.message}`);
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

/** Mirrors the relay's challenge: sha256 with `bits` leading zero bits. */
function solveProofOfWork(bits, challenge, name) {
  for (let n = 0; ; n++) {
    const digest = crypto.createHash('sha256').update(`${challenge}:${name}:${String(n)}`).digest();
    let left = bits;
    for (const byte of digest) {
      if (byte === 0) { left -= 8; continue; }
      for (let m = 0x80; m > 0; m >>= 1) { if (byte & m) break; left--; }
      break;
    }
    if (left <= 0) return String(n);
  }
}

(async () => {
  const sourceDir = tmp('migrate-source');
  const targetDir = tmp('migrate-target');
  const source = createGoatServer({ port: 0, dataDir: sourceDir });
  const sourceBase = `http://127.0.0.1:${await source.listen()}`;
  const target = createGoatServer({ port: 0, dataDir: targetDir, host: '0.0.0.0' });
  const targetBase = `http://${lanIp}:${await target.listen()}`;

  const alpha = { name: 'mig_alpha', auth: rand(), token: '' };
  const beta = { name: 'mig_beta', auth: rand(), token: '' };
  const keyBundle = () => ({ ik: rand(), sig: rand(), spk: rand(), spkSig: rand() });

  console.log('migration checks:');
  for (const user of [alpha, beta]) {
    const res = await call(sourceBase, '/api/signup', {
      body: { username: user.name, displayName: user.name, authToken: user.auth, identityBackup: rand(), keys: keyBundle() },
    });
    check(`signup ${user.name} on the source relay`, res.status === 200, `HTTP ${res.status}`);
    user.token = res.data.token;
  }

  await call(sourceBase, '/api/contacts', { body: { username: beta.name }, token: alpha.token });
  await call(sourceBase, '/api/contacts/accept', { body: { username: alpha.name }, token: beta.token });
  for (const [from, to, ct] of [[alpha, beta, 'ciphertext'], [beta, alpha, 'reply']]) {
    const res = await call(sourceBase, '/api/messages', {
      body: { to: to.name, clientId: `client-${ct}`, env: { ct, header: { n: 1 } } },
      token: from.token,
    });
    check(`${from.name} → ${to.name} delivered on the source relay`, res.status === 200, `HTTP ${res.status}`);
  }

  const bundle = (await call(sourceBase, '/api/export', { body: {}, token: alpha.token })).data.bundle;
  check('export returns the account record', bundle?.account?.username === alpha.name);
  check('export carries the room history', (bundle?.messages || []).some((room) => room.list.length === 2));

  const first = await call(targetBase, '/api/import', { body: { bundle } });
  check('a public-facing relay demands proof of work for imports', first.status === 428 && Boolean(first.data.challenge), `HTTP ${first.status}`);
  const nonce = solveProofOfWork(first.data.bits || 16, first.data.challenge, alpha.name);
  const imported = await call(targetBase, '/api/import', { body: { bundle, pow: { challenge: first.data.challenge, nonce } } });
  check('import lands with the proof of work', imported.status === 200, JSON.stringify(imported.data));

  const betaBundle = (await call(sourceBase, '/api/export', { body: {}, token: beta.token })).data.bundle;
  let betaTry = await call(targetBase, '/api/import', { body: { bundle: betaBundle } });
  if (betaTry.status === 428) {
    const bNonce = solveProofOfWork(betaTry.data.bits || 16, betaTry.data.challenge, beta.name);
    betaTry = await call(targetBase, '/api/import', { body: { bundle: betaBundle, pow: { challenge: betaTry.data.challenge, nonce: bNonce } } });
  }
  check('the second account imports too', betaTry.status === 200, `HTTP ${betaTry.status}`);

  const login = await call(targetBase, '/api/login', { body: { username: alpha.name, authToken: alpha.auth } });
  check('same name and passphrase open the account on the new relay', login.status === 200, `HTTP ${login.status}`);
  check('the encrypted key backup travels byte for byte', login.data.identityBackup === bundle.account.identityBackup);
  check('the public key bundle travels', JSON.stringify(login.data.keys) === JSON.stringify(bundle.account.keys));

  const rel = (login.data.contacts || []).find((contact) => contact.username === beta.name);
  check('contacts survive', rel?.state === 'accepted', JSON.stringify(rel?.state));

  const history = await call(targetBase, `/api/messages?username=${beta.name}&after=0`, { method: 'GET', token: login.data.token });
  check('history is readable on the new relay', history.status === 200 && history.data.messages?.length === 2, `HTTP ${history.status}`);
  check('history keeps direction and order', history.data.messages?.[0]?.from === alpha.name && history.data.messages?.[1]?.from === beta.name);
  check('history keeps its original timestamps', (history.data.messages || []).every((m) => Number.isFinite(m.ts) && m.ts < Date.now()));

  check('re-importing the same account is refused', [409, 428].includes((await call(targetBase, '/api/import', { body: { bundle } })).status));
  check('a malformed bundle is refused', [400, 428].includes((await call(targetBase, '/api/import', { body: { bundle: { v: 1, account: { username: 'x' } } } })).status));

  await source.close();
  await target.close();
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.rmSync(targetDir, { recursive: true, force: true });

  console.log(failures ? `\n${failures} check(s) failed` : '\nall 16 checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
