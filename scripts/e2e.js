// End-to-end test: launches the real desktop app with two isolated windows
// (two accounts), drives them over the DevTools protocol, and captures
// screenshots of what actually rendered.
//
//   node scripts/e2e.js
//
// Every check exercises the shipped code paths: the embedded relay, X3DH +
// Double Ratchet messaging, encrypted attachments, and a live WebRTC video call
// between the two windows (Chromium's fake capture devices stand in for a camera).
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = 9333;
const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'screenshots');
const RUN = Date.now().toString(36).slice(-5);
const ALICE = `alice${RUN}`;
const BOB = `bob${RUN}`;
const PASS = 'wool-and-horns';

const log = [];
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
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
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
        const e = msg.params.entry;
        this.errors.push(e.url ? `${e.text} (${e.url})` : e.text);
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
  const deadline = Date.now() + 25000;
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-e2e-'));
  const relayData = path.join(profile, 'relay');
  // GM_E2E_RELAY=http://192.168.1.50:8899 runs both windows against an external
  // relay (the same path the packaged app uses), instead of the embedded one.
  const remoteRelay = process.env.GM_E2E_RELAY || '';
  const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'electron'), [
    '--remote-debugging-port=' + PORT,
    `--user-data-dir=${path.join(profile, 'electron')}`,
    '.',
  ], {
    cwd: ROOT,
    env: remoteRelay
      ? { ...process.env, GM_E2E: '1', GM_FAKE_MEDIA: '1', GM_SERVER: remoteRelay }
      : { ...process.env, GM_E2E: '1', GM_FAKE_MEDIA: '1', GM_DATA_DIR: relayData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => log.push(`[app] ${d.toString().trim()}`));
  child.stderr.on('data', (d) => log.push(`[app] ${d.toString().trim()}`));

  let a;
  let b;
  try {
    [a, b] = await Promise.all([attach('e2e-a'), attach('e2e-b')]);

    await Promise.all([
      a.waitFor('window.__gm && window.__gm.booted()', { label: 'window A boot' }),
      b.waitFor('window.__gm && window.__gm.booted()', { label: 'window B boot' }),
    ]);
    check('both windows boot to the sign-in screen', true);
    if (remoteRelay) {
      const relayed = await a.evaluate('window.__gm.relayUrl()');

      check('window A uses the external relay', relayed === remoteRelay, `${relayed} vs ${remoteRelay}`);
      const viaNet = await fetch(remoteRelay + '/api/health').then((r) => r.json());
      check('external relay answers over the network', viaNet.ok === true);
    }
    await a.screenshot('01-sign-in');

    // ---- accounts ---------------------------------------------------------
    await a.evaluate(`window.__gm.signUp(${JSON.stringify(ALICE)}, ${JSON.stringify(PASS)}, 'Alice the Goat')`);
    await b.evaluate(`window.__gm.signUp(${JSON.stringify(BOB)}, ${JSON.stringify(PASS)}, 'Billy the Goat')`);
    await Promise.all([a.waitFor('window.__gm.ready()'), b.waitFor('window.__gm.ready()')]);
    const shellVisible = await a.evaluate("!document.getElementById('shell').hidden && !document.getElementById('empty-state').hidden");
    check('sign-up creates an account and opens the app shell', shellVisible);
    await a.screenshot('02-empty-state');

    // ---- sign-in from a clean window --------------------------------------
    const resigned = await a.evaluate(`(async () => {
      await window.__gm.signOut();
      await window.__gm.signIn(${JSON.stringify(ALICE)}, ${JSON.stringify(PASS)});
      return window.__gm.ready();
    })()`);
    check('sign out then sign in recovers keys from the passphrase', resigned === true);

    // ---- wrong passphrase --------------------------------------------------
    const wrong = await a.evaluate(`(async () => {
      await window.__gm.signOut();
      try { await window.__gm.signIn(${JSON.stringify(ALICE)}, 'not-the-passphrase'); return 'accepted'; }
      catch (err) { await window.__gm.signIn(${JSON.stringify(ALICE)}, ${JSON.stringify(PASS)}); return err.message; }
    })()`);
    check('a wrong passphrase is rejected', wrong !== 'accepted', String(wrong));
    await a.waitFor('window.__gm.ready()');
    // The deliberate 401 above is expected; start the error audit from here.
    a.errors.length = 0;
    a.console.length = 0;

    // ---- contact handshake -------------------------------------------------
    const addResult = await a.evaluate(`(async () => {
      try { await window.__gm.addContact(${JSON.stringify(BOB)}); return 'ok:' + JSON.stringify(window.__gm.contacts()); }
      catch (err) { return 'error:' + err.message; }
    })()`);
    log.push(`addContact -> ${addResult}`);
    log.push(`B ws readyState -> ${await b.evaluate('String(window.__gm.state.api.ws && window.__gm.state.api.ws.readyState)')}`);
    await b.waitFor(`window.__gm.contacts().some(c => c.username === ${JSON.stringify(ALICE)} && c.state === 'in')`, { label: 'incoming request' }).catch(async (err) => {
      log.push(`B contacts -> ${JSON.stringify(await b.evaluate('window.__gm.contacts()'))}`);
      throw err;
    });
    await b.evaluate(`window.__gm.acceptRequest(${JSON.stringify(ALICE)})`);
    await Promise.all([
      a.waitFor(`window.__gm.contacts().some(c => c.username === ${JSON.stringify(BOB)} && c.state === 'accepted')`, { label: 'A sees accepted' }),
      b.waitFor(`window.__gm.contacts().some(c => c.username === ${JSON.stringify(ALICE)} && c.state === 'accepted')`, { label: 'B sees accepted' }),
    ]);
    check('contact request, accept, and notification reach both windows', true);

    // ---- encrypted messaging ----------------------------------------------
    await a.evaluate(`window.__gm.openChat(${JSON.stringify(BOB)})`);
    await b.evaluate(`window.__gm.openChat(${JSON.stringify(ALICE)})`);
    await a.evaluate(`window.__gm.sendText('First words, sealed on my Mac. 🐐')`);
    await a.waitFor(`window.__gm.transcript(${JSON.stringify(BOB)}).some(m => m.dir === 'out' && m.status !== 'sending')`, { label: 'A message sent' });
    await b.waitFor(`window.__gm.transcript(${JSON.stringify(ALICE)}).some(m => m.text && m.text.includes('sealed on my Mac'))`, { label: 'B decrypts' });
    const received = await b.evaluate(`window.__gm.transcript(${JSON.stringify(ALICE)}).map(m => m.text).filter(Boolean)`);
    check('message encrypts, relays, and decrypts on the other window', received.some((t) => t.includes('sealed on my Mac')), JSON.stringify(received));

    const reply = await b.evaluate(`(async () => { await window.__gm.sendText('Baa. Got it, loud and clear.');
      return true; })()`);
    void reply;
    await a.waitFor(`window.__gm.transcript(${JSON.stringify(BOB)}).some(m => m.dir === 'in' && m.text && m.text.includes('loud and clear'))`, { label: 'A decrypts reply' });
    check('reply travels back through the ratchet', true);

    const statuses = await a.evaluate(`window.__gm.transcript(${JSON.stringify(BOB)}).map(m => m.status)`);
    check('read receipts arrive for outgoing messages', statuses.includes('read'), JSON.stringify(statuses));

    // ---- history + verify panel -------------------------------------------
    const safetyA = await a.evaluate(`window.__gm.safety(${JSON.stringify(BOB)})`);
    const safetyB = await b.evaluate(`window.__gm.safety(${JSON.stringify(ALICE)})`);
    check('safety numbers match across windows', safetyA === safetyB && safetyA.replace(/ /g, '').length === 60, `${safetyA} vs ${safetyB}`);

    // ---- encrypted attachment ---------------------------------------------
    const png = await a.evaluate(`(async () => {
      const c = document.createElement('canvas'); c.width = 420; c.height = 260;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 420, 260);
      g.addColorStop(0, '#cba06d'); g.addColorStop(1, '#4a3624');
      x.fillStyle = g; x.fillRect(0, 0, 420, 260);
      x.fillStyle = '#fdf7ec'; x.font = 'bold 40px -apple-system'; x.fillText('hai goat', 120, 145);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await window.__gm.sendFile('meadow.png', 'image/png', bytes);
      return bytes.length;
    })()`);
    check('attachment uploads encrypted to the relay', typeof png === 'number' && png > 1000, String(png));
    await b.waitFor(`window.__gm.transcript(${JSON.stringify(ALICE)}).some(m => m.kind === 'image')`, { label: 'B receives image' });
    await b.waitFor("document.querySelectorAll('#messages img.media-image').length > 0", { label: 'image decrypts in the DOM' });
    check('image decrypts and renders in the receiving window', true);

    // ---- voice note --------------------------------------------------------
    const voice = await b.evaluate(`(async () => {
      const bytes = new Uint8Array(9000).map((_, i) => (i * 7) % 256);
      await window.__gm.sendFile('voice-note.webm', 'audio/webm', bytes);
      return true;
    })()`);
    void voice;
    await a.waitFor(`window.__gm.transcript(${JSON.stringify(BOB)}).some(m => m.kind === 'file')`, { label: 'A receives file' });
    check('file attachment round-trips', true);

    // ---- voice note (records through the real MediaRecorder path) ----------
    await a.evaluate("document.getElementById('btn-voice').click()");
    await sleep(1400);
    await a.evaluate("document.getElementById('rec-send').click()");
    await b.waitFor(`window.__gm.transcript(${JSON.stringify(ALICE)}).some(m => m.kind === 'voice')`, { timeout: 20000, label: 'B receives voice note' });
    const voiceNote = await b.evaluate(`window.__gm.transcript(${JSON.stringify(ALICE)}).find(m => m.kind === 'voice')`);
    check('voice note records, encrypts and arrives', Boolean(voiceNote) && voiceNote.dir === 'in', JSON.stringify(voiceNote));
    await a.screenshot('03-conversation');

    // ---- chat list preview -------------------------------------------------
    await a.evaluate(`window.__gm.sendText('Are you there?')`);
    await sleep(900);
    const preview = await b.evaluate("document.querySelector('.chat-row .chat-preview')?.textContent || ''");
    check('chat list shows the decrypted preview', preview.includes('Are you there?'), preview);

    // ---- live video call ---------------------------------------------------
    await a.evaluate(`window.__gm.startCall('video')`);
    await b.waitFor("!document.getElementById('incoming').hidden", { timeout: 25000, label: 'incoming call UI' });
    await b.screenshot('04-incoming-call');
    check('call invite rings the other window', true);
    await b.evaluate('window.__gm.acceptCall()');
    await Promise.all([
      a.waitFor("window.__gm.callState().pc === 'connected'", { timeout: 30000, label: 'A peer connection' }),
      b.waitFor("window.__gm.callState().pc === 'connected'", { timeout: 30000, label: 'B peer connection' }),
    ]);
    const callA = await a.evaluate('window.__gm.callState()');
    const callB = await b.evaluate('window.__gm.callState()');
    check('WebRTC connects with live audio and video tracks',
      callA.state === 'connected' && callB.state === 'connected'
      && callA.remoteTracks.includes('video') && callA.remoteTracks.includes('audio')
      && callB.remoteTracks.includes('video'),
      JSON.stringify({ a: callA, b: callB }));
    check('both sides derive the same call security code', callA.code === callB.code && callA.code.length === 6, `${callA.code} / ${callB.code}`);
    const videoLive = await a.evaluate("document.getElementById('remote-video').classList.contains('live')");
    check('remote video stream is attached and rendering', videoLive === true);

    // ---- media path: what actually protects the audio/video ----------------
    await sleep(1400);
    const statsA = await a.evaluate('window.__gm.callStats()');
    const statsB = await b.evaluate('window.__gm.callStats()');
    const certsA = (statsA?.certificates || []).slice().sort();
    const certsB = (statsB?.certificates || []).slice().sort();
    check('media runs over a DTLS transport that completed a handshake',
      statsA?.transport?.dtlsState === 'connected' && statsB?.transport?.dtlsState === 'connected',
      JSON.stringify({ a: statsA?.transport, b: statsB?.transport }));
    check('SRTP encryption is negotiated for the media stream',
      Boolean(statsA?.transport?.srtpCipher) && statsA.transport.srtpCipher === statsB.transport.srtpCipher,
      `${statsA?.transport?.srtpCipher} / ${statsB?.transport?.srtpCipher}`);
    check('both ends pinned the same DTLS certificate pair (no man in the middle)',
      certsA.length === 2 && JSON.stringify(certsA) === JSON.stringify(certsB),
      `A=${certsA.length} B=${certsB.length}`);
    const pairA = statsA?.pair;
    const pairB = statsB?.pair;
    const mediaPorts = [pairA?.localCandidate?.port, pairA?.remoteCandidate?.port, pairB?.localCandidate?.port, pairB?.remoteCandidate?.port];
    check('media flows peer-to-peer, never through the relay port',
      pairA?.state === 'succeeded' && pairA.bytesSent > 0 && pairA.bytesReceived > 0
      && !mediaPorts.includes(statsA?.relayPort),
      JSON.stringify({ pairA, pairB, mediaPorts, relayPort: statsA?.relayPort }));

    console.log(`  media: dtls=${statsA.transport.dtlsState} srtp=${statsA.transport.srtpCipher} certs=${certsA.length} ports=${mediaPorts.join('/')} relayPort=${statsA.relayPort} bytes=${pairA.bytesSent}/${pairA.bytesReceived}`);

    // ---- TURN path (only when the run is configured to force it) -----------
    if (process.env.GM_E2E_TURN === '1') {
      const turnState = await a.evaluate('window.__gm.callState()');
      check('calls are configured to use the TURN relay', turnState.usingTurn === true && turnState.icePolicy === 'relay',
        `${turnState.usingTurn} / ${turnState.icePolicy}`);
      check('the media path is a TURN relay candidate',
        pairA?.localCandidate?.type === 'relay' && pairB?.localCandidate?.type === 'relay',
        JSON.stringify({ a: pairA?.localCandidate, b: pairB?.localCandidate }));
      const relayed = await a.evaluate('window.__gm.relayUrl()');
      console.log('  turn-config:', JSON.stringify(await a.evaluate('window.__gm.net()')));
      const token = process.env.GM_TURN_STATS_TOKEN || 'test-turn-token';
      const turnStats = await fetch(`${relayed}/api/turn-stats?token=${token}`).then((r) => r.json()).catch((err) => ({ error: err.message }));
      check('the TURN relay actually forwarded the call',
        Boolean(turnStats.ok !== false) && turnStats.packetsRelayed > 0 && turnStats.allocationsTotal >= 2,
        JSON.stringify(turnStats));
      console.log(`  turn: ${JSON.stringify(turnStats)}`);
    }

    // ---- screen sharing over the same encrypted call -----------------------
    const sources = await a.evaluate('window.__gm.screenSources()');
    check('desktop capture enumerates screens and windows',
      Array.isArray(sources.sources) && sources.sources.length > 0,
      `${sources.sources?.length || 0} sources, permission ${sources.permission}`);
    const screenSource = (sources.sources || []).find((src) => src.kind === 'screen') || (sources.sources || [])[0];
    if (screenSource) {
      const shareError = await a.evaluate(`window.__gm.startShare(${JSON.stringify(screenSource.id)}).then(() => '').catch((err) => err.name + ': ' + err.message)`);
      check('screen share starts without renegotiating the call', shareError === '', shareError || screenSource.name);
      if (!shareError) {
        await b.waitFor('window.__gm.callState().peerSharing === true', { timeout: 15000, label: 'B sees the share signal' });
        const sharingA = await a.evaluate('window.__gm.callState()');
        check('sharing side sends the screen track', sharingA.sharing === true && sharingA.sendingVideo === true, JSON.stringify(sharingA));
        let bVideo = null;
        for (let i = 0; i < 40; i++) {
          bVideo = await b.evaluate('window.__gm.callState().remoteVideo');
          if (bVideo && bVideo.width > 0) break;
          await sleep(250);
        }
        check('the other window receives screen frames', Boolean(bVideo && bVideo.width > 0),
          JSON.stringify(bVideo));
        const shareStage = await b.evaluate("document.getElementById('remote-video').classList.contains('live') && !document.getElementById('call-share-pill').hidden");
        check('receiver shows the shared screen with a sharing notice', shareStage === true);
        await sleep(900);
        await b.screenshot('05c-screen-share');
        await a.screenshot('05d-sharing-controls');

        const before = (await b.evaluate('window.__gm.callState()')).remoteVideo;
        await a.evaluate('window.__gm.stopShare()');
        await b.waitFor('window.__gm.callState().peerSharing === false', { timeout: 15000, label: 'B sees sharing stop' });
        const after = (await b.evaluate('window.__gm.callState()')).remoteVideo;
        check('stopping the share returns to the camera feed',
          Boolean(after) && (after.width !== (before?.width || 0) || after.width > 0),
          JSON.stringify({ before, after }));
        const restored = await a.evaluate('window.__gm.callState()');
        check('sharing side falls back to its camera', restored.sharing === false && restored.sendingVideo === true, JSON.stringify(restored));
      }
    }

    await sleep(1200);
    await a.screenshot('05-video-call');
    await b.screenshot('05b-video-call-receiver');

    await a.evaluate('window.__gm.hangup()');
    await b.waitFor("window.__gm.callState().state === 'idle'", { label: 'B call ended' });
    await sleep(400);
    const note = await a.evaluate(`window.__gm.transcript(${JSON.stringify(BOB)}).filter(m => m.kind === 'call').length`);
    check('call ends cleanly and leaves a record', note > 0, String(note));

    // ---- voice-only call ---------------------------------------------------
    await b.evaluate(`window.__gm.startCall('audio')`);
    await a.waitFor("!document.getElementById('incoming').hidden", { timeout: 25000, label: 'incoming audio call' });
    await a.evaluate('window.__gm.acceptCall()');
    await Promise.all([
      a.waitFor("window.__gm.callState().state === 'connected'", { timeout: 30000, label: 'A audio call' }),
      b.waitFor("window.__gm.callState().state === 'connected'", { timeout: 30000, label: 'B audio call' }),
    ]);
    const audioA = await a.evaluate('window.__gm.callState()');
    // A voice call still reserves the video slot (that is what makes later
    // screen sharing instant), so assert no picture is actually flowing.
    const audioOnly = audioA.remoteTracks.includes('audio')
      && (!audioA.remoteVideo || audioA.remoteVideo.muted || audioA.remoteVideo.width === 0)
      && !(await a.evaluate("document.getElementById('remote-video').classList.contains('live')"));
    check('voice call connects with audio only', audioOnly, JSON.stringify(audioA));
    await a.screenshot('06-audio-call');
    await b.evaluate('window.__gm.hangup()');
    await sleep(500);

    // ---- persistence -------------------------------------------------------
    await sleep(600);
    const beforeRestart = await a.evaluate(`window.__gm.transcript(${JSON.stringify(BOB)}).length`);
    check('transcript retained in local history', beforeRestart >= 5, String(beforeRestart));

    await a.screenshot('07-final');

    const rendererErrors = [...a.errors, ...b.errors].filter((e) => !/favicon|Download the React/i.test(e));
    check('no renderer errors during the whole run', rendererErrors.length === 0, rendererErrors.slice(0, 4).join(' | '));

    const consoleNoise = a.console.filter((l) => l.startsWith('error')).concat(b.console.filter((l) => l.startsWith('error')));
    if (consoleNoise.length) log.push(`renderer console errors: ${consoleNoise.slice(0, 5).join(' | ')}`);
  } catch (err) {
    check('end-to-end run completed', false, err && err.message);
    console.log('\n[failure]', err && err.stack);
    try {
      const dumpA = await a?.evaluate('JSON.stringify({ call: window.__gm.callState(), incoming: !document.getElementById("incoming").hidden, recorder: Boolean(window.__gm.state.recorder), lastError: window.__gm.state.calls?.lastError || null })');
      const dumpB = await b?.evaluate('JSON.stringify({ call: window.__gm.callState(), incoming: !document.getElementById("incoming").hidden, ws: window.__gm.state.api.ws?.readyState, contacts: window.__gm.contacts() })');
      console.log('[dumpA]', dumpA);
      console.log('[dumpB]', dumpB);
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
  }

  console.log('end-to-end checks (two live windows, real crypto, real WebRTC):');
  console.log(results.join('\n'));
  if (log.length) console.log(`\napp log:\n${log.join('\n')}`);
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
  console.log(`screenshots in ${path.relative(ROOT, SHOTS)}/`);
  process.exit(failed ? 1 : 0);
})();
