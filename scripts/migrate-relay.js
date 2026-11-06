#!/usr/bin/env node
// Copies every account from a local relay's on-disk store (data/db.json) onto
// another relay through its public /api/import endpoint.
//
//   node scripts/migrate-relay.js --to https://goatmessenger.toastedbread02.deno.net
//   node scripts/migrate-relay.js --to https://… --only toastedbread,yeh
//   node scripts/migrate-relay.js --to https://… --dry        # build only, no upload
//   node scripts/migrate-relay.js --to https://… --data ./data
//
// What moves: the account record (same passphrase hash, key backup, profile),
// its contacts, groups and the ciphertext of every room it is part of. Nothing
// is decrypted here — the relay only ever holds envelopes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;
const GROUP_ID_RE = /^g[0-9a-f]{8,32}$/;

function parseArgs(argv) {
  const args = { data: path.join(process.cwd(), 'data'), only: null, dry: false, to: '', all: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--to') args.to = String(argv[++i] || '').replace(/\/$/, '');
    else if (arg === '--data') args.data = path.resolve(argv[++i] || 'data');
    else if (arg === '--only') args.only = String(argv[++i] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (arg === '--dry') args.dry = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Copies local relay accounts to another relay.

  node scripts/migrate-relay.js --to <relay-url> [--data ./data] [--only a,b] [--all] [--dry]

  --to     target relay, e.g. https://goatmessenger.toastedbread02.deno.net
  --data   directory holding db.json (default ./data)
  --only   comma-separated goat names to move (default: every real account)
  --all    also move guest_* throwaways (skipped by default)
  --dry    build the bundles and print what would move, upload nothing`);
}

/** Same derivation the relay uses: sha256 with `bits` leading zero bits. */
function solveProofOfWork(bits, challenge, name) {
  for (let n = 0; ; n++) {
    const digest = crypto.createHash('sha256').update(`${challenge}:${name}:${String(n)}`).digest();
    let left = bits;
    for (const byte of digest) {
      if (byte === 0) { left -= 8; continue; }
      for (let m = 0x80; m > 0; m >>= 1) { if (byte & m) break; left--; }
      break;
    }
    if (left <= 0) return String(n);
  }
}

function bundleFor(data, user) {
  const name = user.username.toLowerCase();
  const rooms = [];
  for (const [room, list] of Object.entries(data.messages || {})) {
    if (!Array.isArray(list) || !list.length) continue;
    const peers = room.split('~');
    if (!peers.includes(name)) continue;
    const peer = peers.find((p) => p !== name);
    if (!peer) continue;
    rooms.push({ peer, list: list.slice(-3000) });
  }
  const groups = Object.values(data.groups || {})
    .filter((g) => g && GROUP_ID_RE.test(String(g.id)) && Array.isArray(g.members) && g.members.includes(name))
    .map((g) => ({ id: g.id, name: g.name, owner: g.owner, members: g.members, createdAt: g.createdAt }));
  return {
    v: 1,
    exportedAt: Date.now(),
    account: {
      username: user.username,
      displayName: user.displayName || user.username,
      about: user.about || '',
      accent: user.accent ?? 0,
      avatar: user.avatar || '',
      banner: user.banner || '',
      createdAt: user.createdAt,
      salt: user.salt,
      verifier: user.verifier,
      keys: user.keys,
      identityBackup: user.identityBackup,
    },
    contacts: Object.entries((data.contacts || {})[name] || {})
      .filter(([peer, rel]) => USERNAME_RE.test(peer) && rel && ['in', 'out', 'accepted'].includes(rel.state))
      .map(([peer, rel]) => ({ peer, state: rel.state, since: rel.since })),
    groups,
    messages: rooms,
  };
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (!args.to) {
    usage();
    console.error('\nMissing --to <relay-url>.');
    process.exit(1);
  }

  const dbFile = path.join(args.data, 'db.json');
  if (!fs.existsSync(dbFile)) {
    console.error(`No store at ${dbFile}. Point --data at the relay's data directory.`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const all = Object.values(data.users || {});
  const wantGuests = (u) => args.all || !/^guest_/i.test(String(u.username));
  const users = args.only
    ? all.filter((u) => args.only.includes(String(u.username).toLowerCase()))
    : all.filter(wantGuests);
  if (!users.length) {
    console.error('No accounts matched.');
    process.exit(1);
  }

  console.log(`Target relay : ${args.to}`);
  console.log(`Source store : ${dbFile} (${all.length} accounts)`);
  console.log(`Moving       : ${users.length}${args.only ? ` (${args.only.join(', ')})` : ''}`);
  if (args.dry) console.log('Dry run      : nothing will be uploaded.\n');
  else console.log('');

  let moved = 0;
  let skipped = 0;
  let failed = 0;

  for (const user of users) {
    const label = String(user.username);
    const bundle = bundleFor(data, user);
    const counts = `${bundle.messages.reduce((n, r) => n + r.list.length, 0)} msgs, ${bundle.contacts.length} contacts, ${bundle.groups.length} groups`;

    if (args.dry) {
      console.log(`  · ${label}: ${counts}`);
      moved++;
      continue;
    }

    try {
      let attempt = await post(`${args.to}/api/import`, { bundle });
      if (attempt.status === 428 && attempt.data.challenge) {
        const nonce = solveProofOfWork(attempt.data.bits || 16, attempt.data.challenge, label);
        attempt = await post(`${args.to}/api/import`, { bundle, pow: { challenge: attempt.data.challenge, nonce } });
      }
      if (attempt.status === 409) {
        console.log(`  = ${label}: already on the target relay, skipped`);
        skipped++;
        continue;
      }
      if (attempt.status !== 200) {
        console.log(`  ✗ ${label}: ${attempt.data.error || `HTTP ${attempt.status}`}`);
        failed++;
        continue;
      }
      const got = attempt.data.imported || {};
      console.log(`  ✓ ${label}: ${got.messages || 0} msgs, ${got.contacts || 0} contacts, ${got.groups || 0} groups (source had ${counts})`);
      moved++;
    } catch (err) {
      console.log(`  ✗ ${label}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone — ${moved} moved, ${skipped} already there, ${failed} failed.`);
  if (moved && !args.dry) {
    console.log('\nEveryone can now sign in on either relay with the same name and passphrase.');
    console.log('Chat history copied is the ciphertext that was on this relay; attachments stay behind.');
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
