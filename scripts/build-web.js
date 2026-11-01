// Builds the browser version of GoatMessenger into docs/app/ for GitHub Pages.
//
// The renderer never requires Electron — it only talks to the preload bridge.
// This copies the renderer (app/index.html, ui/, shared/, vendor/, assets/)
// unchanged, injects the browser shim (scripts/goat-web-shim.js) before the
// app bundle, and loosens the Content-Security-Policy so an https relay
// (wss://…) can be reached from the https site.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'app');
const OUT = path.join(ROOT, 'docs', 'app');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const dir of ['ui', 'shared', 'vendor', 'assets']) {
  fs.cpSync(path.join(SRC, dir), path.join(OUT, dir), { recursive: true });
}
fs.copyFileSync(path.join(__dirname, 'goat-web-shim.js'), path.join(OUT, 'goat-web.js'));

let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

// relays can be https/wss (tunnels, VPS); the CSP must allow them
html = html.replace(/connect-src ([^"]*?);/, (match, list) => `connect-src ${list} https: wss:;`);
// the shim must be on the page before the app bundle starts
html = html.replace(
  /<script type="module" src="ui\/app\.mjs"><\/script>/,
  '<script src="goat-web.js"></script>\n<script type="module" src="ui/app.mjs"></script>',
);
html = html.replace(/<title>GoatMessenger<\/title>/, '<title>GoatMessenger — run in browser</title>');

fs.writeFileSync(path.join(OUT, 'index.html'), html);

const size = fs.readdirSync(path.join(OUT, 'ui')).length;
console.log(`✓ docs/app/ — index.html (CSP + shim), ${size} ui modules, shared/, vendor/, assets/, goat-web.js`);
