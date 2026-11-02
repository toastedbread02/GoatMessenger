// Verified accounts.
//
// The checkmark lives here, in the shipped code — not in the relay database.
// That matters: a relay operator (even the one hosting your friend's relay)
// cannot mint a "verified" goat by editing their own db.json. The list can
// only grow by changing this file and shipping a new build.
export const VERIFIED_TIP =
  'Verified, this is the creator of the app, this can only be set through the actual code.';

const VERIFIED_HANDLES = new Set([
  'billy', // @billy — the creator's account (and a real goat)
]);

export function isVerified(username) {
  return VERIFIED_HANDLES.has(String(username || '').toLowerCase());
}
