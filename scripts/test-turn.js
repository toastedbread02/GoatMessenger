// Verifies the bundled TURN server against a real WebRTC client.
//
// Two peer connections in one Chromium renderer are configured with
// iceTransportPolicy:'relay', so host and server-reflexive candidates are
// discarded by the browser: the only way media can flow is through our TURN
// relay. The test then checks the negotiated transport and the relay's own
// counters.
//
// Run: npx electron scripts/test-turn.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { createTurnServer } = require('../server/turn');

const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const PAGE = `<!doctype html><html><body><canvas id="c" width="320" height="180"></canvas><script>
window.runTurnTest = async (cfg) => {
  // Real media: a moving canvas plus an oscillator tone.
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  let t = 0;
  setInterval(() => {
    t += 0.05;
    ctx.fillStyle = '#cba06d';
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#3a2a1a';
    ctx.beginPath();
    ctx.arc(160 + Math.cos(t) * 60, 90 + Math.sin(t) * 40, 26, 0, Math.PI * 2);
    ctx.fill();
  }, 40);

  const ac = new AudioContext();
  const osc = ac.createOscillator();
  const dest = ac.createMediaStreamDestination();
  const gain = ac.createGain();
  gain.gain.value = 0.02;
  osc.connect(gain).connect(dest);
  osc.start();

  const stream = new MediaStream([
    ...canvas.captureStream(15).getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);

  const config = {
    iceServers: [{ urls: cfg.url, username: cfg.username, credential: cfg.credential }],
    iceTransportPolicy: 'relay',
  };
  const a = new RTCPeerConnection(config);
  const b = new RTCPeerConnection(config);
  const received = new MediaStream();
  b.ontrack = (e) => { received.addTrack(e.track); };
  for (const track of stream.getTracks()) a.addTrack(track, stream);

  a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
  b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };

  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(offer);
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(answer);

  const waitConnected = (pc) => new Promise((resolve, reject) => {
    if (pc.connectionState === 'connected') return resolve();
    const timer = setTimeout(() => reject(new Error('timeout: ' + pc.connectionState)), 20000);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { clearTimeout(timer); resolve(); }
      else if (pc.connectionState === 'failed') { clearTimeout(timer); reject(new Error('failed')); }
    };
  });

  try {
    await Promise.all([waitConnected(a), waitConnected(b)]);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  await new Promise((r) => setTimeout(r, 1500));

  const snap = async (pc) => {
    const report = await pc.getStats();
    const rows = [];
    report.forEach((s) => rows.push({ id: s.id, ...s }));
    const transport = rows.find((r) => r.type === 'transport');
    const pairs = rows.filter((r) => r.type === 'candidate-pair');
    const pair = pairs.find((p) => p.selected) || pairs.find((p) => p.state === 'succeeded') || null;
    const local = pair ? rows.find((r) => r.id === pair.localCandidateId) : null;
    const remote = pair ? rows.find((r) => r.id === pair.remoteCandidateId) : null;
    const inbound = rows.filter((r) => r.type === 'inbound-rtp');
    const outbound = rows.filter((r) => r.type === 'outbound-rtp');
    return {
      connectionState: pc.connectionState,
      iceState: pc.iceConnectionState,
      dtlsState: transport ? transport.dtlsState : null,
      srtpCipher: transport ? transport.srtpCipher : null,
      localCandidate: local ? { type: local.candidateType, protocol: local.protocol, port: local.port, address: local.address } : null,
      remoteCandidate: remote ? { type: remote.candidateType, protocol: remote.protocol, port: remote.port, address: remote.address } : null,
      inbound: inbound.map((r) => ({ kind: r.kind, bytes: r.bytesReceived, packets: r.packetsReceived })),
      outbound: outbound.map((r) => ({ kind: r.kind, bytes: r.bytesSent })),
      tracks: received.getTracks().map((tr) => tr.kind),
      trackStates: received.getTracks().map((tr) => tr.readyState),
    };
  };

  const sa = await snap(a);
  const sb = await snap(b);
  for (const tr of stream.getTracks()) tr.stop();
  a.close(); b.close(); ac.close();
  return { ok: true, a: sa, b: sb };
};
</script></body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const turn = createTurnServer({
    port: 0,
    publicIp: '127.0.0.1',
    realm: 'goatmessenger-test',
    user: 'goat',
    pass: 'test-secret',
    verbose: true,
  });
  const bound = await turn.listen();
  console.log(`[test] TURN listening on udp ${bound.port}`);

  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));

  const cfg = {
    url: `turn:127.0.0.1:${bound.port}?transport=udp`,
    username: 'goat',
    credential: 'test-secret',
  };
  const result = await win.webContents.executeJavaScript(
    `window.runTurnTest(${JSON.stringify(cfg)})`,
  );

  if (!result.ok) {
    check('peers connect through the TURN relay', false, result.error);
  } else {
    const { a, b } = result;
    check('peers connect through the TURN relay', a.connectionState === 'connected' && b.connectionState === 'connected');
    check('both sides report a relay candidate', a.localCandidate?.type === 'relay' && b.localCandidate?.type === 'relay',
      `a=${a.localCandidate?.type} b=${b.localCandidate?.type}`);
    check('relay candidates are reachable', Boolean(a.remoteCandidate) && Boolean(b.remoteCandidate));
    check('DTLS handshake completed over TURN', a.dtlsState === 'connected' && b.dtlsState === 'connected', `${a.dtlsState}/${b.dtlsState}`);
    check('SRTP cipher negotiated', /AES_CM_128/.test(a.srtpCipher || ''), String(a.srtpCipher));
    const bytesIn = [...a.inbound, ...b.inbound].reduce((n, r) => n + (r.bytes || 0), 0);
    check('media bytes arrive through the relay', bytesIn > 0, `${bytesIn} bytes`);
    check('audio and video tracks arrive', b.tracks.includes('video') && b.tracks.includes('audio'), b.tracks.join(','));
    console.log('[test] transport', JSON.stringify({ a: a.localCandidate, b: b.localCandidate, dtls: a.dtlsState, cipher: a.srtpCipher }));
  }

  const stats = turn.stats();
  console.log('[test] turn stats', JSON.stringify(stats));
  check('relay recorded allocations', stats.allocationsTotal >= 2, `${stats.allocationsTotal}`);
  check('relay forwarded packets', stats.packetsRelayed > 0, `${stats.packetsRelayed} packets / ${stats.bytesRelayed} bytes`);

  turn.close();
  win.destroy();

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  app.exit(failed ? 1 : 0);
});
