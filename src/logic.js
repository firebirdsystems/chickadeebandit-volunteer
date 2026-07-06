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

// Human label for a slot_claims 409 reason returned by the hub endpoints.
export function claimErrorMessage(reason) {
  switch (reason) {
    case "slot_full": return "Someone just took the last opening on that slot.";
    case "slot_closed": return "That slot is closed and can no longer be claimed.";
    case "already_claimed": return "You already signed up for that slot.";
    default: return "Could not sign up. Please try again.";
  }
}
