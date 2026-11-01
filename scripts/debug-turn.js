// Debug: what does Chromium's ICE stack say about our TURN server?
const { app, BrowserWindow } = require('electron');
const { createTurnServer } = require('../server/turn');

const PAGE = `<!doctype html><html><body><script>
window.probe = async (cfg) => {
  const logs = [];
  const pc = new RTCPeerConnection({
    iceServers: [cfg],
    iceTransportPolicy: 'relay',
  });
  const info = pc.getConfiguration().iceServers;
  pc.onicecandidateerror = (e) => logs.push({ kind: 'error', code: e.errorCode, text: e.errorText, url: e.url, address: e.address });
  pc.onicecandidate = (e) => {
    if (e.candidate) logs.push({ kind: 'candidate', c: e.candidate.candidate, type: e.candidate.type });
    else logs.push({ kind: 'end' });
  };
  pc.createDataChannel('x');
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise((r) => setTimeout(r, 6000));
  pc.close();
  return { info, logs };
};
</script></body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const turn = createTurnServer({ port: 0, publicIp: '127.0.0.1', realm: 'goatmessenger', user: 'goat', pass: 'test-secret', verbose: true });
  const bound = await turn.listen();
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  const cfg = { urls: `turn:127.0.0.1:${bound.port}?transport=udp`, username: 'goat', credential: 'test-secret' };
  const out = await win.webContents.executeJavaScript(`window.probe(${JSON.stringify(cfg)})`);
  console.log('iceServers seen by Chromium:', JSON.stringify(out.info));
  for (const line of out.logs) console.log(JSON.stringify(line));
  turn.close();
  win.destroy();
  app.exit(0);
});
