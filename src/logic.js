import { isAdult } from "./shared.js";
export { isAdult };

// Only adults may create/edit/archive sheets and slots. This MIRRORS the
// `adult_writable` row policy on sheets/slots — a non-adult who saw manage
// controls would get a silent 403, so the client gate must match the server.
export function canManage(member) {
  return isAdult(member);
}

// Claim count for a slot from a flat claims array.
export function claimCount(slotId, claims) {
  return claims.filter((c) => c.slot_id === slotId).length;
}

// A slot is full when its live claim count reaches capacity.
export function isSlotFull(slot, claims) {
  return claimCount(slot.id, claims) >= Number(slot.capacity || 0);
}

// The caller's own claim on a slot, if any.
export function myClaim(slotId, claims, memberId) {
  return claims.find((c) => c.slot_id === slotId && c.member_id === memberId) ?? null;
}

// Aggregate progress across a sheet's slots.
export function sheetTotals(sheetId, slots, claims) {
  const own = slots.filter((s) => s.sheet_id === sheetId);
  const capacity = own.reduce((sum, s) => sum + Number(s.capacity || 0), 0);
  const claimed = own.reduce((sum, s) => sum + claimCount(s.id, claims), 0);
  const pct = capacity ? Math.min(100, Math.round((claimed / capacity) * 100)) : 0;
  return { claimed, capacity, pct, filled: capacity > 0 && claimed >= capacity };
}

// ── Share-link guests ─────────────────────────────────────────────────────────
// Rows in `guest_claims`, written only by the hub's external submit path. They
// are a SEPARATE ledger from member `slot_claims`: the hub bounds them against
// `slots.guest_capacity` by counting the submit table alone, so the two tallies
// are never added together and never compared to the same allowance.

// Guest sign-ups naming one slot. An empty slot id matches nothing — a row that
// lost its slot is an orphan (see unslottedGuestClaims), not a member of every
// slot's list.
export function guestClaimsForSlot(guestClaims, slotId) {
  if (!slotId) return [];
  return guestClaims.filter((g) => g.slot_id === slotId);
}

export function guestClaimCount(guestClaims, slotId) {
  return guestClaimsForSlot(guestClaims, slotId).length;
}

// A slot is closed to link guests when its guest tally reaches its guest
// allowance. Mirrors the hub's own claim predicate (`>= COALESCE(cap, 0)`), so
// a zero or missing allowance reads full here exactly as it does server-side.
export function isSlotGuestFull(slot, guestClaims) {
  return guestClaimCount(guestClaims, slot.id) >= Number(slot.guest_capacity || 0);
}

// Guest sign-ups on a sheet that name no slot the sheet still has. The public
// form requires a slot, so these can only come from a slot removed after the
// fact — surface them rather than let a real sign-up vanish from the sheet.
export function unslottedGuestClaims(guestClaims, slots, sheetId) {
  const live = new Set(slots.filter((s) => s.sheet_id === sheetId).map((s) => s.id));
  return guestClaims.filter((g) => g.sheet_id === sheetId && !live.has(g.slot_id));
}

// Human label for a slot_claims 409 reason returned by the hub endpoints.
export function claimErrorMessage(reason) {
  switch (reason) {
    case "slot_full": return "Someone just took the last opening on that slot.";
    case "slot_closed": return "That slot is closed and can no longer be claimed.";
    case "already_claimed": return "You already signed up for that slot.";
    default: return "Could not sign up. Please try again.";
  }
}

/**
 * Fields the in-app search matches against (see hub-sdk `searchMatch`).
 * Location and description count as well as the title — a sign-up
 * sheet is found by where the event is.
 */
export function searchableFields(item) {
  return [item.title, item.description, item.location];
}
