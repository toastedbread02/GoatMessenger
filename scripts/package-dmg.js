// Builds dist/GoatMessenger.dmg — a compressed, signed disk image with the
// classic install layout: the app on the left, an Applications folder alias on
// the right, and the themed drag-arrow artwork as the window background.
//
// Requires: dist/GoatMessenger.app (npm run package), the rendered background
// (build/dmg-background.png, produced by scripts/make-dmg-bg.js), and macOS
// Finder scripting for the icon layout.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, 'build');
const STAGE = path.join(BUILD, 'dmg-stage');
const RW = path.join(BUILD, 'goatmessenger-rw.dmg');
const OUT = path.join(DIST, 'GoatMessenger.dmg');
const APP = path.join(DIST, 'GoatMessenger.app');
const VOLNAME = 'GoatMessenger';
const WIN_SIZE = { w: 1050, h: 680 };

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

if (!fs.existsSync(APP)) {
  console.error('dist/GoatMessenger.app missing — run `npm run package` first.');
  process.exit(1);
}

const BG_PNG = path.join(BUILD, 'dmg-background.png');
if (!fs.existsSync(BG_PNG)) {
  console.log('• rendering DMG background…');
  run(path.join(ROOT, 'node_modules', '.bin', 'electron'), [path.join(ROOT, 'scripts', 'make-dmg-bg.js')]);
}

console.log('• staging the disk image folder…');
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, '.background'), { recursive: true });
fs.copyFileSync(BG_PNG, path.join(STAGE, '.background', 'background.png'));
run('cp', ['-R', APP, path.join(STAGE, 'GoatMessenger.app')]);
fs.symlinkSync('/Applications', path.join(STAGE, 'Applications'));

console.log('• creating the read-write image…');
fs.rmSync(RW, { force: true });
run('hdiutil', [
  'create', '-volname', VOLNAME,
  '-srcfolder', STAGE,
  '-ov', '-format', 'UDRW', '-fs', 'HFS+',
  '-fsargs', '-c c=64,a=16,e=16',
  '-quiet', RW,
]);

console.log('• mounting…');
const attachOut = execFileSync('hdiutil', ['attach', RW, '-noautoopen']).toString();
const mountMatch = attachOut.match(/Apple_HFS\s+\t?(.*)$/m);
const mountPoint = (mountMatch && mountMatch[1].trim()) || path.join('/Volumes', VOLNAME);
if (!fs.existsSync(mountPoint)) {
  console.error('could not determine the mount point:', attachOut);
  process.exit(1);
}

// The layout below is in {x, y} from the top-left of the 1050x680 window,
// matching make-dmg-bg.js's artwork.
console.log('• laying out the install window…');
sleepSync(2000); // give Finder a beat to notice the new volume
const layout = `
tell application "Finder"
  tell disk "${VOLNAME}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {0, 0, ${WIN_SIZE.w}, ${WIN_SIZE.h}}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 96
    set text size of viewOptions to 13
    set background picture of viewOptions to file ".background:background.png"
    delay 1
    set position of item "GoatMessenger.app" of container window to {150, 440}
    set position of item "Applications" of container window to {900, 440}
    delay 2
    update
  end tell
end tell
`;
try {
  run('osascript', ['-e', layout]);
} catch {
  console.warn('  Finder AppleScript layout failed — the DMG will open with default layout.');
}

console.log('• ejecting…');
// Eject through Finder while the window is still open — closing first lets
// Finder discard the view options, and a plain hdiutil detach can skip the
// .DS_Store flush entirely.
try {
  execFileSync('osascript', ['-e', `tell application "Finder" to eject disk "${VOLNAME}"`], { stdio: 'ignore' });
} catch {
  try { run('hdiutil', ['detach', mountPoint], { stdio: 'ignore' }); } catch { run('hdiutil', ['detach', '-force', mountPoint], { stdio: 'ignore' }); }
}
sleepSync(1500);

console.log('• compressing…');
fs.rmSync(OUT, { force: true });
run('hdiutil', ['convert', RW, '-format', 'UDZO', '-o', OUT, '-quiet']);

console.log('• signing…');
try {
  run('codesign', ['--sign', '-', '--force', OUT], { stdio: 'ignore' });
  console.log('  ad-hoc signed');
} catch {
  console.warn('  codesign failed (DMG still mounts)');
}

fs.rmSync(RW, { force: true });
fs.rmSync(STAGE, { recursive: true, force: true });

const size = execFileSync('du', ['-sh', OUT]).toString().split('\t')[0];
console.log(`\n✓ ${path.relative(ROOT, OUT)} (${size})`);
console.log('  inspect it with:  open dist/GoatMessenger.dmg');
