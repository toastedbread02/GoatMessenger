// Signup proof of work, shared by the sign-up form and account migration.
//
// SHA-256 with `bits` leading zero bits over `${challenge}:${name}:${nonce}`.
// crypto.subtle is native, and an occasional yield keeps the UI alive while the
// loop grinds (~65k hashes at the default 16 bits — a second or two).
export async function solveProofOfWork(bits, challenge, name) {
  const enc = new TextEncoder();
  for (let n = 0; ; n++) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${challenge}:${name}:${String(n)}`)));
    let left = bits;
    for (const byte of digest) {
      if (byte === 0) { left -= 8; continue; }
      for (let m = 0x80; m > 0; m >>= 1) { if (byte & m) break; left--; }
      break;
    }
    if (left <= 0) return String(n);
    if (n % 256 === 0) await new Promise((resolve) => setTimeout(resolve));
  }
}
