// Renders the DMG window background: camel/cream GoatMessenger artwork with a
// simple arrow drawn straight between the app icon (left) and the Applications
// folder (right). Matched to the icon positions set by package-dmg.js:
//   app          at {150, 440}
//   Applications at {900, 440}
// Window is 1050x680 — written to build/dmg-background.png.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const OUT = path.join(BUILD, 'dmg-background.png');

const W = 1050;
const H = 680;

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  canvas{display:block;width:${W}px;height:${H}px}
</style></head><body><canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const W = ${W}, H = ${H};
const c = document.getElementById('c');
const ctx = c.getContext('2d');

function build() {
  // ------- paper ------------------------------------------------------------
  ctx.clearRect(0, 0, W, H);
  const paper = ctx.createLinearGradient(0, 0, 0, H);
  paper.addColorStop(0, '#f9f3e6');
  paper.addColorStop(1, '#f1e2c9');
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, W, H);

  // ------- titles ------------------------------------------------------------
  ctx.fillStyle = '#2e2116';
  ctx.textAlign = 'center';
  ctx.font = '700 44px "New York", ui-serif, Georgia, serif';
  ctx.fillText('GoatMessenger', W / 2, 92);
  ctx.fillStyle = 'rgba(74, 54, 36, 0.6)';
  ctx.font = '19px "New York", ui-serif, Georgia, serif';
  ctx.fillText('Drag the goat into Applications to install', W / 2, 130);

  // ------- the arrow ----------------------------------------------------------
  // One simple straight arrow on the line between the two icons.
  const y = 440;
  const from = 245;   // just right of the app icon
  const to = 800;     // just left of the Applications folder
  ctx.save();
  ctx.lineCap = 'round';

  ctx.strokeStyle = 'rgba(46, 33, 22, 0.75)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(from, y);
  ctx.lineTo(to - 26, y);
  ctx.stroke();

  ctx.fillStyle = 'rgba(46, 33, 22, 0.75)';
  ctx.beginPath();
  ctx.moveTo(to, y);
  ctx.lineTo(to - 30, y - 17);
  ctx.lineTo(to - 30, y + 17);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // ------- labels under the icons ---------------------------------------------
  ctx.fillStyle = 'rgba(74, 54, 36, 0.62)';
  ctx.textAlign = 'center';
  ctx.font = '17px "New York", ui-serif, Georgia, serif';
  ctx.fillText('GoatMessenger', 150, 596);
  ctx.fillText('Applications', 900, 596);

  window.__ready = true;
}

build();
</script></body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(BUILD, { recursive: true });
  const htmlPath = path.join(BUILD, 'dmg-bg.html');
  fs.writeFileSync(htmlPath, page);
  const win = new BrowserWindow({
    width: W, height: H, useContentSize: true, x: -4000, y: 0,
    show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadFile(htmlPath);
  const ready = async () => { try { return await win.webContents.executeJavaScript('window.__ready === true'); } catch { return false; } };
  for (let i = 0; i < 60; i++) {
    if (await ready()) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 250));
  const shot = await win.webContents.executeJavaScript("document.getElementById('c').toDataURL('image/png')");
  fs.writeFileSync(OUT, Buffer.from(String(shot).split(',')[1], 'base64'));
  console.log('rendered', path.relative(ROOT, OUT));
  win.destroy();
  app.quit();
});
