import { describe, it, expect } from "vitest";
import {
  canManage, claimCount, isSlotFull, myClaim, sheetTotals, claimErrorMessage, searchableFields,
  guestClaimsForSlot, guestClaimCount, isSlotGuestFull, unslottedGuestClaims,
} from "../src/logic.js";

const adult = { id: "a1", role: "adult" };
const child = { id: "c1", role: "child" };

describe("canManage mirrors adult_writable", () => {
  it("adults can manage", () => expect(canManage(adult)).toBe(true));
  it("children cannot", () => expect(canManage(child)).toBe(false));
  it("null cannot", () => expect(canManage(null)).toBe(false));
});

describe("slot capacity helpers", () => {
  const slots = [
    { id: "s1", sheet_id: "sh1", capacity: 2 },
    { id: "s2", sheet_id: "sh1", capacity: 1 },
  ];
  const claims = [
    { id: "x1", slot_id: "s1", member_id: "m1" },
    { id: "x2", slot_id: "s1", member_id: "m2" },
    { id: "x3", slot_id: "s2", member_id: "m1" },
  ];

  it("counts claims per slot", () => {
    expect(claimCount("s1", claims)).toBe(2);
    expect(claimCount("s2", claims)).toBe(1);
  });

  it("detects a full slot", () => {
    expect(isSlotFull(slots[0], claims)).toBe(true); // 2/2
    expect(isSlotFull({ id: "s3", capacity: 3 }, claims)).toBe(false);
  });

  it("finds the caller's own claim", () => {
    expect(myClaim("s1", claims, "m1")?.id).toBe("x1");
    expect(myClaim("s1", claims, "nobody")).toBe(null);
  });

  it("aggregates sheet totals", () => {
    const t = sheetTotals("sh1", slots, claims);
    expect(t.capacity).toBe(3);
    expect(t.claimed).toBe(3);
    expect(t.pct).toBe(100);
    expect(t.filled).toBe(true);
  });
});

describe("claimErrorMessage", () => {
  it("maps known reasons", () => {
    expect(claimErrorMessage("slot_full")).toMatch(/last opening/i);
    expect(claimErrorMessage("already_claimed")).toMatch(/already/i);
    expect(claimErrorMessage("slot_closed")).toMatch(/closed/i);
    expect(claimErrorMessage("wat")).toMatch(/try again/i);
  });
});

describe("searchableFields", () => {
  it("matches on location and description, not just the sheet title", () => {
    const fields = searchableFields({ title: "Summer fete", description: "gazebo and raffle", location: "Village green" });
    expect(fields).toContain("Village green");
    expect(fields).toContain("gazebo and raffle");
  });
});

// Share-link sign-ups are a second ledger over the same slots. Every assertion
// here is about keeping it separate from the member one — the hub bounds guest
// rows against `guest_capacity` by counting `guest_claims` alone, so any helper
// that mixed the two would disagree with the server.
describe("the guest ledger", () => {
  const slots = [
    { id: "s1", sheet_id: "sh1", capacity: 2, guest_capacity: 2 },
    { id: "s2", sheet_id: "sh1", capacity: 1, guest_capacity: 0 },
  ];
  const guests = [
    { id: "g1", sheet_id: "sh1", slot_id: "s1", guest_name: "Marta" },
    { id: "g2", sheet_id: "sh1", slot_id: "s1", guest_name: "Ken" },
    { id: "g3", sheet_id: "sh1", slot_id: "gone", guest_name: "Orphan" },
    { id: "g4", sheet_id: "sh2", slot_id: "s9", guest_name: "Other sheet" },
  ];

  it("groups sign-ups by the slot they named", () => {
    expect(guestClaimsForSlot(guests, "s1").map(g => g.id)).toEqual(["g1", "g2"]);
    expect(guestClaimCount(guests, "s1")).toBe(2);
    expect(guestClaimCount(guests, "s2")).toBe(0);
  });

  it("never treats an empty slot id as a match", () => {
    // A blank cell is the column default, not "every slot" — matching on it
    // would show one orphaned row under every slot on the sheet.
    expect(guestClaimsForSlot([{ id: "x", slot_id: "" }], "")).toEqual([]);
  });

  it("measures fullness against the guest allowance, not the member capacity", () => {
    expect(isSlotGuestFull(slots[0], guests)).toBe(true);   // 2 guests / 2 allowed
    expect(isSlotGuestFull({ id: "s3", capacity: 5, guest_capacity: 1 }, guests)).toBe(false);
  });

  it("reads a zero allowance as full, the way the hub's claim does", () => {
    // The hub compares `occupancy >= COALESCE(capacity, 0)`, so an unset or
    // zeroed allowance fails CLOSED. The app must agree or it would offer a
    // guest spot the server refuses.
    expect(isSlotGuestFull(slots[1], guests)).toBe(true);
    expect(isSlotGuestFull({ id: "s4", sheet_id: "sh1" }, guests)).toBe(true);
  });

  it("surfaces a sign-up whose slot is gone, scoped to its own sheet", () => {
    const orphans = unslottedGuestClaims(guests, slots, "sh1");
    expect(orphans.map(g => g.id)).toEqual(["g3"]);
  });
});
