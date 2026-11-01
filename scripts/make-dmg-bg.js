// Renders the DMG window background: camel/cream GoatMessenger artwork with a
// big friendly arrow curling from the app icon (left) to the Applications
// folder (right). Matched to the icon positions set by package-dmg.js:
//   app          at {240, 640}
//   Applications at {1200, 640}
// Written to build/dmg-background.png (1440x900).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const LOGO = path.join(BUILD, 'original-logo.png');
const OUT = path.join(BUILD, 'dmg-background.png');

const W = 1440;
const H = 900;

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  canvas{display:block;width:${W}px;height:${H}px}
</style></head><body><canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const LOGO = "__LOGO__";
const W = ${W}, H = ${H};
const c = document.getElementById('c');
const ctx = c.getContext('2d');

async function goatMark() {
  // Pull the espresso line-work out of the original tile, like make-icon.js.
  const img = new Image();
  img.src = LOGO;
  await img.decode();
  const tmp = document.createElement('canvas');
  tmp.width = img.naturalWidth; tmp.height = img.naturalHeight;
  const t = tmp.getContext('2d', { willReadFrequently: true });
  t.drawImage(img, 0, 0);
  const d = t.getImageData(0, 0, tmp.width, tmp.height).data;
  const corner = ((Math.floor(4) * tmp.width) + 4) * 4;
  const bgLum = 0.2126 * d[corner] + 0.7152 * d[corner + 1] + 0.0722 * d[corner + 2];
  const glyph = document.createElement('canvas');
  glyph.width = tmp.width; glyph.height = tmp.height;
  const g = glyph.getContext('2d');
  const out = g.createImageData(tmp.width, tmp.height);
  const o = out.data;
  let minX = tmp.width, minY = tmp.height, maxX = 0, maxY = 0;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const e0 = bgLum - 12, e1 = bgLum - 78;
    const x = Math.min(1, Math.max(0, (lum - e0) / (e1 - e0)));
    const a = x * x * (3 - 2 * x);
    o[i] = 58; o[i + 1] = 41; o[i + 2] = 26;
    o[i + 3] = Math.round(a * 255);
    if (a > 0.30) {
      const p = i / 4, px = p % tmp.width, py = (p / tmp.width) | 0;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
  }
  g.putImageData(out, 0, 0);
  const cw = maxX - minX + 12, ch = maxY - minY + 12;
  const cropped = document.createElement('canvas');
  cropped.width = cw; cropped.height = ch;
  cropped.getContext('2d').drawImage(glyph, -(minX - 6), -(minY - 6));
  return cropped;
}

function build(mark) {
  // ------- paper ------------------------------------------------------------
  ctx.clearRect(0, 0, W, H);
  const paper = ctx.createLinearGradient(0, 0, 0, H);
  paper.addColorStop(0, '#f8f0e3');
  paper.addColorStop(0.65, '#f3e6d0');
  paper.addColorStop(1, '#ecd9bd');
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, W, H);

  // warm glow behind the arrow path
  const glow = ctx.createRadialGradient(W / 2, H * 0.46, 60, W / 2, H * 0.5, W * 0.55);
  glow.addColorStop(0, 'rgba(214, 175, 121, 0.34)');
  glow.addColorStop(1, 'rgba(214, 175, 121, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // faint arch line-work along the top, matching the sign-in art mood
  ctx.save();
  ctx.strokeStyle = 'rgba(46, 33, 22, 0.07)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const r = 620 + i * 90;
    ctx.beginPath();
    ctx.arc(W / 2, 240, r, Math.PI * 1.12, Math.PI * 1.88);
    ctx.stroke();
  }
  ctx.restore();

  // ghost goat watermark, top corners
  ctx.save();
  ctx.globalAlpha = 0.10;
  ctx.drawImage(mark, 76, 62, 132, 132 * (mark.height / mark.width));
  ctx.drawImage(mark, W - 200, 62, 128, 128 * (mark.height / mark.width));
  ctx.restore();

  // ------- titles ------------------------------------------------------------
  ctx.fillStyle = '#2e2116';
  ctx.textAlign = 'center';
  ctx.font = '700 64px "New York", ui-serif, Georgia, serif';
  ctx.fillText('GoatMessenger', W / 2, 150);
  ctx.fillStyle = 'rgba(74, 54, 36, 0.62)';
  ctx.font = '24px "New York", ui-serif, Georgia, serif';
  ctx.fillText('Drag the goat into Applications to install', W / 2, 208);

  // ------- landing rings -----------------------------------------------------
  const ring = (x, y) => {
    ctx.save();
    ctx.setLineDash([9, 10]);
    ctx.strokeStyle = 'rgba(74, 54, 36, 0.28)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 86, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };
  ring(240, 640);
  ring(1200, 640);

  ctx.fillStyle = 'rgba(74, 54, 36, 0.58)';
  ctx.textAlign = 'center';
  ctx.font = '22px "New York", ui-serif, Georgia, serif';
  ctx.fillText('GoatMessenger', 240, 762);
  ctx.font = '22px "New York", ui-serif, Georgia, serif';
  ctx.fillText('Applications', 1200, 762);

  // ------- the arrow ----------------------------------------------------------
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // wide camel ribbon under an espresso line, drawn twice for depth
  const sx = 240, sy = 640 - 176;  // start above the app ring
  const ex = 1200, ey = 640 - 176; // end above Applications
  const drawPath = (width, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(sx + 10, sy);
    ctx.bezierCurveTo(sx + 40, sy - 210, ex - 60, sy - 210, ex, ey);
    ctx.stroke();
  };
  drawPath(54,  'rgba(184, 139, 88, 0.55)');
  drawPath(44,  '#c69c69');
  drawPath(3.5, 'rgba(46, 33, 22, 0.55)');

  // arrowhead at the Applications end, pointing down at the folder
  ctx.fillStyle = '#c69c69';
  ctx.strokeStyle = 'rgba(46, 33, 22, 0.55)';
  ctx.lineWidth = 3.5;
  ctx.save();
  ctx.translate(ex, ey - 6);
  ctx.beginPath();
  ctx.moveTo(0, 118);          // tip, just above the Applications ring
  ctx.lineTo(-34, 62);
  ctx.lineTo(34, 62);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  ctx.restore();

  window.__ready = true;
  return true;
}
goatMark().then(build);
</script></body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(BUILD, { recursive: true });
  const htmlPath = path.join(BUILD, 'dmg-bg.html');
  fs.writeFileSync(htmlPath, page.replace('__LOGO__', `data:image/png;base64,${fs.readFileSync(LOGO).toString('base64')}`));
  const win = new BrowserWindow({
    width: W, height: H, useContentSize: true, x: -4000, y: 0,
    make: undefined, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
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
