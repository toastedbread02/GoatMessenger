// Renders the GoatMessenger app icon with Chromium and writes the .icns.
//
// The goat itself is lifted from the original artwork: the tan background is
// converted to transparency by luminance, so only the espresso line-work
// survives, and it is re-laid onto a macOS-style squircle with depth.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const LOGO = path.join(BUILD, 'original-logo.png');
const OUT_PNG = path.join(BUILD, 'icon-1024.png');
const ICONSET = path.join(BUILD, 'goatmessenger.iconset');
const FLAT_PNG = path.join(BUILD, 'icon-flat-1024.png');
const ICNS = path.join(BUILD, 'goatmessenger.icns');
const ICO = path.join(BUILD, 'goatmessenger.ico');
const UI_LOGO = path.join(ROOT, 'app', 'assets', 'icon.png');

const SIZE = 1024;

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  canvas{display:block;width:${SIZE}px;height:${SIZE}px}
</style></head><body><canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script>
const LOGO = "__LOGO__";
const S = ${SIZE};
const FLAT = location.hash.includes('flat');
const c = document.getElementById('c');
const ctx = c.getContext('2d');

function squircle(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

async function build() {
  const img = new Image();
  img.src = LOGO;
  await img.decode();

  // --- pull the line-work out of the original tan tile -------------------
  const tmp = document.createElement('canvas');
  tmp.width = img.naturalWidth; tmp.height = img.naturalHeight;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(img, 0, 0);
  const src = tctx.getImageData(0, 0, tmp.width, tmp.height);
  const d = src.data;
  const corner = ((Math.floor(4) * tmp.width) + 4) * 4;
  const bgLum = 0.2126 * d[corner] + 0.7152 * d[corner + 1] + 0.0722 * d[corner + 2];

  const mask = document.createElement('canvas');
  mask.width = tmp.width; mask.height = tmp.height;
  const mctx = mask.getContext('2d');
  const dst = mctx.createImageData(tmp.width, tmp.height);
  const out = dst.data;
  let minX = tmp.width, minY = tmp.height, maxX = 0, maxY = 0;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const a = smoothstep(bgLum - 12, bgLum - 78, lum); // dark strokes -> opaque
    out[i] = 58; out[i + 1] = 41; out[i + 2] = 26;    // espresso
    out[i + 3] = Math.round(a * 255);
    if (a > 0.12) {
      const p = i / 4;
      const x = p % tmp.width;
      const y = (p / tmp.width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  mctx.putImageData(dst, 0, 0);

  const pad = 6;
  const cw = Math.max(1, maxX - minX + pad * 2);
  const ch = Math.max(1, maxY - minY + pad * 2);
  const cropped = document.createElement('canvas');
  cropped.width = cw; cropped.height = ch;
  cropped.getContext('2d').drawImage(mask, -(minX - pad), -(minY - pad));

  // --- the tile ----------------------------------------------------------
  ctx.clearRect(0, 0, S, S);
  const inset = 74;
  const w = S - inset * 2;
  const h = S - inset * 2;
  const r = w * 0.235;

  // The Dock and Finder draw their own shadow, so the .icns variant skips it.
  if (!FLAT) {
    ctx.save();
    ctx.shadowColor = 'rgba(58, 40, 22, 0.34)';
    ctx.shadowBlur = 34;
    ctx.shadowOffsetY = 20;
    squircle(inset, inset, w, h, r);
    ctx.fillStyle = '#c69c69';
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  squircle(inset, inset, w, h, r);
  ctx.clip();

  // base camel gradient
  const base = ctx.createLinearGradient(inset, inset, inset + w, inset + h);
  base.addColorStop(0, '#f2dcbc');
  base.addColorStop(0.34, '#d9b183');
  base.addColorStop(0.7, '#bf8f5b');
  base.addColorStop(1, '#9d6b3f');
  ctx.fillStyle = base;
  ctx.fillRect(inset, inset, w, h);

  // warm light from the top-left
  const glow = ctx.createRadialGradient(inset + w * 0.26, inset + h * 0.16, 10, inset + w * 0.3, inset + h * 0.18, w * 0.86);
  glow.addColorStop(0, 'rgba(255, 250, 238, 0.55)');
  glow.addColorStop(0.5, 'rgba(255, 245, 228, 0.16)');
  glow.addColorStop(1, 'rgba(255, 240, 214, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(inset, inset, w, h);

  // faint vignette so the edges sit back
  const vig = ctx.createRadialGradient(inset + w / 2, inset + h / 2, w * 0.42, inset + w / 2, inset + h / 2, w * 0.78);
  vig.addColorStop(0, 'rgba(58, 40, 22, 0)');
  vig.addColorStop(1, 'rgba(58, 40, 22, 0.10)');
  ctx.fillStyle = vig;
  ctx.fillRect(inset, inset, w, h);

  // settle the bottom edge
  const shade = ctx.createLinearGradient(inset, inset + h * 0.55, inset, inset + h);
  shade.addColorStop(0, 'rgba(58, 40, 22, 0)');
  shade.addColorStop(1, 'rgba(58, 40, 22, 0.22)');
  ctx.fillStyle = shade;
  ctx.fillRect(inset, inset, w, h);

  // --- the goat ----------------------------------------------------------
  const goatH = h * 0.61;
  const goatW = goatH * (cw / ch);
  const gx = inset + (w - goatW) / 2;
  const gy = inset + (h - goatH) / 2 - h * 0.014;

  // soft cream spotlight so the mark sits in light instead of on flat colour
  const spot = ctx.createRadialGradient(
    inset + w / 2, inset + h * 0.46, goatW * 0.06,
    inset + w / 2, inset + h * 0.46, goatW * 0.78,
  );
  spot.addColorStop(0, 'rgba(255, 249, 236, 0.42)');
  spot.addColorStop(0.55, 'rgba(255, 244, 224, 0.16)');
  spot.addColorStop(1, 'rgba(255, 240, 214, 0)');
  ctx.fillStyle = spot;
  ctx.fillRect(inset, inset, w, h);

  // embossed: a warm highlight just under the line-work, then the ink itself
  ctx.save();
  ctx.globalAlpha = 0.30;
  ctx.globalCompositeOperation = 'source-over';
  const emb = goatW * 0.006;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.drawImage(cropped, gx + Math.cos(a) * emb, gy + Math.sin(a) * emb + goatH * 0.008, goatW, goatH);
  }
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.restore();

  // Monoline strokes lose too much weight at 16-32px, so thicken the mask by
  // stamping it at small radial offsets (a morphological dilation).
  const weight = goatW * 0.0075;
  ctx.save();
  ctx.globalAlpha = 1;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ctx.drawImage(cropped, gx + Math.cos(a) * weight, gy + Math.sin(a) * weight, goatW, goatH);
  }
  ctx.drawImage(cropped, gx, gy, goatW, goatH);
  ctx.restore();

  // inner bevel: light catches the top wall, shadow pools at the bottom
  ctx.save();
  ctx.lineWidth = 16;
  const bevel = ctx.createLinearGradient(inset, inset, inset, inset + h);
  bevel.addColorStop(0, 'rgba(255, 252, 244, 0.55)');
  bevel.addColorStop(0.35, 'rgba(255, 250, 238, 0.08)');
  bevel.addColorStop(0.82, 'rgba(60, 40, 22, 0.05)');
  bevel.addColorStop(1, 'rgba(60, 40, 22, 0.30)');
  ctx.strokeStyle = bevel;
  squircle(inset + 8, inset + 8, w - 16, h - 16, r - 8);
  ctx.stroke();
  ctx.restore();

  // glassy rim
  ctx.lineWidth = 7;
  const rim = ctx.createLinearGradient(inset, inset, inset, inset + h);
  rim.addColorStop(0, 'rgba(255, 255, 255, 0.62)');
  rim.addColorStop(0.5, 'rgba(255, 255, 255, 0.12)');
  rim.addColorStop(1, 'rgba(255, 255, 255, 0.30)');
  ctx.strokeStyle = rim;
  squircle(inset + 3.5, inset + 3.5, w - 7, h - 7, r - 3);
  ctx.stroke();

  ctx.restore();

  // hairline edge for definition on light backgrounds
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(46, 33, 22, 0.16)';
  squircle(inset + 1, inset + 1, w - 2, h - 2, r - 1);
  ctx.stroke();
  ctx.restore();

  window.__ready = true;
  return true;
}

build();
</script></body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const logo = fs.readFileSync(LOGO).toString('base64');
  fs.mkdirSync(BUILD, { recursive: true });
  const htmlPath = path.join(BUILD, 'icon-render.html');
  fs.writeFileSync(htmlPath, page.replace('__LOGO__', `data:image/png;base64,${logo}`));

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    x: -4000,
    y: 0,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false, offscreen: false },
  });
  await win.loadFile(htmlPath);
  win.webContents.setZoomFactor(1);
  for (let i = 0; i < 100; i++) {
    const ready = await win.webContents.executeJavaScript('window.__ready === true');
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 250));

  // Export the canvas itself: exact 1024x1024 with the alpha we drew.
  const grab = () => win.webContents.executeJavaScript("document.getElementById('c').toDataURL('image/png')");

  const dataUrl = await grab();
  const png = Buffer.from(String(dataUrl).split(',')[1], 'base64');
  fs.writeFileSync(OUT_PNG, png);
  console.log('rendered', path.relative(ROOT, OUT_PNG), png.length, 'bytes');

  // UI copy, resampled from the same source.
  execFileSync('sips', ['-s', 'format', 'png', '-z', '512', '512', OUT_PNG, '--out', UI_LOGO], { stdio: 'ignore' });

  // Second pass without the baked shadow, for the macOS icon.
  await win.webContents.executeJavaScript("location.hash = 'flat'; location.reload(); true");
  for (let i = 0; i < 100; i++) {
    try {
      const ready = await win.webContents.executeJavaScript('window.__ready === true');
      if (ready) break;
    } catch { /* reloading */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 200));
  const flatUrl = await grab();
  fs.writeFileSync(FLAT_PNG, Buffer.from(String(flatUrl).split(',')[1], 'base64'));
  console.log('rendered', path.relative(ROOT, FLAT_PNG));

  /* ---- build the .icns ---- */
  fs.rmSync(ICONSET, { recursive: true, force: true });
  fs.mkdirSync(ICONSET, { recursive: true });
  const variants = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of variants) {
    execFileSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), FLAT_PNG, '--out', path.join(ICONSET, name)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', ICNS]);
  fs.rmSync(ICONSET, { recursive: true, force: true });

  /* ---- build the Windows .ico ---- */
  const icoTmp = path.join(BUILD, 'ico-tmp');
  fs.rmSync(icoTmp, { recursive: true, force: true });
  fs.mkdirSync(icoTmp, { recursive: true });
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoPngs = icoSizes.map((size) => {
    const p = path.join(icoTmp, `${size}.png`);
    execFileSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), FLAT_PNG, '--out', p], { stdio: 'ignore' });
    return p;
  });
  // png-to-ico is ESM-only; load it dynamically (works in Electron's Node).
  const { default: pngToIco } = await import('png-to-ico');
  const ico = await pngToIco(icoPngs);
  fs.writeFileSync(ICO, Buffer.from(ico));
  fs.rmSync(icoTmp, { recursive: true, force: true });

  console.log('wrote', path.relative(ROOT, ICNS), path.relative(ROOT, ICO), 'and app/assets/icon.png');

  win.destroy();
  app.quit();
});
