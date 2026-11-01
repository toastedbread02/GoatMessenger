// Builds dist/GoatMessenger-win32-x64 — a self-contained Windows build of
// GoatMessenger, produced entirely on a Mac (no Wine, no Windows needed):
//
//   npm run package:win
//
// It reuses the win32 Electron runtime from the official release zip
// (downloaded once into the Electron cache), assembles the same `resources/app`
// tree the macOS packager uses, renames electron.exe to GoatMessenger.exe, and
// rewrites the exe's PE resources — the goat .ico as the application icon plus
// proper version strings — with the pure-JS `resedit` library. The result is
// zipped alongside the folder: dist/GoatMessenger-win32-x64.zip.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ResEdit = require('resedit');
const { downloadArtifact } = require('@electron/get');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, 'build');
const APP_DIR_NAME = 'GoatMessenger-win32-x64';
const DEST = path.join(DIST, APP_DIR_NAME);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

(async () => {
  const electronVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const icns = path.join(BUILD, 'goatmessenger.ico');
  if (!fs.existsSync(icns)) {
    console.error('build/goatmessenger.ico missing — run `npm run icon` first.');
    process.exit(1);
  }

  console.log(`• fetching the win32 Electron ${electronVersion} runtime (cached after the first run)…`);
  const zip = await downloadArtifact({
    version: electronVersion,
    platform: 'win32',
    arch: 'x64',
    artifactName: 'electron',
  });
  console.log('  runtime ready:', path.relative(ROOT, zip));

  console.log('• assembling dist/' + APP_DIR_NAME + '…');
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  run('unzip', ['-q', '-o', zip, '-d', DEST]);

  const resources = path.join(DEST, 'resources');
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
  fs.renameSync(path.join(DEST, 'electron.exe'), path.join(DEST, 'GoatMessenger.exe'));

  const appDir = path.join(resources, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const packagedPkg = {
    name: pkg.name,
    productName: pkg.productName,
    version: pkg.version,
    private: true,
    description: pkg.description,
    main: 'app/main.js',
    type: 'commonjs',
  };
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(packagedPkg, null, 2));
  for (const dir of ['app', 'server']) copyDir(path.join(ROOT, dir), path.join(appDir, dir));
  copyDir(path.join(ROOT, 'node_modules', 'ws'), path.join(appDir, 'node_modules', 'ws'));
  // The window/taskbar icon on Windows is taken from this file; the exe icon
  // below covers Explorer, shortcuts, and alt-tab.
  fs.copyFileSync(icns, path.join(appDir, 'app', 'assets', 'goatmessenger.ico'));

  console.log('• embedding the icon and version info into GoatMessenger.exe…');
  const exePath = path.join(DEST, 'GoatMessenger.exe');
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const res = ResEdit.NtExecutableResource.from(exe);

  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icns));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    groupId,
    1033,
    iconFile.icons.map((item) => item.data),
  );

  const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (viList.length) {
    const vi = viList[0];
    const [vMajor, vminor, vPatch] = String(pkg.version).split('.').map((n) => Number(n) || 0);
    vi.setFileVersion(vMajor, vminor, vPatch, 0, 1033);
    vi.setProductVersion(vMajor, vminor, vPatch, 0, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      FileDescription: 'GoatMessenger — end-to-end encrypted messenger',
      ProductName: 'GoatMessenger',
      CompanyName: 'GoatMessenger',
      OriginalFilename: 'GoatMessenger.exe',
    });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));

  console.log('• zipping…');
  const zipOut = path.join(DIST, `${APP_DIR_NAME}.zip`);
  fs.rmSync(zipOut, { force: true });
  run('zip', ['-9', '-q', '-r', zipOut, APP_DIR_NAME], { cwd: DIST });

  const size = execFileSync('du', ['-sh', DEST]).toString().split('\t')[0];
  console.log(`\n✓ ${path.relative(ROOT, DEST)} (${size})`);
  console.log(`  bundle:        ${path.relative(ROOT, zipOut)}`);
  console.log(`  on Windows:  extract the zip, double-click GoatMessenger.exe`);
})();
