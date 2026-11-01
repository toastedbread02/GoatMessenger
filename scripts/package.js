// Builds dist/GoatMessenger.app — a self-contained, double-clickable macOS app.
//
// It reuses the Electron runtime already installed in node_modules, adds the
// production files and a real .icns built from the project logo, fills in the
// bundle's Info.plist (including camera/microphone usage strings, which macOS
// requires before any capture request), and ad-hoc signs the result.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, 'build');
const APP_NAME = 'GoatMessenger';
const BUNDLE_ID = 'app.goatmessenger.desktop';
const APP = path.join(DIST, `${APP_NAME}.app`);
const ELECTRON_APP = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const plist = (plistPath, key, value, type = 'string') => {
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plistPath], { stdio: 'ignore' }); } catch {}
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plistPath], { stdio: 'inherit' });
};

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dest);
    else fs.copyFileSync(src, dest);
  }
}

function buildIcon() {
  const icns = path.join(BUILD, 'goatmessenger.icns');
  if (!fs.existsSync(icns)) {
    console.log('  rendering icon first…');
    execFileSync(path.join(ROOT, 'node_modules', '.bin', 'electron'), [path.join(ROOT, 'scripts', 'make-icon.js')], { stdio: 'inherit' });
  }
  const out = path.join(APP, 'Contents', 'Resources', 'goatmessenger.icns');
  fs.copyFileSync(icns, out);
  return out;
}

if (!fs.existsSync(ELECTRON_APP)) {
  console.error('Electron runtime missing — run `npm install` first.');
  process.exit(1);
}

console.log('• preparing dist…');
fs.rmSync(APP, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
copyDir(ELECTRON_APP, APP);
execFileSync('xattr', ['-cr', APP], { stdio: 'ignore' });

console.log('• wiring the app bundle…');
const macosDir = path.join(APP, 'Contents', 'MacOS');
fs.renameSync(path.join(macosDir, 'Electron'), path.join(macosDir, APP_NAME));
const resources = path.join(APP, 'Contents', 'Resources');
fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });

const appDir = path.join(resources, 'app');
fs.mkdirSync(appDir, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
delete pkg.devDependencies;
delete pkg.scripts;
pkg.main = 'app/main.js';
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(pkg, null, 2));

for (const dir of ['app', 'server']) copyDir(path.join(ROOT, dir), path.join(appDir, dir));
// Only runtime dependencies are needed: `ws` for the embedded relay.
copyDir(path.join(ROOT, 'node_modules', 'ws'), path.join(appDir, 'node_modules', 'ws'));

console.log('• writing Info.plist…');
const info = path.join(APP, 'Contents', 'Info.plist');
plist(info, 'CFBundleName', APP_NAME);
plist(info, 'CFBundleDisplayName', APP_NAME);
plist(info, 'CFBundleExecutable', APP_NAME);
plist(info, 'CFBundleIdentifier', BUNDLE_ID);
plist(info, 'CFBundleShortVersionString', pkg.version);
plist(info, 'CFBundleVersion', '1');
plist(info, 'CFBundleIconFile', 'goatmessenger.icns');
plist(info, 'LSMinimumSystemVersion', '10.15');
plist(info, 'LSApplicationCategoryType', 'public.app-category.social-networking');
plist(info, 'NSHighResolutionCapable', 'true', 'bool');
plist(info, 'NSCameraUsageDescription', 'GoatMessenger uses the camera for encrypted video calls.');
plist(info, 'NSMicrophoneUsageDescription', 'GoatMessenger uses the microphone for encrypted calls and voice notes.');

console.log('• building icon…');
buildIcon();

(async () => {
  console.log('• signing…');
  if (process.env.GM_SKIP_SIGN === '1') {
    console.log('  skipped (GM_SKIP_SIGN=1)');
  } else {
    try {
      // The official signer walks the bundle inside-out and preserves the
      // entitlements Electron's helpers need, which a naive --deep sign does not.
      const { sign } = await import('@electron/osx-sign');
      await sign({
        app: APP,
        identity: '-',
        identityValidation: false,
        hardenedRuntime: false,
        optionsForFile: () => ({ entitlements: path.join(ROOT, 'build', 'entitlements.mac.plist') }),
      });
      console.log('  ad-hoc signed via @electron/osx-sign');
    } catch (err) {
      console.warn('  osx-sign failed:', err.message);
      try {
        execFileSync('codesign', ['--force', '--deep', '--sign', '-', APP], { stdio: 'inherit' });
      } catch (fallbackErr) {
        console.warn('  codesign failed (the app still runs locally):', fallbackErr.message);
      }
    }
  }

  const size = execFileSync('du', ['-sh', APP]).toString().split('\t')[0];
  console.log(`\n✓ ${path.relative(ROOT, APP)} (${size})`);
  console.log('  open it with:  open dist/GoatMessenger.app');
})();
