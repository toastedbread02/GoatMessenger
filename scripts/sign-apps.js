#!/usr/bin/env node
// Puts a code signature on every downloadable build.
//
//   npm run sign
//
// macOS: the .app and the .dmg are ad-hoc signed (same as the packagers do) —
//        this is what Apple allows without a paid Developer ID. Gatekeeper still
//        asks once, so the site tells people to right-click → Open.
// Windows: the portable .exe is Authenticode-signed with the project's
//        self-signed certificate (build/goat-codesign.*, created on first run,
//        never committed). Windows shows "unknown publisher" until a real
//        commercial certificate is bought, but the binary is signed and the
//        signature can be verified.
//
// Both steps are idempotent: run them after any rebuild.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const CERT = {
  key: path.join(BUILD, 'goat-codesign.key'),
  crt: path.join(BUILD, 'goat-codesign.crt'),
  p12: path.join(BUILD, 'goat-codesign.p12'),
  cnf: path.join(BUILD, 'codesign.cnf'),
  password: 'goatmessenger',
};
const ARTIFACTS = {
  app: path.join(DIST, 'GoatMessenger.app'),
  dmg: path.join(DIST, 'GoatMessenger.dmg'),
  exe: path.join(DIST, 'GoatMessenger-Portable.exe'),
};

const have = (cmd) => spawnSync('which', [cmd]).status === 0;
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' }).toString().trim();

function ensureCert() {
  if (fs.existsSync(CERT.key) && fs.existsSync(CERT.crt)) return;
  if (!have('openssl')) throw new Error('openssl is required to create the signing certificate.');
  console.log('• creating the project signing certificate (self-signed, kept in build/, never committed)…');
  fs.mkdirSync(BUILD, { recursive: true });
  run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650',
    '-keyout', CERT.key, '-out', CERT.crt, '-config', CERT.cnf, '-extensions', 'v3', '-nodes',
  ]);
  run('chmod', ['600', CERT.key]);
}

/** Re-signs a Mach-O bundle / disk image ad-hoc. */
function signMac(target) {
  const args = ['--force', '--sign', '-'];
  if (target.endsWith('.app')) {
    const entitlements = path.join(BUILD, 'entitlements.mac.plist');
    if (fs.existsSync(entitlements)) args.push('--entitlements', entitlements);
    args.push('--deep');
  }
  args.push(target);
  run('codesign', args);
}

function signExe() {
  const exe = ARTIFACTS.exe;
  const tmp = `${exe}.signed`;
  run('osslsigncode', [
    'sign', '-certs', CERT.crt, '-key', CERT.key, '-n', 'GoatMessenger',
    '-i', 'https://toastedbread02.github.io/GoatMessenger/',
    '-h', 'sha256', '-ts', 'http://timestamp.digicert.com',
    '-in', exe, '-out', tmp,
  ]);
  fs.renameSync(tmp, exe);
}

/** True when the Authenticode signature is intact. The certificate is
    self-signed, so it is trusted explicitly instead of by the OS store. */
function verifyExe() {
  const result = spawnSync('osslsigncode', ['verify', '-in', ARTIFACTS.exe, '-CAfile', CERT.crt], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status === 0 && !/failed/i.test(output)) return { ok: true, signer: 'self-signed' };
  const current = /Current message digest\s*:\s*([0-9A-F]+)/.exec(output)?.[1];
  const calculated = /Calculated message digest\s*:\s*([0-9A-F]+)/.exec(output)?.[1];
  if (current && current === calculated) return { ok: true, signer: 'self-signed (untrusted chain)' };
  return { ok: false, detail: output.trim().split('\n').filter(Boolean).slice(-1)[0] || `osslsigncode exited ${result.status}` };
}

async function main() {
  const report = [];
  const missing = Object.entries(ARTIFACTS).filter(([, file]) => !fs.existsSync(file)).map(([name]) => name);
  if (missing.length === Object.keys(ARTIFACTS).length) {
    console.error('Nothing to sign yet — build the installers first (npm run package / package:dmg / package:win-portable).');
    process.exit(1);
  }

  if (process.platform === 'darwin' && have('codesign')) {
    for (const key of ['app', 'dmg']) {
      const file = ARTIFACTS[key];
      if (!fs.existsSync(file)) continue;
      try {
        // Electron bundles must be signed inside-out so each helper keeps its
        // own entitlements; `--deep` is only the fallback.
        if (key === 'app') {
          try {
            const osxSign = require('@electron/osx-sign');
            await osxSign.sign({ app: file, identity: '-', platform: 'darwin', hardenedRuntime: false });
          } catch {
            signMac(file);
          }
        } else {
          signMac(file);
        }
        const info = run('codesign', ['-dv', '--verbose=2', file]) || '';
        const signature = /Signature=(\S+)/.exec(info)?.[1] || 'signed';
        report.push(`  ✓ ${path.basename(file)} — ${signature === 'adhoc' ? 'ad-hoc signed' : signature}`);
      } catch (err) {
        report.push(`  ✗ ${path.basename(file)} — ${String(err.stderr || err.message).trim().split('\n')[0]}`);
        process.exitCode = 1;
      }
    }
  } else if (!have('codesign')) {
    report.push('  · macOS signing skipped (codesign missing)');
  }

  if (fs.existsSync(ARTIFACTS.exe)) {
    if (!have('osslsigncode')) {
      report.push('  · GoatMessenger-Portable.exe — osslsigncode missing (brew install osslsigncode)');
      process.exitCode = 1;
    } else {
      try {
        ensureCert();
        signExe();
        const verdict = verifyExe();
        if (!verdict.ok) throw new Error(verdict.detail);
        report.push(`  ✓ GoatMessenger-Portable.exe — Authenticode signed (${verdict.signer})`);
      } catch (err) {
        const detail = String(err.stderr || err.message).trim().split('\n').filter(Boolean).slice(-1)[0] || 'signing failed';
        report.push(`  ✗ GoatMessenger-Portable.exe — ${detail}`);
        process.exitCode = 1;
      }
    }
  }

  for (const key of missing) {
    if (key === 'exe' && !have('osslsigncode')) continue;
    report.push(`  · ${path.basename(ARTIFACTS[key])} not built yet`);
  }

  console.log('code signing');
  console.log(report.join('\n'));
  console.log('\nNeither signature is backed by a paid Apple/Microsoft certificate, so both');
  console.log('systems still ask once. That is the honest state until a certificate is bought:');
  console.log('  macOS   — Apple Developer ID ($99/yr) + notarization');
  console.log('  Windows — commercial code-signing certificate (~$200–400/yr)');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
