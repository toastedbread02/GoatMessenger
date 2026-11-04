// GoatMessenger desktop shell.
//
// The relay is embedded (no child process, works when packaged). If GM_SERVER is
// set, the app connects to a remote relay instead and starts no local one.
const { app, BrowserWindow, protocol, ipcMain, dialog, session, shell, nativeTheme, Menu, desktopCapturer, systemPreferences, nativeImage, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const BOOT_START = Date.now();
function bootLog(...args) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'boot.log'), `+${Date.now() - BOOT_START}ms ${args.join(' ')}\n`);
  } catch {}
}
bootLog('main module loaded');

const E2E = process.env.GM_E2E === '1';
const FAKE_MEDIA = process.env.GM_FAKE_MEDIA === '1';
const SCHEME = 'gm';
const APP_ROOT = path.join(__dirname);

// A single local GL surface helps avoid the odd compositing glitch on older Macs.
app.commandLine.appendSwitch('force_high_performance_gpu');
if (FAKE_MEDIA || E2E) {
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
  },
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
};

async function handleProtocol(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(APP_ROOT, rel));
  if (!target.startsWith(APP_ROOT)) return new Response('forbidden', { status: 403 });
  try {
    const data = await fsp.readFile(target);
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    return new Response(data, {
      status: 200,
      headers: { 'content-type': type, 'cache-control': 'no-store' },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

// Custom partitions get their own protocol registration, so every window's
// session must serve the bundle itself.
const protocolReady = new WeakSet();
function serveProtocol(ses) {
  if (protocolReady.has(ses)) return;
  protocolReady.add(ses);
  ses.protocol.handle(SCHEME, handleProtocol);
}

/* ------------------------------------------------------------------- relay -- */

// The public relay lives on Deno Deploy (free, cardless, durable, KV storage);
// see README’s “Hosting the relay in the cloud”. Override it with GM_SERVER.
const PUBLIC_RELAY = 'https://goatmessenger.toastedbread02.deno.net';

let relay = null;
let relayUrl = process.env.GM_SERVER || null;
let relayError = null;

/* ------------------------------------------------------------- net settings */
//
// A saved relay URL lets two goats on different continents share one relay:
// run `npm run server` on a host with a public address (or a tunnel), then paste
// that address here. The TURN block is what lets calls traverse NAT; media is
// still end-to-end encrypted DTLS-SRTP, the relay only forwards ciphertext.
const CONFIG_PATH = path.join(app.getPath('userData'), 'network.json');

function envTurn() {
  const urls = process.env.GM_TURN_URL || '';
  if (!urls) return null;
  return {
    urls,
    username: process.env.GM_TURN_USER || '',
    credential: process.env.GM_TURN_PASS || '',
  };
}

function defaultConfig() {
  return {
    relayUrl: process.env.GM_SERVER || '',
    turn: envTurn() || { urls: '', username: '', credential: '' },
    forceRelay: process.env.GM_FORCE_TURN === '1',
  };
}

function loadConfig() {
  const base = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      relayUrl: typeof raw.relayUrl === 'string' ? raw.relayUrl : base.relayUrl,
      turn: {
        urls: String(raw.turn?.urls || base.turn.urls || ''),
        username: String(raw.turn?.username || base.turn.username || ''),
        credential: String(raw.turn?.credential || base.turn.credential || ''),
      },
      forceRelay: typeof raw.forceRelay === 'boolean' ? raw.forceRelay : base.forceRelay,
    };
  } catch {
    return base;
  }
}

let config = loadConfig();

function saveConfig(next) {
  config = next;
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('[goatmessenger] could not save network settings:', err.message);
  }
}

const normaliseRelay = (value) => {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Use an http:// or https:// address.');
  return url.toString().replace(/\/$/, '');
};

const HEALTH_HEADERS = {
  // ngrok's free tier serves a "Visit site" interstitial (403 + HTML) to any
  // request without this header, so a perfectly healthy relay behind a free
  // tunnel would look dead to the health checker.
  'ngrok-skip-browser-warning': '1',
};

async function healthCheck(url) {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1200), headers: HEALTH_HEADERS });
    if (!res.ok) return false;
    const body = await res.json();
    return body && body.name === 'goatmessenger';
  } catch {
    return false;
  }
}

async function ensureRelay() {
  bootLog('ensureRelay start');
  // Already ours and running: never spin up a second relay (and a second TURN
  // listener) just because someone pressed Retry twice.
  if (relay && relay.server && relay.server.listening) return relayUrl;
  if (process.env.GM_SERVER) {
    relayUrl = process.env.GM_SERVER.replace(/\/$/, '');
    const ok = await healthCheck(relayUrl);
    if (!ok) throw new Error(`No GoatMessenger relay answering at ${relayUrl}`);
    return relayUrl;
  }
  // The public herd relay is the built-in default: anyone who installs the app
  // is connected to it automatically, so accounts reach each other across the
  // internet with zero configuration. Works purely as a pass-through of
  // ciphertext; the embedded/local relay below remains the offline fallback. //
  if (!process.env.GM_E2E && !process.env.GM_NO_PUBLIC
      && await healthCheck(PUBLIC_RELAY)) {
    relayUrl = PUBLIC_RELAY;
    bootLog('using public relay', relayUrl);
    return relayUrl;
  }
  // A relay the user configured (another machine, a VPS, a tunnel).
  // If it's down we do NOT brick the app: fall back to a local relay so the
  // user can still sign in — better a local session than a locked screen.
  // (Settings shows which relay is actually in use.)
  if (config.relayUrl) {
    const configured = config.relayUrl;
    if (await healthCheck(configured)) {
      relayUrl = configured;
      bootLog('using configured relay', relayUrl);
      return relayUrl;
    }
    bootLog('configured relay unreachable, falling back to local:', configured);
  }
  // Reuse an already-running local relay (e.g. `npm run server`).
  if (await healthCheck('http://127.0.0.1:4040')) {
    relayUrl = 'http://127.0.0.1:4040';
    return relayUrl;
  }
  const { createGoatServer } = require(path.join(__dirname, '..', 'server', 'index.js'));
  const dataDir = process.env.GM_DATA_DIR || path.join(app.getPath('userData'), 'relay-data');
  const base = Number(process.env.GM_PORT || 4040);
  for (let port = base; port < base + 12; port++) {
    try {
      const turn = process.env.GM_TURN_PORT
        ? {
          id: 'app-embedded',
          port: Number(process.env.GM_TURN_PORT),
          publicIp: process.env.GM_TURN_PUBLIC_IP || '127.0.0.1',
          user: process.env.GM_TURN_USER || 'goat',
          pass: process.env.GM_TURN_PASS || 'goat-turn',
          statsToken: process.env.GM_TURN_STATS_TOKEN || 'test-turn-token',
          host: '0.0.0.0',
          verbose: process.env.GM_TURN_VERBOSE === '1',
        }
        : null;
      relay = createGoatServer({ port, dataDir, host: '127.0.0.1', turn });
      const actual = await relay.listen();
      relayUrl = `http://127.0.0.1:${actual}`;
      bootLog('relay listening', relayUrl);
      return relayUrl;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      relay = null;
    }
  }
  throw new Error('Could not find a free port for the local relay.');
}

/* ------------------------------------------------------------------ windows -- */

let partitionCounter = 0;

const screenPicks = new Map();     // partition -> chosen source id
const displayReady = new WeakSet();

function serveDisplayCapture(ses, part) {
  if (displayReady.has(ses)) return;
  displayReady.add(ses);
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const pick = screenPicks.get(part);
    screenPicks.delete(part);
    if (!pick) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const chosen = sources.find((src) => src.id === pick);
      if (!chosen) return callback({});
      callback({ video: chosen });
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });
}

function hardenSession(part) {
  const ses = session.fromPartition(part);
  serveProtocol(ses);
  serveDisplayCapture(ses, part);
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media' || permission === 'audioCapture' || permission === 'videoCapture' || permission === 'display-capture') {
      return callback(true);
    }
    return callback(false);
  });
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media' || permission === 'audioCapture' || permission === 'videoCapture');
}

// Windows and Linux take the taskbar/window icon from the window itself.
// macOS takes it from the .app bundle (or the dev stamp in app.whenReady).
function windowIconPath() {
  if (process.platform === 'darwin') return undefined;
  const candidates = [
    path.join(__dirname, 'assets', 'goatmessenger.ico'),
    path.join(__dirname, 'assets', 'icon.png'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || undefined;
}

function createWindow({ role = 'main', partition, query = {} } = {}) {
  const part = partition || (role === 'main' ? 'persist:goat-main' : `persist:goat-slot${++partitionCounter}`);
  hardenSession(part);

  const win = new BrowserWindow({
    icon: windowIconPath(),
    width: role === 'main' ? 1180 : 1024,
    height: role === 'main' ? 800 : 720,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171209' : '#f7efe1',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    title: 'GoatMessenger',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      backgroundThrottling: false,
      partition: part,
    },
  });

  bootLog('createWindow', role, part);
  const params = new URLSearchParams({ ...query, role, partition: part });
  win.webContents.on('did-fail-load', (event, code, description, url) => {
    console.error('[goatmessenger] load failed', code, description, url);
  });
  win.loadURL(`${SCHEME}://app/index.html?${params.toString()}`).catch((err) => {
    console.error('[goatmessenger] loadURL rejected:', err.message);
  });
  win.once('ready-to-show', () => { bootLog('ready-to-show', role); win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${SCHEME}://`)) event.preventDefault();
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.meta && input.shift && input.key.toLowerCase() === 'n') {
      createWindow();
      event.preventDefault();
    }
  });
  return win;
}

/* ---------------------------------------------------------------------- ipc -- */

ipcMain.handle('app:info', () => ({
  relayUrl,
  relayError,
  version: app.getVersion(),
  platform: process.platform,
  userData: app.getPath('userData'),
  e2e: E2E,
  fakeMedia: FAKE_MEDIA,
  net: {
    relayUrl,
    turn: embeddedTurn() || config.turn,
    forceRelay: config.forceRelay,
    embedded: !process.env.GM_SERVER && !config.relayUrl && Boolean(relay),
    turnPort: relay && relay.turn ? relay.turn.port : null,
  },
}));

// When the app itself is running a TURN relay (developer / local-network mode),
// point calls at it without the user having to type anything.
function embeddedTurn() {
  if (!relay || !relay.turn || !relay.turn.port) return null;
  return {
    urls: `turn:127.0.0.1:${relay.turn.port}?transport=udp`,
    username: process.env.GM_TURN_USER || 'goat',
    credential: process.env.GM_TURN_PASS || 'goat-turn',
  };
}

ipcMain.handle('net:get', () => ({
  relayUrl,
  turn: embeddedTurn() || config.turn,
  forceRelay: config.forceRelay,
  embedded: !process.env.GM_SERVER && !config.relayUrl && Boolean(relay),
}));

// Probe a relay before saving it, so a typo cannot strand the app offline.
ipcMain.handle('net:test', async (event, { relayUrl: candidate }) => {
  const started = Date.now();
  try {
    const url = normaliseRelay(candidate);
    if (!url) return { ok: false, error: 'Enter a relay address.' };
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(6000), headers: HEALTH_HEADERS });
    if (!res.ok) return { ok: false, error: `Relay answered ${res.status}.` };
    const body = await res.json();
    if (body?.name !== 'goatmessenger') return { ok: false, error: 'That is not a GoatMessenger relay.' };
    return { ok: true, url, ms: Date.now() - started, turn: Boolean(body.turn?.enabled) };
  } catch (err) {
    return { ok: false, error: err.message === 'The operation was aborted due to timeout' ? 'Timed out.' : err.message };
  }
});

ipcMain.handle('net:set', async (event, next) => {
  try {
    const url = normaliseRelay(next.relayUrl);
    const turn = {
      urls: String(next.turn?.urls || '').trim(),
      username: String(next.turn?.username || '').trim(),
      credential: String(next.turn?.credential || '').trim(),
    };
    if (url) {
      const probe = await healthCheck(url);
      if (!probe) return { ok: false, error: `No GoatMessenger relay answering at ${url}.` };
    }
    const previous = config.relayUrl;
    saveConfig({ relayUrl: url, turn, forceRelay: Boolean(next.forceRelay) });
    const restartNeeded = previous !== url;
    return { ok: true, relayUrl: url || relayUrl, restartNeeded, net: config };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ------------------------------------------------------------ login store -- */
//
// "Stay signed in": the auth token and the private identity live in one small
// file encrypted by the OS keychain (safeStorage), so a restart never needs the
// passphrase again. Wiping the file is the only way the shell loses it.
const SESSION_PATH = path.join(app.getPath('userData'), 'session.bin');

function keychainReady() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

ipcMain.handle('login:save', (event, payload) => {
  try {
    if (!keychainReady()) return { ok: false, reason: 'no-keychain' };
    fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
    fs.writeFileSync(SESSION_PATH, safeStorage.encryptString(JSON.stringify(payload)));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('login:load', () => {
  try {
    if (!fs.existsSync(SESSION_PATH) || !keychainReady()) return null;
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(SESSION_PATH)));
  } catch {
    return null;
  }
});

ipcMain.handle('login:clear', () => {
  try { fs.rmSync(SESSION_PATH, { force: true }); } catch {}
  return true;
});

// Light | dark | system. Setting themeSource also drives prefers-color-scheme
// inside the renderer and we pick up the new value for fresh windows.
ipcMain.handle('app:theme', (event, mode) => {
  nativeTheme.themeSource = ['light', 'dark', 'system'].includes(mode) ? mode : 'system';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
});

/* ---------------------------------------------------------------- screens -- */

ipcMain.handle('screen:sources', async () => {
  const permission = process.platform === 'darwin'
    ? systemPreferences.getMediaAccessStatus('screen')
    : 'granted';
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 300 },
      fetchWindowIcons: true,
    });
    return {
      permission,
      sources: sources.map((src) => ({
        id: src.id,
        name: src.name,
        kind: src.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: src.thumbnail && !src.thumbnail.isEmpty() ? src.thumbnail.toDataURL() : '',
        appIcon: src.appIcon && !src.appIcon.isEmpty() ? src.appIcon.toDataURL() : '',
      })),
    };
  } catch (err) {
    return { permission, sources: [], error: err.message };
  }
});

ipcMain.handle('screen:pick', (event, { id, partition }) => {
  if (!id) return false;
  screenPicks.set(partition || 'persist:goat-main', id);
  return true;
});

ipcMain.handle('screen:clear', (event, { partition }) => {
  screenPicks.delete(partition || 'persist:goat-main');
  return true;
});

ipcMain.handle('screen:openPrefs', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
  return true;
});

ipcMain.handle('app:newWindow', () => { createWindow(); return true; });

ipcMain.handle('app:retryRelay', async () => {
  try {
    await ensureRelay();
    relayError = null;
  } catch (err) {
    relayError = String(err.message || err);
  }
  return { relayUrl, relayError };
});

ipcMain.handle('app:saveFile', async (event, { name, data }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const safe = String(name || 'goat-file').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 120);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save file',
    defaultPath: path.join(app.getPath('downloads'), safe),
  });
  if (canceled || !filePath) return { canceled: true };
  await fsp.writeFile(filePath, Buffer.from(data));
  return { canceled: false, path: filePath };
});

ipcMain.handle('app:saveTemp', async (event, { name, data, mime }) => {
  const dir = path.join(app.getPath('temp'), 'goatmessenger');
  await fsp.mkdir(dir, { recursive: true });
  const safe = String(name || 'file').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 80);
  const file = path.join(dir, `${Date.now()}-${safe}`);
  await fsp.writeFile(file, Buffer.from(data));
  return { path: file, mime };
});

ipcMain.handle('app:openPath', async (event, target) => {
  if (typeof target === 'string' && target.startsWith(app.getPath('temp'))) return shell.openPath(target);
  return 'refused';
});

ipcMain.handle('app:revealPath', async (event, target) => {
  if (typeof target === 'string') shell.showItemInFolder(target);
  return true;
});

ipcMain.handle('app:badge', (event, count) => {
  if (process.platform === 'darwin' && app.dock) app.dock.setBadge(count > 0 ? String(count) : '');
  return true;
});

// OS notification for messages that need attention. The renderer decides *if*
// (only when the user is not already in that chat); the main process delivers
// and routes clicks back to the sender's window so the right chat opens.
ipcMain.handle('app:notify', (event, payload) => {
  if (E2E) return false; // automated runs stay quiet
  if (!payload || typeof payload.title !== 'string') return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  const note = new Notification({
    title: payload.title.slice(0, 90),
    body: String(payload.body || '').slice(0, 140),
    ...(payload.where ? { subtitle: '' } : {}),
  });
  note.on('click', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('app:notify-click', { peer: payload.peer, where: payload.where });
    }
  });
  note.show();
  return true;
});

ipcMain.handle('media:access', async (event, kind) => {
  if (FAKE_MEDIA || E2E) return true;
  const { systemPreferences } = require('electron');
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus(kind);
  if (status === 'granted') return true;
  if (status === 'denied' || status === 'restricted') return false;
  try {
    return await systemPreferences.askForMediaAccess(kind);
  } catch {
    return false;
  }
});

/* --------------------------------------------------------------------- boot -- */

// One process owns the relay and the local store; extra launches open a window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) {
      const win = wins[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    createWindow();
  });
}

app.whenReady().then(async () => {
  bootLog('app ready');
  // Follow the OS until the user picks a theme in Settings; the renderer
  // reports its choice back through app:theme.
  if (nativeTheme.themeSource === 'light') nativeTheme.themeSource = 'system';

  // `npm start` runs inside the stock Electron runtime, whose dock would show
  // its own default icon. Stamp the goat over it; packaged builds already
  // carry it in the bundle's .icns.
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    try {
      const devIcon = path.join(__dirname, '..', 'build', 'icon-flat-1024.png');
      if (fs.existsSync(devIcon)) app.dock.setIcon(nativeImage.createFromPath(devIcon));
    } catch (err) {
      console.warn('[goatmessenger] could not set the dock icon:', err.message);
    }
  }

  serveProtocol(session.defaultSession);
  try {
    await ensureRelay();
  } catch (err) {
    relayError = String(err.message || err);
    console.error('[goatmessenger] relay unavailable:', relayError);
    if (!relayUrl) relayUrl = 'http://127.0.0.1:4040';
  }

  const standard = [
    { role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ];
  const template = [
    ...standard,
    {
      label: 'Goat',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow(),
        },
        { type: 'separator' },
        { role: 'logout' },
        { role: 'quit' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  if (E2E) {
    const a = createWindow({ role: 'e2e-a', partition: 'persist:goat-e2e-a' });
    const b = createWindow({ role: 'e2e-b', partition: 'persist:goat-e2e-b' });
    a.setBounds({ x: 40, y: 40, width: 1120, height: 800 });
    b.setBounds({ x: 600, y: 80, width: 1120, height: 800 });
  } else {
    createWindow({ role: 'main' });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow({ role: 'main' });
});

app.on('before-quit', async () => {
  if (relay) {
    try { await relay.close(); } catch {}
    relay = null;
  }
});
