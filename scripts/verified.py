#!/usr/bin/env python3
"""Grant (or revoke) a verified GoatMessenger checkmark — the way it's meant
to be granted: by changing the shipped code, never the relay's database.

    python3 scripts/verified.py                # list current verified handles
    python3 scripts/verified.py nova           # grant @nova
    python3 scripts/verified.py nova --remove  # revoke @nova again

Why code, not db.json: the badge's tooltip promises that a relay operator
cannot mint a "verified" goat by editing the server's database. The single
source of truth is app/shared/verified.mjs, which ships inside every client.
This script patches exactly that file and tells you what must be rebuilt.
"""
import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FILE = ROOT / "app" / "shared" / "verified.mjs"
SET_RE = re.compile(r"const VERIFIED_HANDLES\s*=\s*new\s*Set\(\[.*?\]\);", re.S)
LINE_RE = re.compile(r"^\s*'([a-zA-Z0-9_]{3,24})'\s*,\s*(?://\s*(.*?))?\s*$", re.M)

NAME_HINT = "use 3-24 letters, digits or underscores (same rule as the relay)"


def read_entries(src):
    """Returns the [(name, comment)] pairs inside the VERIFIED_HANDLES Set."""
    match = SET_RE.search(src)
    if not match:
        sys.exit("ERROR: could not find the VERIFIED_HANDLES Set in verified.mjs")
    entries = []
    for line in match.group(0).split("\n"):
        entry = LINE_RE.match(line)
        if entry:
            entries.append((entry.group(1), (entry.group(2) or "").strip()))
    return entries, match


def render(entries):
    body = ""
    for name, comment in entries:
        line = f"  '{name}',"
        if comment:
            line += f" // {comment}"
        body += line + "\n"
    return f"const VERIFIED_HANDLES = new Set([\n{body}]);"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("name", nargs="?", default=None, help="goat name (username) to grant/revoke")
    ap.add_argument("--remove", action="store_true", help="revoke the checkmark instead of granting it")
    ap.add_argument("--file", default=str(DEFAULT_FILE), help="source path override (testing)")
    args = ap.parse_args()

    srcfile = Path(args.file)
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    entries, match = read_entries(srcfile.read_text(encoding="utf-8"))
    current = [n for n, _ in entries]

    info = [
        f"file      : {srcfile}",
        f"app ver   : v{pkg['version']}",
        "verified  : " + (", ".join(f"@{n}" for n in current) if current else "(none)"),
    ]

    if not args.name:
        print("\n".join(info))
        print("usage     : python3 scripts/verified.py <goat-name> [--remove]")
        return 0

    name = args.name.strip()
    if not re.fullmatch(r"[a-zA-Z0-9_]{3,24}", name):
        sys.exit(f"ERROR: invalid goat name @{name} — {NAME_HINT}")

    key = name.lower()
    if key == "billy":
        sys.exit("ERROR: @billy is the creator's account; edit that entry by hand if you must.")

    if args.remove:
        remaining = [(n, c) for (n, c) in entries if n.lower() != key]
        if len(remaining) == len(entries):
            print("\n".join(info))
            print(f"no change : @{name} was not verified.")
            return 0
        entries, action = remaining, "revoked"
    else:
        if key in {n.lower() for n, _ in entries}:
            print("\n".join(info))
            print(f"no change : @{name} is already verified.")
            return 0
        entries = entries + [(name, f"granted {date.today().isoformat()} via scripts/verified.py")]
        action = "granted"

    new_src = srcfile.read_text(encoding="utf-8")[: match.start()] + render(entries) + srcfile.read_text(encoding="utf-8")[match.end():]

    # sanity: the file must still place identical parseable entries
    check, _ = read_entries(new_src)
    if [n.lower() for n, _ in check] != [n.lower() for n, _ in entries]:
        sys.exit("ERROR: rewritten file fails its own verification — nothing written")
    srcfile.write_text(new_src, encoding="utf-8")

    after = [n for n, _ in entries]
    print("\n".join(info))
    print(f"{'REVOKE' if action == 'revoked' else 'GRANT '} : @{name}")
    print("verified  : " + (", ".join(f"@{n}" for n in after) if after else "(none)"))
    print(
        "\nnext steps (the badge ships with the code, not with a database edit):"
    )
    print("  1. node scripts/build-web.js      # sync the browser copy of the app")
    print("  2. commit + push, then rebuild & upload the DMG / portable exe")
    return 0


if __name__ == "__main__":
    sys.exit(main())
