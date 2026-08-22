import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const appHtml = readFileSync(join(__dirname, "../src/index.html"), "utf-8");

const migrationsDir = join(__dirname, "../migrations");
const schema = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf-8"))
  .join("\n");

// Mirrors the hub's BUILTIN_APP_DB_PLAINTEXT_COLS + suffix rules
// (packages/hub/src/cloudflare/manifest-common.ts). A column the hub filters,
// orders, joins or compares on must be plaintext: ciphertext is AES-GCM with a
// random IV, so an equality against an encrypted column silently matches
// nothing and a numeric comparison is meaningless.
const BUILTIN_PLAINTEXT = new Set([
  "id", "household_id", "created_at", "updated_at", "sent_at", "read_at",
  "expires_at", "last_synced_at", "completed", "all_day",
  "status", "type", "category", "week", "emoji", "icon",
  "position", "sort_order", "pinned", "key", "version",
  "visibility", "audience",
  "membership_type", "membership_roles",
]);

function isPlaintext(column) {
  return (
    BUILTIN_PLAINTEXT.has(column) ||
    /_(id|at|date|by)$/.test(column) ||
    (manifest.db_plaintext_columns ?? []).includes(column)
  );
}

function columnsOf(table) {
  const body = schema.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS app_volunteer__${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  expect(body, `no CREATE TABLE for ${table}`).toBeTruthy();
  const created = body[1]
    .split("\n")
    .map((line) => line.trim().match(/^([a-z_]+)\s+(TEXT|INTEGER|REAL|BLOB)\b/))
    .filter(Boolean)
    .map((m) => m[1]);
  // Later migrations add columns by ALTER and the manifest points at one of
  // them (guest_capacity) — read those too, or this helper reports a live
  // column as missing.
  const altered = [...schema.matchAll(
    new RegExp(`ALTER TABLE app_volunteer__${table} ADD COLUMN ([a-z_]+)\\b`, "g"),
  )].map((m) => m[1]);
  return [...created, ...altered];
}

const item = manifest.shareable.sheet;
const feed = item.feed;
const submit = item.submit;

describe("shareable.sheet", () => {
  it("shares the sheet, not the member ledger", () => {
    expect(item.table).toBe("sheets");
    expect(feed.table).toBe("guest_claims");
    // `slot_claims` names household members. It must never reach a public page,
    // in the feed or in an aggregate.
    const tables = [feed.table, ...(item.aggregates ?? []).map((a) => a.table)];
    expect(tables).not.toContain("slot_claims");
  });

  it("projects only columns that exist on sheets", () => {
    const columns = columnsOf("sheets");
    for (const col of item.columns) {
      expect(columns, `item projects unknown column ${col.column}`).toContain(col.column);
    }
  });

  it("hides an archived sheet behind a plaintext gate", () => {
    // Revoking is per-link; this makes archiving the sheet itself close every
    // link on it at once.
    expect(item.visible_where.column).toBe("archived");
    expect(item.visible_where.values).toEqual(["0"]);
    expect(isPlaintext("archived")).toBe(true);
  });

  it("declares no owner_column, so an automation-created sheet is still mintable", () => {
    // `owner_column` gates minting on created_by matching the caller. The
    // create_sheet automation writes created_by = "automation", which is no
    // member id — an owner gate would make exactly the sheets an automation
    // opens permanently unshareable. Adult + steward is the gate instead.
    expect(item.owner_column).toBeUndefined();
    expect(manifest.automation_actions.create_sheet.steps[0].values.created_by).toBe("automation");
  });
});

describe("shareable.sheet.feed", () => {
  it("reads the guest table the share form writes to", () => {
    expect(feed.table).toBe(submit.table);
    expect(feed.fk_column).toBe(submit.fk_column);
    expect(feed.fk_column).toBe("sheet_id");
  });

  it("projects only columns that exist on guest_claims", () => {
    const columns = columnsOf("guest_claims");
    for (const col of feed.columns) {
      expect(columns, `feed projects unknown column ${col.column}`).toContain(col.column);
    }
  });

  it("orders on a plaintext column that exists", () => {
    expect(columnsOf("guest_claims")).toContain(feed.order_column);
    expect(isPlaintext(feed.order_column), `${feed.order_column} must be plaintext to order on`).toBe(true);
  });

  it("declares no filters it cannot enforce", () => {
    for (const filter of feed.where ?? []) {
      expect(isPlaintext(filter.column)).toBe(true);
    }
    if (feed.parent_where) expect(isPlaintext(feed.parent_where.column)).toBe(true);
  });

  it("publishes every column the guest was asked for, and nothing else", () => {
    const submitted = new Set(submit.fields.map((f) => f.column));
    for (const col of feed.columns.map((c) => c.column)) {
      if (col === "created_at") continue; // stamped by the hub, not typed
      expect(submitted, `feed publishes ${col}, which no guest typed`).toContain(col);
    }
  });

  it("never publishes the raw slot id", () => {
    // The feed prints stored values and cannot join, so projecting slot_id
    // would show visitors a UUID. The `list` aggregate below is what resolves
    // those ids to slot titles.
    expect(feed.columns.some((c) => c.column === "slot_id")).toBe(false);
  });

  it("cannot truncate: the feed shows every row the app will ever hold", () => {
    expect(feed.max_items).toBe(submit.max_submissions);
    expect(feed.max_items).toBe(manifest.row_policies.guest_claims.max_rows);
  });
});

describe("shareable.sheet.aggregates", () => {
  const list = item.aggregates.find((a) => a.op === "list");

  it("resolves slot ids to titles through a lookup", () => {
    expect(list.table).toBe("guest_claims");
    expect(list.value_column).toBe("slot_id");
    expect(list.lookup.table).toBe("slots");
    expect(list.lookup.label_column).toBe("title");
    // The lookup JOINs on this column; ciphertext never joins. The label is
    // exempt — projections are decrypted on read.
    expect(isPlaintext(list.value_column)).toBe(true);
    expect(columnsOf("slots")).toContain(list.lookup.label_column);
  });

  it("counts guest rows only", () => {
    const count = item.aggregates.find((a) => a.op === "count");
    expect(count.table).toBe("guest_claims");
    expect(count.fk_column).toBe("sheet_id");
  });
});

// The dynamic slot select: the hub resolves `slots` for the public form and
// folds a per-option capacity claim into the INSERT's own WHERE, so two
// visitors can never take the same last opening.
describe("shareable.sheet.submit.slot_id (values_from)", () => {
  const slotField = submit.fields.find((f) => f.column === "slot_id");

  it("is a select sourcing its choices from the slots table", () => {
    expect(slotField.type).toBe("select");
    expect(slotField.values, "values and values_from are mutually exclusive").toBeUndefined();
    expect(slotField.values_from.table).toBe("slots");
    expect(slotField.values_from.fk_column).toBe("sheet_id");
  });

  it("keys options on columns the slots table actually has", () => {
    const columns = columnsOf("slots");
    for (const key of ["fk_column", "id_column", "label_column", "capacity_column"]) {
      expect(columns, `slots has no ${slotField.values_from[key]}`).toContain(slotField.values_from[key]);
    }
  });

  it("writes the chosen option id into a real, plaintext column", () => {
    expect(columnsOf("guest_claims")).toContain("slot_id");
    expect(isPlaintext("slot_id"), "the hub writes the option id raw, outside the codec").toBe(true);
  });

  it("bounds guests with their OWN allowance, never the member capacity", () => {
    // Occupancy is a COUNT over the submit table alone, so pointing this at
    // `capacity` would let a slot take its full member claims AND that many
    // guest claims on top.
    expect(slotField.values_from.capacity_column).toBe("guest_capacity");
    expect(slotField.values_from.capacity_column).not.toBe("capacity");
    expect(isPlaintext("guest_capacity")).toBe(true);
  });

  it("offers only slots the app itself considers open", () => {
    // Parity with the member side: slot_claims.slot_open_values gates claims on
    // the same column and value, so closing a slot closes both doors.
    expect(slotField.values_from.where).toEqual([{ column: "status", values: ["open"] }]);
    expect(manifest.slot_claims.slot_status_column).toBe("status");
    expect(manifest.slot_claims.slot_open_values).toEqual(["open"]);
  });

  it("is required, so nobody can sign up while dodging the capacity bound", () => {
    // Unlike a potluck dish, a volunteer sign-up naming no slot means nothing —
    // and an optional field would be a way past `guest_capacity` entirely. When
    // every slot is closed or full the form fails closed, which is correct: the
    // sheet is covered.
    expect(slotField.required).toBe(true);
  });

  it("stays inside the hub's single-statement bind budget", () => {
    // id + fk, one per field, one per fixed value, parent admission
    // (parent id + visible_where values + owner + max_rows), and per dynamic
    // select one option id plus each of its filter values.
    const gate = item.visible_where?.values?.length ?? 0;
    const dynamic = submit.fields
      .filter((f) => f.values_from)
      .reduce((n, f) => n + 1 + (f.values_from.where ?? []).reduce((k, w) => k + w.values.length, 0), 0);
    const total = 2 + submit.fields.length
      + Object.keys(submit.fixed_values ?? {}).length
      + 1 + gate
      + (item.owner_column ? 1 : 0)
      + (manifest.row_policies.guest_claims.max_rows ? 1 : 0)
      + dynamic;
    expect(total).toBeLessThanOrEqual(80);
  });
});

// Guest rows are authored by anonymous visitors through a path that bypasses
// every member-side gate, so the table stays endpoint_only: the app may read
// the rows but may never edit or delete them. Widening it to adult_writable
// would hand every adult in a shared space edit rights over sign-ups on someone
// else's sheet — steward_writes_only is inert outside a roster, and volunteer
// cannot be roster-installed anyway (its contexts carry no shared_space.roster
// token) — a worse trade than living without a delete affordance.
describe("row_policies.guest_claims", () => {
  const policy = manifest.row_policies.guest_claims;

  it("stays write-closed to members", () => {
    expect(policy.kind).toBe("endpoint_only");
    expect(policy.read).toBe("everyone");
  });

  it("declares no member-facing write surface over external rows", () => {
    expect(policy.steward_writes_only).toBeUndefined();
    expect(policy.audit_writes).toBeUndefined();
  });

  it("is not roster-installable, which is why the read stays open", () => {
    expect(manifest.contexts).not.toContain("shared_space.roster");
  });

  it("keeps the per-link and per-table caps in step", () => {
    expect(policy.max_rows).toBe(submit.max_submissions);
  });
});

describe("the app's own controls over the share surface", () => {
  it("never writes the guest table", () => {
    expect(appHtml).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM) app_volunteer__guest_claims/);
    expect(appHtml).toContain("SELECT * FROM app_volunteer__guest_claims");
  });

  it("writes guest_capacity on slots, the one control it does own", () => {
    expect(appHtml).toContain("UPDATE app_volunteer__slots SET guest_capacity = ?");
  });

  it("gates every share control on the hub having injected the URLs", () => {
    expect(appHtml).toContain("createShareHelper(window.__SHARE_CREATE_URL");
    expect(appHtml).toContain("share.enabled && canManage()");
  });

  it("mints links against the declared item type", () => {
    expect(appHtml).toContain('share.create("sheet"');
    expect(Object.keys(manifest.shareable)).toEqual(["sheet"]);
  });
});
