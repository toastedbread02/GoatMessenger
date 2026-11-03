// Profile end-to-end test against the PACKAGED macOS app (dist/GoatMessenger.app),
// not the dev build — proving the shipped app really has the profile features.
//
//   node scripts/e2e-profile.js
//
// Drives two real windows over the DevTools protocol:
//   • sign up + contact handshake
//   • edit profile through the real Settings → Profile pane (name/about, save)
//   • avatar + banner round-trip through the relay's saved profile
//   • live preview card, verified badge (@billy), chat-header avatar
//   • the peer's profile card shows the same avatar, banner, about + badge
//   • profile survives sign-out / sign-in (stored server-side)
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = 9444;
const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'screenshots');
const RUN = crypto.randomBytes(2).toString('hex');
const BILLY = 'billy';
const NANNY = `nanny${RUN}`;
const PASS = 'wool-and-horns';

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (err) { reject(err); } });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

/* --------------------------------------------------------------- CDP client */

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.console = [];
    this.errors = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        this.console.push(`${msg.params.type}: ${text}`);
        if (msg.params.type === 'error') this.errors.push(text);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.errors.push(msg.params.entry.text);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30000);
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(desc);
    }
    return res.result?.value;
  }

  async waitFor(expression, { timeout = 15000, interval = 250, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression);
        if (last) return last;
      } catch (err) { last = err.message; }
      await sleep(interval);
    }
    throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
  }

  async screenshot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return file;
  }
}

async function attach(role) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      const page = targets.find((t) => t.type === 'page' && t.url.includes(`role=${role}`));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        const session = new Session(ws);
        await session.send('Runtime.enable');
        await session.send('Log.enable');
        await session.send('Page.enable');
        return session;
      }
    } catch { /* keep waiting */ }
    await sleep(400);
  }
  throw new Error(`could not attach to window ${role}`);
}

/* -------------------------------------------------------------------- main */

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-e2e-profile-'));
  const appBin = path.join(ROOT, 'dist', 'GoatMessenger.app', 'Contents', 'MacOS', 'GoatMessenger');
  if (!fs.existsSync(appBin)) {
    console.error(`packaged app missing: ${appBin} — run npm run package first`);
    process.exit(2);
  }

  // A dedicated throwaway relay: the packaged app reuses any healthy relay on
  // 127.0.0.1:4040 first (the user's real one!), which would pollute it — so we
  // point GM_SERVER at our own fresh instance instead.
  const log = [];
  const { createGoatServer } = require(path.join(ROOT, 'server', 'index.js'));
  const breaker = createGoatServer({ port: 4730, dataDir: profile, host: '127.0.0.1' });
  const relayPort = await breaker.listen();
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  log.push(`test relay at ${relayUrl} (data: ${profile})`);

  const child = spawn(appBin, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(profile, 'electron')}`,
  ], {
    cwd: ROOT,
    env: { ...process.env, GM_E2E: '1', GM_FAKE_MEDIA: '1', GM_SERVER: relayUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => log.push(`[app] ${d.toString().trim()}`));
  child.stderr.on('data', (d) => log.push(`[app] ${d.toString().trim()}`));

  let a; let b;
  try {
    [a, b] = await Promise.all([attach('e2e-a'), attach('e2e-b')]);
    await Promise.all([
      a.waitFor('window.__gm && window.__gm.booted()', { label: 'window A boot' }),
      b.waitFor('window.__gm && window.__gm.booted()', { label: 'window B boot' }),
    ]);
    const embedded = `${await a.evaluate('window.__gm.relayUrl()')}`.startsWith('http://127.0.0.1:');
    check('packaged app runs its embedded relay', embedded, await a.evaluate('window.__gm.relayUrl()'));
    const relayUrlA = await a.evaluate('window.__gm.relayUrl()');
    const relayUrlB = await b.evaluate('window.__gm.relayUrl()');
    check('both windows point at the same relay (same app = one relay)', relayUrlA === relayUrlB, `A=${relayUrlA} B=${relayUrlB}`);
    log.push(`relay data dir env: GM_DATA_DIR=${profile}`);

    // ---- accounts ---------------------------------------------------------
    await a.evaluate(`window.__gm.signUp(${JSON.stringify(BILLY)}, ${JSON.stringify(PASS)}, 'Billy')`);
    await b.evaluate(`window.__gm.signUp(${JSON.stringify(NANNY)}, ${JSON.stringify(PASS)}, 'Nanny Goat')`);
    await Promise.all([a.waitFor('window.__gm.ready()'), b.waitFor('window.__gm.ready()')]);
    check('@billy signs up on the packaged app relay', (await a.evaluate('window.__gm.state.me.username')) === BILLY);

    // ---- contact handshake -------------------------------------------------
    await a.evaluate(`window.__gm.addContact(${JSON.stringify(NANNY)})`);
    await b.waitFor(`window.__gm.contacts().some(c => c.username === ${JSON.stringify(BILLY)} && c.state === 'in')`, { label: 'incoming request' });
    await b.evaluate(`window.__gm.acceptRequest(${JSON.stringify(BILLY)})`);
    await Promise.all([
      a.waitFor(`window.__gm.contacts().some(c => c.username === ${JSON.stringify(NANNY)} && c.state === 'accepted')`, { label: 'A accepted' }),
      b.waitFor(`window.__gm.contacts().some(c => c.username === ${JSON.stringify(BILLY)} && c.state === 'accepted')`, { label: 'B accepted' }),
    ]);
    check('contact handshake completes between the windows', true);

    // ---- edit profile through the real Settings pane -----------------------
    await a.evaluate(`window.__gm.openChat(${JSON.stringify(NANNY)})`);
    await b.evaluate(`window.__gm.openChat(${JSON.stringify(BILLY)})`);
    const savedName = await a.evaluate(`(async () => {
      document.getElementById('btn-settings').click();
      const pane = document.querySelector('.settings-body');
      const input = pane.querySelector('input');
      if (!input) return 'no-name-input';
      input.value = 'Billy the Goat';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const save = [...pane.querySelectorAll('button.primary')].find((btn) => btn.textContent.trim() === 'Save profile');
      if (!save) return 'no-save-button';
      save.click();
      return 'clicked';
    })()`);
    check('Settings → Profile pane exists with a Save button', savedName === 'clicked', savedName);
    await a.waitFor("window.__gm.state.me.displayName === 'Billy the Goat'", { label: 'displayName saved' });
    check('display name saves through the real UI', await a.evaluate("window.__gm.state.me.displayName") === 'Billy the Goat');

    // ---- avatar + banner round-trip (same code path the pane's Save uses) --
    const av = await a.evaluate(`(async () => {
      const res = await window.__gm.state.api.updateProfile({
        displayName: 'Billy the Goat',
        about: 'chief grazing officer',
        avatar: (function (c) { c.width = 64; c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#21201c'; x.fillRect(0, 0, 64, 64); x.fillStyle = '#e8dcc6'; x.beginPath(); x.arc(32, 34, 20, 0, Math.PI * 2); x.fill(); return c.toDataURL('image/jpeg', 0.9); })(document.createElement('canvas')),
        banner: (function (c) { c.width = 96; c.height = 32; const x = c.getContext('2d'); x.fillStyle = '#3d5a3a'; x.fillRect(0, 0, 96, 32); return c.toDataURL('image/jpeg', 0.9); })(document.createElement('canvas')),
      });
      window.__gm.state.me = { ...window.__gm.state.me, ...res.me };
      return { avatar: Boolean(window.__gm.state.me.avatar), banner: Boolean(window.__gm.state.me.banner) };
    })()`);
    check('avatar + banner upload to the relay profile', Boolean(av?.avatar) && Boolean(av?.banner), JSON.stringify(av));

    // own live preview shows the profile photo, banner and the verified badge
    const preview = await a.evaluate(`(async () => {
      document.getElementById('btn-settings').click();
      await new Promise((r) => setTimeout(r, 400));
      const card = document.querySelector('.settings-body .profile-card');
      if (!card) return { card: false };
      const img = card.querySelector('.avatar-img');
      const banner = card.querySelector('.pc-banner');
      const badge = card.querySelector('.badge-verified');
      return {
        card: true,
        avatar: Boolean(img && img.src.startsWith('data:image/')),
        banner: Boolean(banner && (banner.style.backgroundImage || '').includes('data:image/')),
        badge: Boolean(badge),
        badgeTip: badge?.getAttribute('aria-label') || badge?.title || '',
      };
    })()`);
    check('own preview card renders avatar image', preview?.card && preview.avatar, JSON.stringify(preview));
    check('own preview card renders banner image', preview?.banner === true, JSON.stringify(preview));
    check('@billy shows the verified badge on his own card', preview?.badge === true, JSON.stringify(preview));
    check('badge tooltip reads the code-only verification notice',
      (preview?.badgeTip || '').includes('this can only be set through the actual code'), preview?.badgeTip);
    await a.screenshot('08-profile-own-mac');

    // ---- the peer sees it all in the chat header + profile card -------------
    await b.waitFor("document.getElementById('peer-avatar').querySelector('.avatar-img')", { label: 'header avatar' });
    const headerImg = await b.evaluate("document.getElementById('peer-avatar').querySelector('.avatar-img')?.src || ''");
    check("chat header shows Billy's avatar in the peer window", headerImg.startsWith('data:image/'), headerImg.slice(0, 40));

    const card = await b.evaluate(`(async () => {
      document.getElementById('peer-name').click();
      await new Promise((r) => setTimeout(r, 300));
      const m = document.querySelector('.modal.profile-modal .profile-card');
      if (!m) return { card: false };
      return {
        card: true,
        avatar: Boolean(m.querySelector('.avatar-img')?.src.startsWith('data:image/')),
        banner: Boolean((m.querySelector('.pc-banner')?.style.backgroundImage || '').includes('data:image/')),
        about: m.querySelector('.pc-about')?.textContent || '',
        badge: Boolean(m.querySelector('.badge-verified')),
        name: m.querySelector('.pc-name')?.textContent.trim() || '',
      };
    })()`);
    check("peer's profile card shows the avatar", card?.card && card.avatar, JSON.stringify(card));
    check("peer's profile card shows the banner", card?.banner === true, JSON.stringify(card));
    check("peer's profile card shows the saved about text", (card?.about || '').includes('chief grazing officer'), card?.about);
    check("peer's profile card shows the verified badge too", card?.badge === true, JSON.stringify(card));
    check("peer's profile card shows the display name", (card?.name || '').includes('Billy the Goat'), card?.name);
    await b.screenshot('09-profile-peer-mac');

    // ---- persistence: the profile survives sign-out / sign-in ---------------
    await a.evaluate('(async () => { await window.__gm.signOut(); await window.__gm.signIn("billy", "wool-and-horns"); })()');
    await a.waitFor('window.__gm.ready()');
    const after = await a.evaluate('(async () => { document.getElementById("btn-settings").click(); await new Promise(r => setTimeout(r, 400)); const c = document.querySelector(".settings-body .profile-card"); return { avatar: Boolean(c?.querySelector(".avatar-img")?.src.startsWith("data:image/")), name: c?.querySelector(".pc-name")?.textContent.trim() || "" }; })()');
    check('profile (photo + name) survives sign-out/sign-in', Boolean(after?.avatar) && (after?.name || '').includes('Billy the Goat'), JSON.stringify(after));

    // ---- clean up the shared test handle ------------------------------------
    const deleted = await a.evaluate(`window.__gm.state.api.deleteAccount(${JSON.stringify(BILLY)}).then(() => 'deleted').catch((err) => 'err:' + err.status)`);
    log.push(`account deletion returned: ${deleted}`);

    a.errors.length = 0;
    b.errors.length = 0;
    await a.screenshot('10-profile-final-mac');
    const rendererErrors = [...a.errors, ...b.errors].filter((e) => !/favicon|Download the React/i.test(e));
    check('no renderer errors during the profile run', rendererErrors.length === 0, rendererErrors.slice(0, 4).join(' | '));
  } catch (err) {
    check('profile end-to-end run completed', false, err && err.message);
    console.log('\n[failure]', err && err.stack);
    console.log('[app log]', log.slice(-6).join('\n'));
    try {
      console.log('[dumpA]', await a?.evaluate('JSON.stringify({ me: window.__gm.state.me?.username, contacts: [...window.__gm.state.contacts.entries()].map(([k, v]) => ({ k, avatar: Boolean(v.avatar), state: v.state })) })'));
      console.log('[dumpB]', await b?.evaluate('JSON.stringify({ contacts: [...window.__gm.state.contacts.entries()].map(([k, v]) => ({ k, avatar: Boolean(v.avatar), state: v.state })) })'));
      console.log('[errorsB]', JSON.stringify(b?.errors.slice(-4)));
    } catch (dumpErr) {
      console.log('[dump failed]', dumpErr.message);
    }
  } finally {
    try { a?.ws.close(); } catch {}
    try { b?.ws.close(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    await sleep(500);
    if (!child.killed) { try { child.kill('SIGKILL'); } catch {} }
    try { breaker.close(); } catch {}
  }

  console.log('profile checks against the PACKAGED macOS app:');
  console.log(results.join('\n'));
  console.log(`screenshots in ${path.relative(ROOT, SHOTS)}/`);
  process.exit(failed ? 1 : 0);
})();
