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

// ── Calendar export ───────────────────────────────────────────────────────────

export const CALENDAR_EXPORT_HORIZON_DAYS = 180;
export const CALENDAR_EXPORT_MAX_EVENTS = 100;

function atMidnight(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** Local YYYY-MM-DD for a Date. Only ever used to project the horizon forward. */
function isoDay(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Build the `calendar_events` payload from upcoming sign-up sheets.
 *
 * Shape matches what the hub's cross-app aggregation consumes — see
 * `normalizeExportedEvent` in packages/hub/src/cloudflare/calendar-feed.ts.
 * The SHEET is the dated thing: `event_date` is a bare day with no time, so
 * every entry is all-day. Slots are deliberately not exported — `starts_at`
 * is not in `db_plaintext_columns`, so it is encrypted at rest and carries no
 * day of its own, and a slot adds no date the sheet does not already have.
 * Claims are not exported either: they are a person's name against a shift,
 * and this payload is scope-wide.
 *
 * `description` is deliberately NOT exported. This payload reaches the
 * household's ICS feed, which external calendar services fetch, and the
 * description is free text an organizer wrote for the household. Location IS
 * exported because telling you where to go is what a calendar entry is FOR.
 */
export function buildCalendarEvents(sheets, todayIso, from = new Date()) {
  const horizon = isoDay(new Date(atMidnight(from).getTime() + CALENDAR_EXPORT_HORIZON_DAYS * 86400000));
  return sheets
    // `event_date` defaults to the empty string, and a sheet with no date has
    // nothing to put on a calendar — an empty value would also sort ahead of
    // every real one and eat the cap.
    .filter((s) => !Number(s.archived) && s.event_date && s.event_date >= todayIso && s.event_date <= horizon)
    .map((s) => ({
      id: s.id,
      title: s.title,
      description: "Volunteer sheet",
      location: s.location || "",
      start: s.event_date,
      end: s.event_date,
      all_day: true,
      // A sheet is an open ask to the whole scope, not an assignment to
      // anyone: nobody is named until they claim a slot, and claims stay out
      // of this payload.
      member_ids: [],
      source_label: "Volunteer",
    }))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)))
    .slice(0, CALENDAR_EXPORT_MAX_EVENTS);
}
