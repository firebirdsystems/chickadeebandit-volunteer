import { describe, it, expect } from "vitest";
import {
  canManage, claimCount, isSlotFull, myClaim, sheetTotals, claimErrorMessage,
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
