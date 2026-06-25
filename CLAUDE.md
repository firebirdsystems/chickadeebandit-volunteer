# App Development Guide

This document covers the patterns all apps in this monorepo follow. Read it before generating or modifying any app.

## Runtime globals

The hub injects these globals into every app at runtime:

```js
const CONTEXT         = window.__CONTEXT_URL    ?? "";  // fetch family context (members, etc.)
const DB              = window.__DB_URL         ?? "";  // SQL database endpoint (storage:"db" apps only)
const STORE           = window.__STORE_URL      ?? "";  // key-value store
const FILES           = window.__FILES_URL      ?? "";  // file upload endpoint
const DOCS            = window.__DOCS_URL       ?? "";  // hub-native document storage (see below)
const CROSS_WRITE_URL = window.__CROSS_WRITE_URL ?? ""; // cross-app writes (hub-sdk crossWrite uses this)
const APP_ID          = window.__APP_ID         ?? "my-app";
const ME              = window.__CURRENT_MEMBER ?? null; // { id, name, role }
const EVENTS_URL      = window.__EVENTS_URL     ?? "/api/events";
```

`ME` is null in demo mode (no logged-in user). Always guard against it.

## DB helper

Every app that uses SQL defines this helper:

```js
async function db(sql, params = []) {
  if (!DB) return { rows: [] };
  const res = await fetch(DB, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  return res.json(); // { rows: [...] }
}
```

Schema is managed by hub migrations in `migrations/001_init.sql` — do not run `CREATE TABLE` at runtime.

Every table that stores per-household data **must** declare `household_id` as `UUID`, not `TEXT`:

```sql
household_id UUID NOT NULL DEFAULT current_setting('app.household_id', true)::uuid,
```

Using `TEXT` causes a Postgres type error (`operator does not exist: text = uuid`) when the hub queries app storage usage, and breaks row-level security policies that compare the column as a uuid.

## hub-sdk.js

Import shared utilities from `/hub-sdk.js`:

```js
import { memberColor, initial, esc, isAdult, hubConfirm, formatRelativeDate, fmtMoney, fmtMoneyShort } from "/hub-sdk.js";
```

- `memberColor(memberId, members)` — deterministic color string for a member's avatar
- `initial(name)` — first letter of a name for avatar display
- `esc(str)` — HTML-escape a string before injecting into innerHTML
- `isAdult(member, members)` — returns true if the member has role "adult"
- `hubConfirm({ message, description?, confirmLabel?, destructive? })` — async confirm dialog; returns true/false
- `fmtMoney(cents)` — format integer cents as USD with no decimals: `fmtMoney(125000)` → `"$1,250"`. Returns `"—"` for null.
- `fmtMoneyShort(cents)` — compact format for large amounts: `$450K`, `$1.3M`. Use for summary displays.
- `createStreamHelper(streamUrl, eventType, callback)` — opens an SSE connection to `window.__STREAM_URL` and calls `callback(event)` for each event. Auto-reconnects on close. Returns `{ connect(), disconnect() }`. Pass `null` as `eventType` to receive all event types.

Always use `esc()` when rendering user-provided strings into HTML templates.

### Updating hub-sdk.js

`hub-sdk.js` exists in three places that must all be kept in sync whenever a function is added or changed:

1. `app-template/hub-sdk.js` — canonical source. `dev.mjs` fetches this file from GitHub to serve during local development. **This is the file to edit.**
2. Root `hub-sdk.js` (one level up from `app-template/`) — convenience copy used as a reference; keep identical to `app-template/hub-sdk.js`.
3. `packages/hub/public/hub-sdk.js` in the **chickadeebandit** repo — the file actually served to apps at runtime in production. Must be updated to match or new SDK functions won't be available in the deployed hub.

After editing `app-template/hub-sdk.js`, copy it to the other two locations:

```bash
cp app-template/hub-sdk.js hub-sdk.js
cp app-template/hub-sdk.js ../chickadeebandit/packages/hub/public/hub-sdk.js
```

## Loading members

```js
async function loadMembers() {
  if (!CONTEXT) {
    members = [/* demo fallback */];
    return;
  }
  try {
    const res = await fetch(`${CONTEXT}?keys=family.members`);
    members = ((await res.json())["family.members"]) ?? [];
  } catch { members = []; }
}
```

## Notifications

```js
async function notify(title, body) {
  await fetch("/api/notifications/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, url: `/run/${APP_ID}` }),
  }).catch(() => {});
}
```

Always `.catch(() => {})` — notifications are best-effort.

**The default `audience` is `"all"` — the whole household.** Never send the contents of a
restricted item (a private/role/board-only channel message, an adults-only note, etc.)
through the plain `notify` helper: every member's device receives the preview, even members
who can't open the item. To target specific people, pass an explicit member-id list:
`{ title, body, audience: ["member-id-1", "member-id-2"] }`. But you usually can't compute
"who follows this channel" on the client (that data is `owner_only`) — use
`subscription_notify` below.

### `subscription_notify` — notify a topic's followers without leaking previews

For "follow this channel / thread / event and get notified of new activity", declare
`subscription_notify`. The hub exposes `POST /run/{appId}/api/notify-subscribers`, which
reads your per-member opt-in table (kept `owner_only`, so the client can't read other
members' rows), unions in any explicit `also_notify` ids (e.g. @mentions), drops the
sender, then **re-checks that each recipient may still see the topic** before pushing only
to them. The caller must also be eligible for the topic (a non-member can't trigger
notifications into a channel they're not in).

**Why you can't do this with the plain `notify` helper:** subscriptions are `owner_only`,
so a member's browser can only read *its own* follow rows — it can't resolve, let alone
fan out to, the full follower list. And `owner_only` lets any member opt into any topic id,
so the recipient list must be re-filtered server-side or a non-member who subscribed to a
private channel would receive its previews.

```jsonc
// manifest.json — the subscription table must have an owner_only row policy
{
  "row_policies": {
    "channel_subscriptions": { "kind": "owner_only", "member_column": "member_id", "adults_bypass": false }
  },
  "subscription_notify": {
    "subscription_table": "channel_subscriptions",
    "topic_column": "channel_id",
    "member_column": "member_id",
    "eligibility": {
      "kind": "channel_membership",
      "channels_table": "channels",
      "membership_type_column": "membership_type",   // must be plaintext (db_plaintext_columns)
      "membership_roles_column": "membership_roles",  // must be plaintext
      "membership_table": "channel_members",
      "membership_channel_column": "channel_id",
      "membership_member_column": "member_id"
    }
  }
}
```

```js
// Follow / unfollow is just an owner_only write of the caller's own row:
await db(`INSERT INTO app_x__channel_subscriptions (channel_id, member_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, [channelId, ME.id]);
await db(`DELETE FROM app_x__channel_subscriptions WHERE channel_id = ? AND member_id = ?`, [channelId, ME.id]);

// After a new message, fan out (fire-and-forget) through the hub:
await fetch(window.__NOTIFY_SUBSCRIBERS_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    topic_id: channelId,
    title: `#${channelName}`,
    body: `${ME.name}: ${text.slice(0, 80)}`,
    url: `/run/${APP_ID}?channelId=${channelId}`,
    also_notify: mentionedMemberIds,   // optional — unioned with followers, still eligibility-checked
  }),
}).catch(() => {});
```

`eligibility.kind: "channel_membership"` mirrors the `channel_scoped` row policy
(`all` / `role` / `custom` membership). `channels_id_column` defaults to `"id"`;
`all_value`/`role_value` default to `"all"`/`"role"`. The `membership_type`/`membership_roles`
columns must be plaintext (the same requirement `channel_scoped` imposes). `group-channels`
is the reference implementation.

## Activity log

Many apps log user actions to an `activity` table:

```js
async function logActivity(recordId, action, detail = "") {
  const id = crypto.randomUUID();
  await db(
    `INSERT INTO activity (id, record_id, actor_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, recordId, ME?.id ?? "system", action, detail, new Date().toISOString()]
  );
}
```

## Optimistic local state updates

After a main DB write succeeds, update local state immediately and re-render — do **not** reload from the database. A reload adds a full round-trip before the user sees any feedback.

```js
async function createItem(fields) {
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  // 1. Write to DB
  await db(`INSERT INTO items (id, title, created_at) VALUES (?, ?, ?)`, [id, fields.title, now]);

  // 2. Update local state and render immediately
  items = [{ id, title: fields.title, created_at: now, status: "active" }, ...items];
  closeModal();
  render();

  // 3. Fire side effects in the background — don't block the UI
  Promise.all([
    logActivity(id, "created", `${ME.name} created "${fields.title}"`),
    notify(`New item: ${fields.title}`, `${ME.name} added a new item.`),
    fetch("/api/activity", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "item_created", actor: ME.name,
        description: `${ME.name} created "${fields.title}"`,
        metadata: { deepLink: { appId: APP_ID, params: { itemId: id } } } }),
    }).catch(() => {}),
  ]).catch(() => {});
}
```

For updates and deletes, patch the array in-place:

```js
// update
const idx = items.findIndex(i => i.id === id);
if (idx !== -1) items[idx] = { ...items[idx], title: fields.title, updated_at: now };

// delete
items = items.filter(i => i.id !== id);
```

Never re-fetch the full list from the DB just to reflect a change you already know about.

## Member lookup map

Build a `Map` once after `loadMembers()` completes. Use it everywhere instead of `.find()` — avoids an O(n) scan on every card render.

```js
let members   = [];
let memberMap = new Map();

async function loadMembers() {
  if (!CONTEXT) {
    members = [{ id: "demo-1", name: "Alex", role: "adult" }, /* … */];
    memberMap = new Map(members.map(m => [m.id, m]));
    return;
  }
  try {
    const res = await fetch(`${CONTEXT}?keys=family.members`);
    members = ((await res.json())["family.members"]) ?? [];
  } catch { members = []; }
  memberMap = new Map(members.map(m => [m.id, m]));
}

// Use map lookups everywhere — not .find()
function memberName(id) { return memberMap.get(id)?.name ?? "Unknown"; }
```

## Parallelizing independent async calls

`loadMembers()` and `loadItems()` are independent — run them in parallel at startup:

```js
(async () => {
  await Promise.all([loadMembers(), loadItems()]);
  render();
  handleDeepLink();
})();
```

Side effects like `logActivity`, `notify`, and `/api/activity` are also independent of each other — batch them in a fire-and-forget `Promise.all` after the UI has already updated (see optimistic local state above). Never chain them sequentially with separate `await` calls.

## Modal pattern

Most apps use a single `modalEl` variable:

```js
let modalEl = null;
function openModal(html) {
  closeModal();
  modalEl = document.createElement("div");
  modalEl.className = "modal-backdrop";
  modalEl.innerHTML = `<div class="modal">${html}</div>`;
  modalEl.addEventListener("click", e => { if (e.target === modalEl) closeModal(); });
  document.body.appendChild(modalEl);
}
function closeModal() { modalEl?.remove(); modalEl = null; }
```

## Loading state on submit buttons

Any async submit handler must disable its button immediately so the user knows work is in progress:

```js
window.submitForm = async function(existingId) {
  // 1. validate first — bail before touching UI
  const name = document.getElementById("f-name").value.trim();
  if (!name) { document.getElementById("f-name").focus(); return; }

  // 2. disable the button
  const btn = modalEl?.querySelector('.modal-actions .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  // 3. do async work — on success, closeModal() removes the button from DOM
  try {
    await saveRecord({ name });
    closeModal();
    render();
  } catch (e) {
    // restore so user can retry
    if (btn) { btn.disabled = false; btn.textContent = existingId ? 'Save' : 'Create'; }
    throw e;
  }
};
```

For buttons outside a modal (e.g. an inline Add button), find them directly:

```js
const btn = document.querySelector('.add-btn');
if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
await addItem(val);
if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
```

## Hub CSS variables

Apps inherit these CSS custom properties from the hub theme at runtime:

```css
--hub-bg           /* page background */
--hub-surface      /* card/panel background */
--hub-border       /* default border color */
--hub-text         /* primary text */
--hub-text-muted   /* secondary/muted text */
--hub-primary      /* accent color (buttons, links) */
--hub-primary-fg   /* foreground on accent color */
--hub-primary-hover
--hub-radius       /* border-radius for cards/buttons */
--hub-font-size    /* base font size */
--hub-font         /* font-family */
```

Always define fallback values: `var(--hub-bg, #f9fafb)`.

## Deep linking

The hub can open an app at a specific item by appending query params to the iframe URL. Apps that support deep linking should read those params on startup and navigate to the referenced item.

### Handling incoming deep-link params

Read `window.location.search` during init and navigate to the referenced item if params are present:

```js
function handleDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const pollId = params.get("pollId");
  if (pollId) openPoll(pollId);
}

(async () => {
  await Promise.all([loadMembers(), loadItems()]);
  handleDeepLink(); // after data is loaded so the item exists
  render();
})();
```

Pick param names that are specific to your app (e.g. `pollId`, `taskId`, `recipeId`). The hub passes whatever params were in the link — there is no shared namespace.

### Navigating to another app with params

Use the `hub:open` postMessage to send the user to a specific item in another app:

```js
window.parent.postMessage({
  type: "hub:open",
  appId: "grocery",
  params: { listId: "abc123" },
}, "*");
```

The hub navigates to `/open/grocery?listId=abc123`, which passes `?listId=abc123` into the grocery app's iframe.

### Logging activity with a deep link

When you log hub-level activity (via `/api/activity` or a hub SDK helper), include a `deepLink` in the metadata so the activity item and notification bell become clickable links:

```js
await fetch("/api/activity", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    type: "poll_created",
    description: `${ME.name} created a new poll: "${title}"`,
    metadata: {
      deepLink: {
        appId: APP_ID,
        params: { pollId: id },
      },
    },
  }),
}).catch(() => {});
```

The hub renders that activity entry as a link to `/open/{appId}?pollId={id}`. Without `deepLink`, the entry is plain text.

## Events API

Publish cross-app events other apps can consume:

```js
await fetch(EVENTS_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    source_app_id: APP_ID,
    type: "event.type",       // e.g. "allowance.weekly"
    subject_id: memberId,
    payload: { /* ... */ },
  }),
}).catch(() => {});
```

If your manifest declares `publishes` and/or `alert_on`, you **must** call the events endpoint in app code after the relevant action — declaring these fields alone does nothing. Always call it as a fire-and-forget side effect after the UI has already updated.

### `publish_acls` — gating who may emit an event

Any household member can POST to your app's events endpoint. If an event carries value another app acts on (e.g. `reward.earned` → piggy-bank credits allowance), gate it so only adults can emit it:

```json
{
  "publishes": ["reward.earned", "item.closed"],
  "publish_acls": {
    "reward.earned": { "require_role": "adult" },
    "item.closed":   { "require_role": "adult" }
  }
}
```

The hub enforces `require_role` server-side when the events endpoint is called — a child POSTing the event directly gets a 403. Declare `publish_acls` for any event whose payload another app treats as authoritative.

## File uploads

Use `createFilesHelper` from `/hub-sdk.js` for all file operations. It handles correct URL construction, upload error detection, and deletion — do not roll your own `fetch` calls against `FILES`.

```js
import { createFilesHelper } from "/hub-sdk.js";
const files = createFilesHelper(window.__FILES_URL ?? "");
```

**Upload** — resolves with `{ id, url }` or throws on any server error (wrong MIME type → 415, too large → 413, storage limit → 507). Never insert a DB record until `upload()` resolves successfully.

```js
async function uploadFile(file) {
  const { id: fileId, url: fileUrl } = await files.upload(file);
  // now safe to insert into your DB
}
```

**Delete** — takes the file ID (not a URL):

```js
await files.delete(fileId).catch(() => {});
```

**List** — returns `{ files, totalBytes, limit }`:

```js
const { files: fileList, totalBytes, limit } = await files.list();
```

**Get a file URL** — for linking or displaying:

```js
const url = files.url(fileId);  // e.g. /run/{app-id}/api/files/{id}
```

**Show the upload area only when files are available** (guard against demo mode):

```js
const uploadHtml = window.__FILES_URL ? `<div class="upload-area">…</div>` : "";
```

Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic`, `image/heif`, `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx), `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx), `text/plain`, `text/markdown`.

## Hub-native document storage

For documents that should persist in the hub (survive app reinstall, appear in the household document library, respect encryption at rest), use `window.__DOCS_URL` instead of — or alongside — your own app DB.

```js
const DOCS = window.__DOCS_URL ?? "";
```

**Create** — POST a document record. `fileKey` is the ID returned by `files.upload()`.

```js
const { id } = await fetch(DOCS, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    title:    file.name,           // required
    category: "home",              // required: medical | legal | home | financial | other
    fileKey:  uploadResult.id,     // from files.upload()
    mimeType: file.type,
    sizeBytes: file.size,
    sourceId: itemId,              // optional: link to your own entity (e.g. a maintenance item)
    folder:   "Warranties",        // optional: freeform grouping label
    sharedWith: ["everyone"],      // optional: [] = owner-only, ["everyone"] = whole household
  }),
}).then(r => r.json());
```

**List** — GET with optional filters:

```js
const docs = await fetch(`${DOCS}?sourceId=${itemId}`).then(r => r.json());
// also: ?folder=Warranties
```

**Delete** — DELETE by document ID (also delete the associated file):

```js
await fetch(`${DOCS}/${docId}`, { method: "DELETE" });
await files.delete(doc.fileKey).catch(() => {});
```

Hub documents are automatically deleted when the app is uninstalled. Storage usage counts against the app's `max_docs_bytes` limit (default 100 MB). Guard against demo mode:

```js
const uploadHtml = window.__DOCS_URL ? `<div class="upload-area">…</div>` : "";
```

## Cross-app data sharing

Apps can read and write each other's KV store data. Both sides must declare intent in their manifests; the hub enforces both at runtime.

### Exposing data to other apps

Declare the KV keys you want to make readable (or writable) by other apps:

```json
{
  "exports": ["recipes", "pending_items"]
}
```

Export key names must be lowercase alphanumeric, hyphens, or underscores.

### Reading another app's exported key

Declare the key in `data_access.reads` using the pattern `app.{appId}.{key}`:

```json
{
  "data_access": {
    "reads": ["family.members", "app.recipes.recipes"],
    "writes": []
  }
}
```

Then fetch it the same way as any context key:

```js
const res = await fetch(`${CONTEXT}?keys=app.recipes.recipes`);
const data = await res.json();
const recipes = data["app.recipes.recipes"] ?? [];
```

The hub returns the parsed JSON value of the source app's KV entry for that key. Returns `null` if the key hasn't been written yet.

### Writing to another app's exported key

Declare the key in `data_access.writes`:

```json
{
  "data_access": {
    "reads": [],
    "writes": ["app.grocery.pending_items"]
  }
}
```

Then use `crossWrite` from `/hub-sdk.js`:

```js
import { crossWrite } from "/hub-sdk.js";

await crossWrite("grocery", "pending_items", [
  { op: "array_append", path: "items", value: { name: "Flour", addedBy: "Meal Planner" } },
  { op: "array_append", path: "items", value: { name: "Eggs",  addedBy: "Meal Planner" } },
]);
```

`crossWrite` uses the same patch ops as the KV store PATCH endpoint: `array_append`, `array_remove`, `set`, `increment`, `delete`. The `path` is a dotted path within the JSON blob stored at the key.

Writes count against the **calling** app's daily write quota, not the target app's.

### The inbox pattern (for `storage: db` apps)

DB-storage apps can't receive writes directly into their SQL schema. Instead, expose a KV key as an inbox, then drain it on load:

```js
async function processPendingInbox() {
  if (!STORE) return;
  try {
    const res = await fetch(`${STORE}?key=pending_items`);
    if (!res.ok) return;
    const { value } = await res.json();
    if (!value) return;
    const pending = JSON.parse(value).items ?? [];
    if (!pending.length) return;

    for (const item of pending) {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!name) continue;
      await db(`INSERT INTO items (...) VALUES (...)`, [...])
        .catch(() => {}); // silently ignore duplicates
    }

    await fetch(`${STORE}?key=pending_items`, { method: "DELETE" });
  } catch { /* non-fatal */ }
}
```

Call it during init before loading your main data:

```js
(async () => {
  await loadMembers();
  await processPendingInbox(); // drain inbox first
  await loadItems();
  render();
})();
```

The inbox key must be listed in `exports`. Keep inbox processing non-fatal — always wrap in try/catch and never let it block the app from loading.

### Permission escalation

When an app update **adds** new cross-app reads, writes, or exports, the hub automatically queues the update for admin approval even if `requires_approval` is `false` in the manifest. The admin will see a callout in the update review screen explaining what new access was added.

## Resource limits

The hub injects current limits into `window.__RESOURCE_LIMITS`:

```js
const LIMITS = window.__RESOURCE_LIMITS ?? {};
// LIMITS.max_file_bytes      — max bytes per individual upload (default 10 MB)
// LIMITS.max_files_bytes     — max total file storage for this app (default 500 MB)
// LIMITS.max_db_bytes        — max DB storage for this app (default 200 MB)
// LIMITS.max_store_bytes     — max KV storage for this app
// LIMITS.max_store_reads_per_day
// LIMITS.max_store_writes_per_day
```

Apps do not need to enforce these limits themselves — the hub enforces them and returns 507 when exceeded. But apps may read them to display a storage bar or warn the user before an upload.

## Nav label

Every app must include a `nav` field in `manifest.json` so it appears in the hub's left navigation by default:

```json
"nav": { "label": "My App" }
```

Use a short label (1–2 words). Never omit this field — apps without it are invisible in the nav until an admin manually enables them.

## Base href

Every app sets `<base href="/run/{app-id}/">` in `<head>` so relative asset paths resolve correctly inside the hub iframe.

## Extracting testable logic

Apps with non-trivial pure logic should extract it into `src/logic.js` so it can be unit-tested without a browser environment.

**Pattern:**

1. `src/shared.js` — mirrors any `hub-sdk.js` functions used by logic (e.g. `isAdult`, `esc`). Tests import from here instead of the browser-only SDK.

2. `src/logic.js` — exports pure functions. Import from `shared.js`, not `/hub-sdk.js`:

```js
import { isAdult } from "./shared.js";
export { isAdult };

export function canSeeItem(item, me) {
  if (isAdult(me)) return true;
  return item.visibility === "public";
}
```

3. `src/index.html` — imports from both `/hub-sdk.js` (browser globals) and `./logic.js` (pure functions). Use aliased imports to avoid shadowing if you wrap them with local state:

```js
import { esc, isAdult, hubConfirm } from "/hub-sdk.js";
import { canSeeItem as _canSeeItem } from "./logic.js";

// thin wrapper that binds to app state
function canSeeItem(item) { return _canSeeItem(item, ME); }
```

4. `__tests__/logic.test.mjs` — imports from `../src/logic.js`. No DOM, no mocks needed for pure functions.

**When to extract logic:**
- Access control checks (who can see/edit/vote)
- Derived status or computed values from raw data
- Non-trivial filtering or sorting
- Date/money formatting with edge cases

**When not to:** DB calls, render functions, event handlers, and anything that closes over module-level state belong in the HTML script and don't need extraction.

## Demo mode

When `DB` and `CONTEXT` are empty strings (local development or demo), the app should work with hardcoded demo data. Never crash or show an error when these are missing — show sample data instead.

## Security constraints

### Migration SQL

Each household gets its own isolated SQLite (Cloudflare D1) database. Migrations live in
`migrations/001_init.sql` (add `002_*.sql`, etc. for later versions) and are applied in
ascending order, skipping versions already applied. Migrations must be additive only
(`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` —
bare `ADD COLUMN` without `IF NOT EXISTS` is correct; the migration runner's version
tracking ensures each migration runs exactly once, so SQL-level idempotency guards are
not needed and SQLite does not support `ADD COLUMN IF NOT EXISTS` anyway).

**Table naming**: every table name — in migrations *and* in app SQL — must be prefixed
with `app_{appId}__` (e.g. app id `streaks` -> `app_streaks__streaks`,
`app_streaks__streak_logs`). The hub's DDL guard rejects any `CREATE TABLE`/`CREATE INDEX`
whose name doesn't start with your app's prefix. IDs are `TEXT` (use
`crypto.randomUUID()` client-side) — there is no `household_id` column; each household's
data already lives in its own database file.

The hub validates and rejects any migration that contains:

- `DROP TABLE` / `DROP COLUMN` / `RENAME COLUMN` / `RENAME TABLE` / `TRUNCATE`
- `CREATE TRIGGER` / `CREATE VIEW` (including the `TEMP` / `TEMPORARY` forms) — trigger and view
  bodies run SQL that the hub cannot scope, so they could read or write other apps' tables and
  bypass per-app table isolation. Do the equivalent work in your app/server code instead.
- `PRAGMA`, `ATTACH DATABASE`, `VACUUM`
- `CREATE TABLE` without `IF NOT EXISTS`
- Any `CREATE`/`DROP`/`ALTER TABLE|INDEX|VIEW|TRIGGER` whose target table name doesn't start with your app's `app_{appId}__` prefix

Row-level access restrictions are **not** expressed in SQL (no `CREATE POLICY`/RLS) —
declare them as `row_policies` in `manifest.json` instead; see "Row-level access control"
below. Anything not declared there is fully readable/writable by any household member
whose session calls `/api/db` — DDL and table layout decide *what* exists, `row_policies`
decides *who* can touch which rows.

### App JavaScript

- Always use `esc()` from `/hub-sdk.js` when injecting any user-provided string into `innerHTML`. Never use raw string interpolation with user data in HTML templates.
- Never construct SQL strings from user input — always use parameterized queries via the `db()` helper with the `params` array.
- The `DB` endpoint only runs queries against your app's own schema. You cannot query other apps' tables or hub tables — this is enforced at the database level.
- Do not attempt to read or write `window.__CONTEXT_URL`, `window.__DB_URL`, or other hub globals from another origin — the iframe sandbox blocks it.

### CDN whitelist

`cdn_whitelist` entries in the manifest must be `https://` origins only (e.g. `"https://cdn.jsdelivr.net"`). No paths, no wildcards, no `http://`. The hub rejects manifests with invalid entries and strips any that bypass validation at CSP-build time.

## Row-level access control (storage: db apps)

By default, `/api/db` runs whatever SQL the app sends against the household's
shared D1 database — **any household member can read or write any row in any
table**, regardless of what the app's UI shows. Client-side checks like
`if (isAdult(ME)) { ... }` are cosmetic only: a child can open devtools and
`fetch` your `DB` endpoint directly with arbitrary SQL.

If your app has data that should be restricted by member, role, or
visibility (private notes, financial accounts, votes, board-only records,
etc.), declare a `row_policies` block in `manifest.json`. The hub rewrites
incoming SQL to add the right `WHERE`/`EXISTS` conditions and forces the
right columns on `INSERT`, **before** your SQL ever reaches the database —
app code cannot bypass it, and a malicious client sending raw SQL gets the
same restrictions.

```json
{
  "storage": "db",
  "row_policies": {
    "<unprefixed_table_name>": { "kind": "...", ... }
  }
}
```

- Keys are **unprefixed** table names (`"streaks"`, not `"app_streaks__streaks"`)
  — the hub adds the `app_{appId}__` prefix automatically.
- Tables with no entry are completely unaffected — opt-in, fully backward compatible.
- Unsupported SQL shapes that reference a governed table (JOINs, aliases,
  subqueries in `FROM`) are **rejected outright** (fail closed) rather than
  silently under-enforced — keep queries against governed tables to simple
  single-table `SELECT`/`INSERT`/`UPDATE`/`DELETE`.
- On a policy violation, `/api/db` returns `403` with `{ "error": "..." }`.

### Policy kinds

#### `endpoint_only` — table written exclusively by a trusted hub endpoint

```json
{ "kind": "endpoint_only" }
{ "kind": "endpoint_only", "read": "adult" }
{ "kind": "endpoint_only", "read": "none" }
```

Rejects **all** app-originated INSERT/UPDATE/DELETE with 403. Use when a table is written only by a trusted manifest-driven hub endpoint (e.g. `anonymous_responses`, `anonymous_ballot`). Trusted hub operations bypass row policies entirely and can still write.

- `read` defaults to `"everyone"` — all members may SELECT
- `read: "adult"` — only adults may SELECT (children get 403)
- `read: "none"` — all reads also blocked; results released only through a trusted endpoint (e.g. secret-ballot tallies, anonymous survey responses before session closure)

Example: `responses` and `ballot` tables written by `anonymous_responses` / `anonymous_ballot` hub endpoints, where `read:"none"` keeps raw answers hidden until the session closes.

#### `adult_writable` — everyone reads, only adults write

```json
{ "kind": "adult_writable" }
```

All members may SELECT. INSERT/UPDATE/DELETE require `memberRole === "adult"` — non-adults get 403. This is the right choice for shared content that adults manage (chore definitions, survey questions, poll configuration, announcements) when you don't need per-row ownership.

Add `"member_read_column": "member_id"` to restrict non-adult reads to only their own rows while adults still see all:

```json
{ "kind": "adult_writable", "member_read_column": "member_id" }
```

Example: `chores` definitions (kids read, only adults create/edit); `piggy_banks` and `transactions` with `member_read_column` (kid reads only their own bank, parents read all).

#### `app_config` — a key/value settings table whose values only an admin may write

```json
{ "kind": "app_config" }
```

Read-all, **write-none via `/api/db`**. The only writer is `POST /run/{app}/api/admin-config`, which requires `isAdmin`. Use this for the settings row that names a privileged group (e.g. `board_group_id`) — if that row used `adult_only` instead, any adult could overwrite the group pointer and grant themselves board access. Pair with manifest `admin_config: { settings_table, keys: ["board_group_id"] }`. Used by `dues-contributions` and `reserve-fund`.

#### `owner_only` — a row belongs to exactly one member

```json
{ "kind": "owner_only", "member_column": "member_id", "adults_bypass": true }
```

- Non-adults: every query is restricted to rows where `member_column = <caller's member id>`; `INSERT` forces `member_column` to the caller.
- Adults: unrestricted by default. Set `"adults_bypass": false` to restrict adults too (e.g. each adult only sees their own rows).
- Add `"bypass_group_setting": { "settings_table": "settings", "settings_key": "board_group_id" }` to give members of a configurable hub group (e.g. "board", "admins") unrestricted access regardless of `adults_bypass`.
- Add `"insert_privileged_only": true` (requires `bypass_group_setting`) to block `INSERT` for everyone except the privileged group — returns 403 for all other callers regardless of adult status. SELECT/UPDATE/DELETE are unaffected.
- Add `"endpoint_writes_only": true` to block all app-originated INSERT/UPDATE/DELETE while keeping owner-based read filtering in place. Use this when a table's data must only be written by a trusted hub endpoint (e.g. vote receipts created by `anonymous_responses`), but reads should still be filtered by ownership and `adults_bypass`:

```json
{
  "kind": "owner_only",
  "member_column": "member_id",
  "adults_bypass": false,
  "member_can_update": false,
  "endpoint_writes_only": true
}
```

Example: piggy-bank `piggy_banks`/`transactions` — a child only sees their own bank/transactions; adults (parents) see everyone's. Vote receipts for attributed polls — each member can see their own receipt (confirming they voted), but all receipt creation goes through the `submit-response` hub endpoint.

#### `owner_only_with_fk_check` — like `owner_only`, but the row references another owned row

```json
{
  "kind": "owner_only_with_fk_check",
  "member_column": "member_id",
  "fk_column": "bank_id",
  "fk_table": "piggy_banks",
  "fk_member_column": "member_id"
}
```

Same as `owner_only`, plus on `INSERT`/`UPDATE` the hub verifies the
referenced `fk_table` row (by `fk_column` -> `fk_table.id`) is owned by the
same member via `fk_table.fk_member_column` — prevents a child from writing
a transaction against another member's bank by guessing its id.

#### `owner_or_visibility` — a row is owned by one member but may be shared

```json
{
  "kind": "owner_or_visibility",
  "member_column": "owner_id",
  "visibility_column": "visibility",
  "everyone_values": ["everyone"],
  "adult_values": ["adults", "everyone"],
  "write_owner_only": false,
  "bypass_group_setting": { "settings_table": "settings", "settings_key": "committee_group_id" },
  "privileged_values": ["private"]
}
```

- `SELECT`: a row is visible if `member_column = <caller>` OR
  `visibility_column` is in `everyone_values` (plus `adult_values` if the
  caller is an adult, plus `privileged_values` if the caller is privileged
  via `bypass_group_setting`).
- `UPDATE`/`DELETE`: privileged callers can always write any row. Adults can
  write any row **unless** `write_owner_only: true`, in which case adults
  (like everyone else) are restricted to `member_column = <caller>`.
- `INSERT`: always forces `member_column` to the caller — you own what you create.
- Add `"insert_privileged_only": true` (requires `bypass_group_setting`) to block `INSERT` for everyone except the privileged group — returns 403 for all other callers regardless of adult status. The column is still forced to the caller for privileged inserts. SELECT/UPDATE/DELETE are unaffected by this flag.

Example: streaks `streaks` (`owner_id`/`visibility` in `private`/`adults`/`everyone`); architectural-review `requests` (`submitted_by`/`visibility` in `public`/`private`, with the committee group privileged to see `private` requests and decide on any request); document-library `documents` (`created_by`/`visibility`, everyone reads, only board group may insert).

#### `adult_only` — entire table restricted to adults

```json
{ "kind": "adult_only" }
```

Every operation throws `403` for non-adult callers; adults are unrestricted.
Use for tables with no per-row ownership at all (e.g. shared account
balances, fund snapshots).

#### `couple_scoped` — visible/writable by a member and their configured partner

```json
{
  "kind": "couple_scoped",
  "self_column": "author_id",
  "participant_columns": ["author_id", "recipient_id"],
  "partner_table": "partner_config",
  "partner_member_column": "member_id",
  "partner_id_column": "partner_id"
}
```

A row is visible/writable if any of `participant_columns` equals the
caller's id or their configured partner's id (looked up from
`partner_table`). `INSERT` forces `self_column` to the caller and rejects
any `participant_columns` value that isn't the caller or their partner.
Assumes exactly one partner per member — not for group/throuple apps.

#### `inherit_visibility` — a child row's access follows its parent row

For tables with no `member_id`/`visibility` of their own (votes, comments,
activity logs, streak check-offs) whose access should mirror a parent row
they reference via foreign key:

```json
{
  "kind": "inherit_visibility",
  "fk_column": "request_id",
  "parent_table": "requests",
  "writer_column": "voter_id"
}
```

- `parent_table` (unprefixed) must itself have an `owner_only`,
  `owner_only_with_fk_check`, or `owner_or_visibility` row policy — its
  visibility/ownership rules (and `bypass_group_setting`/`privileged_values`
  if present) are reused for the child table.
- `SELECT`: a child row is visible iff its parent row (matched via
  `fk_column = parent.id`) is visible to the caller.
- `INSERT`: forces `writer_column` to the caller, and rejects the insert
  (`403`) if the referenced parent row isn't visible to the caller (e.g.
  can't vote/comment/log on something you can't see).
- `UPDATE`/`DELETE`: privileged callers (per the parent policy's
  `bypass_group_setting`/adult-bypass) are unrestricted (e.g. cascade-delete
  when the parent is deleted); everyone else is restricted to rows where
  `writer_column = <caller>`.
- Add `"insert_privileged_only": true` to block `INSERT` for everyone except
  the privileged group inherited from the parent policy's `bypass_group_setting`.
  Returns 403 for all other callers. Useful when only a designated group should
  be able to create child rows (e.g. only the board uploads document versions).

Examples: architectural-review `votes`/`comments` inherit from `requests`;
officer-elections-style "any visible member can check off a group streak"
(streaks `streak_logs` inherits from `streaks`); violation-tracking
`activity` inherits from `violations` (homeowners see/log activity only on
their own violations; board members see/log on any violation); document-library
`document_versions` inherits from `documents` with `insert_privileged_only: true`
(only the board may upload new versions).

### Choosing a policy kind

| Your table looks like... | Use |
|---|---|
| Table written only by a trusted hub endpoint; result access controlled separately | `endpoint_only` with appropriate `read` |
| Shared content adults manage, everyone reads (chores, polls, surveys) | `adult_writable` |
| Same, but non-adults should only read their own rows | `adult_writable` with `member_read_column` |
| Settings row that names a privileged group (board_group_id, committee_group_id) | `app_config` |
| One row per member, only that member (and maybe adults) should see it | `owner_only` |
| Same, but writes must go through a hub endpoint (e.g. vote receipts) | `owner_only` with `endpoint_writes_only: true` |
| Like the above, but the row references another owned row (e.g. a transaction against a bank) | `owner_only_with_fk_check` |
| A row can be private, shared with adults, or shared with everyone | `owner_or_visibility` |
| Table-wide, adults-only data (account balances, fund totals) | `adult_only` |
| Shared between exactly two partnered members | `couple_scoped` |
| Votes/comments/logs/check-offs whose visibility should match a parent record | `inherit_visibility` |
| Anonymous data with no per-row ownership at all (e.g. cast ballots, raw anonymous responses) | `endpoint_only` with `read:"none"` — pair with a receipt table under `owner_only` + `adults_bypass:false` + `member_can_update:false` + `endpoint_writes_only:true`; use `anonymous_responses` or `anonymous_ballot` manifest mechanisms to write both atomically |
| Everyone can read, but only a specific group may INSERT (e.g. board-managed docs) | `owner_or_visibility` with `everyone_values`, `write_owner_only: true`, and `insert_privileged_only: true` |
| Child rows where only a privileged group may create them (e.g. document versions) | `inherit_visibility` with `insert_privileged_only: true` |

### `bypass_group_setting`

```json
"bypass_group_setting": { "settings_table": "settings", "settings_key": "board_group_id" }
```

Grants unrestricted access to members of a hub group whose id is stored in
this app's own `settings_table` under `settings_key`. Requires your app to
have a `settings` table (key/value, like
`app_violation_tracking__settings`) and a settings UI where an admin/adult
picks a hub group (e.g. "Board", "Committee") to designate as privileged.
If the setting is unset, no one gets this bypass — only the
`adults_bypass`/`adult_values` rules apply.

### Verifying your row_policies

`node build.mjs` runs manifest validation, including `row_policies` — it
will catch invalid `kind`, missing required fields, bad identifiers, and
`inherit_visibility.parent_table` not having a compatible parent policy.
This catches schema mistakes before install, but does **not** test the
actual SQL rewriting — when in doubt, check
`packages/hub/__tests__/unit/cloudflare-row-policy.test.ts` in the hub repo
for worked examples per policy kind.

## Anonymous submissions — `anonymous_responses`

For surveys, polls, and any "one submission per session per member" flow where the submitter's identity must optionally be hidden, use the `anonymous_responses` manifest mechanism instead of writing directly to `/api/db`.

**Why you can't do this with row_policies alone:** a client posting directly to `/api/db` can omit or forge its own `member_id`. The server needs to resolve identity and decide whether to store it.

### How it works

Declare `anonymous_responses` in `manifest.json`. The hub exposes `POST /run/{appId}/api/submit-response`, which:

1. Resolves the caller's `member_id` from the session (cannot be spoofed)
2. Checks the session table: rejects if status ≠ `session_open_value`
3. Checks the receipt table for a duplicate → 409 `already_responded` if found
4. Inserts the receipt row first (fail-safe: a partial failure always blocks retry)
5. Inserts one response row per answer, with `member_id` set or omitted based on anonymity

The hub injects `window.__SUBMIT_RESPONSE_URL` for apps that declare this field.

### Config

```json
{
  "anonymous_responses": {
    "receipt_table":              "response_receipts",
    "session_column":             "survey_id",
    "member_column":              "member_id",
    "created_at_column":          "created_at",
    "response_table":             "responses",
    "response_session_column":    "survey_id",
    "response_question_column":   "question_id",
    "response_member_column":     "member_id",
    "response_answer_column":     "answer",
    "response_id_column":         "id",
    "response_created_at_column": "created_at",
    "session_table":              "surveys",
    "session_id_column":          "id",
    "session_status_column":      "status",
    "session_open_value":         "open",
    "session_anonymous_column":   "anonymous"
  }
}
```

- Omit `response_member_column` → always anonymous (member_id never stored in response rows)
- Omit `session_anonymous_column` → same (no per-session toggle)
- Include both → hub reads the session's `anonymous` column at submission time; non-anonymous sessions store `member_id`, anonymous sessions strip it

### Schema requirements

```sql
-- Receipt table: one row per (session, member) — immutable proof of submission
CREATE TABLE IF NOT EXISTS app_myapp__response_receipts (
  survey_id  TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (survey_id, member_id)
);

-- Response table: member_id nullable to support anonymous rows
CREATE TABLE IF NOT EXISTS app_myapp__responses (
  id          TEXT NOT NULL PRIMARY KEY,
  survey_id   TEXT NOT NULL,
  question_id TEXT NOT NULL,
  member_id   TEXT,           -- NULL for anonymous submissions
  answer      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Partial unique index: one response per member per question for non-anonymous;
-- NULL member_id rows are unconstrained (SQLite treats each NULL as distinct)
CREATE UNIQUE INDEX IF NOT EXISTS responses_member_unique
  ON app_myapp__responses (survey_id, question_id, member_id)
  WHERE member_id IS NOT NULL;
```

Receipt table row policy — immutable and invisible to everyone including adults, writes blocked except through the hub endpoint:

```json
"response_receipts": {
  "kind": "owner_only",
  "member_column": "member_id",
  "adults_bypass": false,
  "member_can_update": false,
  "endpoint_writes_only": true
}
```

Response table — use `endpoint_only` so app-originated writes are rejected and reads are controlled:

```json
"responses": { "kind": "endpoint_only", "read": "none" }
```

`read: "none"` keeps raw responses hidden until a trusted hub endpoint releases them (e.g. `/api/response-results` after session closure). Use `read: "everyone"` or `read: "adult"` if attributed responses should be readable directly once the session closes. Never leave the response table without a row policy — without it any member can INSERT, UPDATE, or DELETE response rows via `/api/db`.

### Calling the endpoint

```js
const SUBMIT_RESPONSE = window.__SUBMIT_RESPONSE_URL ?? "";

const res = await fetch(SUBMIT_RESPONSE, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    session_id: survey.id,
    responses: questions.map(q => ({
      question_id: q.id,   // only if response_question_column is declared
      answer: answers[q.id],
    })),
  }),
});
if (res.status === 409) { /* already submitted */ }
```

### Critical: "has responded" queries must use the receipt table

For anonymous submissions, `member_id` is NULL in the response table — `COUNT(DISTINCT member_id)` on it always returns 0. Use the receipt table for all response-count and "have I responded" checks, including list views, widgets, and AI export SQL files:

```sql
-- ✅ Correct — works for both anonymous and non-anonymous sessions
EXISTS(
  SELECT 1 FROM app_myapp__response_receipts rr
  WHERE rr.survey_id = s.id AND rr.member_id = ?
) AS i_responded

-- ❌ Wrong — always 0 for anonymous sessions
EXISTS(
  SELECT 1 FROM app_myapp__responses r
  WHERE r.survey_id = s.id AND r.member_id = ?
) AS i_responded
```

## Multi-party agreements — `agreements`

For any flow where two or more named participants must each consent before a record is "locked" (borrow requests, family contracts, parental agreements, shared commitments), use the `agreements` manifest mechanism instead of storing agreement flags in a `party_scoped` table.

**Why you can't do this with `party_scoped` alone:** `party_scoped` limits *which rows* a member can read/write, but any party can still UPDATE any column — including other parties' agreement flags — directly via `/api/db`. There is no column-level immutability in row policies. The only way to prevent a member from forging their counterpart's consent is to route all writes through a trusted hub endpoint.

### How it works

Declare `agreements` in `manifest.json`. The hub exposes `POST /run/{appId}/api/agree`, which:

1. Resolves the caller's `member_id` from the session (cannot be spoofed)
2. Reads the agreement row; if it doesn't exist and `init_from_table` is configured, bootstraps it by copying `init_columns` from the source table
3. Verifies the caller is a participant (their id must be in one of the `participant_columns`)
4. Sets only the caller's own flag (`agreement_columns[callerId]`) to `agreed` (true) or `0` (false)
5. If all flags are now true, sets `status_column` to `locked_value` and records `locked_at`

### Table layout

Split into two tables — item details in a `party_scoped` table, agreement state in a separate `endpoint_only` table:

```sql
-- Item details: parties can read/edit terms
CREATE TABLE IF NOT EXISTS app_myapp__requests (
  id          TEXT PRIMARY KEY,
  borrower_id TEXT NOT NULL,
  lender_id   TEXT NOT NULL,
  item_name   TEXT NOT NULL,
  -- ... other item-detail columns ...
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'cancelled' | 'returned'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Agreement state: only api/agree may write
CREATE TABLE IF NOT EXISTS app_myapp__request_agreements (
  id              TEXT PRIMARY KEY,  -- same id as requests
  borrower_id     TEXT NOT NULL,     -- copied from requests on init
  lender_id       TEXT NOT NULL,
  borrower_agreed INTEGER NOT NULL DEFAULT 0,
  lender_agreed   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'locked'
  locked_at       TEXT,
  updated_at      TEXT NOT NULL
);
```

### Manifest config

```json
{
  "row_policies": {
    "requests": {
      "kind": "party_scoped",
      "member_columns": ["borrower_id", "lender_id"],
      "self_column": "borrower_id"
    },
    "request_agreements": {
      "kind": "endpoint_only",
      "read": "everyone"
    }
  },
  "agreements": {
    "request_agreements": {
      "participant_columns": ["borrower_id", "lender_id"],
      "agreement_columns": { "borrower_id": "borrower_agreed", "lender_id": "lender_agreed" },
      "status_column": "status",
      "pending_value": "pending",
      "locked_value": "locked",
      "locked_at_column": "locked_at",
      "updated_at_column": "updated_at",
      "init_from_table": "requests",
      "init_columns": ["borrower_id", "lender_id"]
    }
  }
}
```

- `participant_columns` — columns whose values name the valid participants; hub rejects callers not in this set
- `agreement_columns` — maps each participant column name to the boolean flag column that participant controls
- `init_from_table` + `init_columns` — when the agreement row doesn't exist yet, the hub INSERTs it by copying these columns from the named table (same `id`). Required when the agreement table is `endpoint_only` and the client cannot INSERT into it directly.
- `locked_at_column` / `updated_at_column` — optional; hub sets them server-side

### Client flow

```js
// After inserting into the party_scoped table:
await db(`INSERT INTO app_myapp__requests (...) VALUES (...)`, [...]);
// Trigger init_from_table + set caller's own flag:
await fetch(`/run/${APP_ID}/api/agree`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ table: "request_agreements", id, agreed: true }),
});

// When the other party agrees:
await fetch(`/run/${APP_ID}/api/agree`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ table: "request_agreements", id: reqId, agreed: true }),
});
// Hub sets both flags; if both true, sets status='locked', locked_at=now

// When a party edits terms (reset their agreement; other party must re-agree):
await db(`UPDATE app_myapp__requests SET item_name=?, updated_at=? WHERE id=?`, [...]);
await fetch(`/run/${APP_ID}/api/agree`, { ..., body: JSON.stringify({ table: "request_agreements", id: reqId, agreed: false }) });
await fetch(`/run/${APP_ID}/api/agree`, { ..., body: JSON.stringify({ table: "request_agreements", id: reqId, agreed: true }) });
```

### Reading effective status

JOIN the two tables and derive `status` via CASE — the party_scoped table's `status` tracks terminal states (cancelled, returned), while the agreement table tracks the in-progress lock:

```sql
SELECT
  r.*,
  COALESCE(ra.borrower_agreed, 0) AS borrower_agreed,
  COALESCE(ra.lender_agreed, 0)   AS lender_agreed,
  CASE
    WHEN r.status IN ('cancelled', 'returned') THEN r.status
    WHEN ra.status = 'locked'                  THEN 'locked'
    ELSE 'pending'
  END AS status,
  ra.locked_at
FROM app_myapp__requests r
LEFT JOIN app_myapp__request_agreements ra ON ra.id = r.id
WHERE (r.borrower_id = ? OR r.lender_id = ?)
```

Reference implementation: `borrowing` app (`migrations/002_agreement_state.sql`, `manifest.json` `agreements` block, `src/index.html` `loadRequests`/`createRequest`/`updateRequest`/`agreeOnServer`).

## Security pitfalls

### Client gates must mirror server policy

A helper like `canManage(item, me)` that returns `true` for the item's `created_by` regardless of role will show action buttons to non-adult creators. When they click, the `adult_writable` policy blocks the write with a silent 403 — misleading UX. The client gate should match the server policy exactly:

```js
// ❌ Wrong — shows controls to a non-adult creator
function canManage(item, me) {
  return item.created_by === me.id || isAdult(me);
}

// ✅ Correct — mirrors adult_writable policy
function canManage(item, me) {
  return !!me && isAdult(me);
}
```

### `publishes` / `alert_on` require an actual endpoint call

Declaring these fields in `manifest.json` does not cause events to be emitted — your code must call the events endpoint after the action. A manifest with `publishes: ["survey.closed"]` but no `publishEvent` call after the status UPDATE means the integration is silently non-functional.

## Column encryption and `db_plaintext_columns`

The hub encrypts most string columns at rest before writing them to the database. This protects sensitive user content (names, notes, titles) if the underlying storage is ever compromised.

### What is already plaintext (never encrypted)

The hub skips encryption automatically for:

- Columns whose name ends in `_id` — foreign keys and member references
- Columns whose name ends in `_at` — timestamps (`created_at`, `updated_at`, etc.)
- Columns whose name ends in `_by` — actor columns (`created_by`, `done_by`)
- A fixed set of well-known columns: `id`, `household_id`, `completed`, `all_day`, `status`, `type`, `category`, `week`, `emoji`, `icon`, `position`, `sort_order`, `pinned`, `key`, `version`

These columns can be safely used in `WHERE` filters and `ORDER BY` clauses in SQL.

### The problem with encrypted columns

Columns that fall outside the list above are stored as ciphertext. That means:

- `WHERE my_col = ?` will never match — the param is plaintext but the stored value is ciphertext
- `ORDER BY my_col` produces an arbitrary order, not the string order you expect
- `CASE my_col WHEN 'breakfast' THEN 1 ...` never matches any branch

If your app has enum or date columns you need to filter or sort on in SQL, declare them as plaintext.

### `db_plaintext_columns`

Add this field to `manifest.json` to opt specific columns out of encryption for your app:

```json
{
  "storage": "db",
  "db_plaintext_columns": ["slot", "plan_date"]
}
```

Column names are matched case-insensitively. The list is app-scoped — it does not affect other apps that happen to have columns with the same name.

**When to use it:**

- Fixed enum columns used in `WHERE` or `ORDER BY` (e.g. `slot`, `status` if your app's `status` values differ from the global `status` skip)
- Date columns that don't end in `_at` (e.g. `plan_date`, `due_date`, `birth_date`) — these are never sensitive and must be comparable in SQL
- Any column you need to compare against a literal value in SQL

**When not to use it:**

- Free-text fields entered by the user (names, notes, titles, messages) — these should remain encrypted
- Columns that are only ever read back whole and displayed, never filtered or sorted

**Backward compatibility:** Rows inserted before a column was added to `db_plaintext_columns` have their value stored encrypted. The hub decrypts them correctly on read (it checks each value before decrypting), so old and new rows coexist safely. SQL-level filters and ordering will only work for rows inserted after the column was declared plaintext.

## AI access (MCP)

Apps are **invisible to AI clients by default**. Opt in explicitly — this is intentional: private apps (couples apps, therapy notes, etc.) should never appear in AI tool listings.

Add `ai_access` to your manifest to enable MCP access:

```json
{
  "ai_access": {
    "allowed": true,
    "mode": "read"
  }
}
```

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `allowed` | boolean | `false` | Master switch. Must be `true` for any MCP access. |
| `mode` | `"read"` \| `"read_write"` | `"read"` | `"read"` allows `get_app_data` only. `"read_write"` also allows `set_app_data`. |
| `db_exports` | `string[]` | `[]` | Named SELECT queries exposed via `query_app_db`. DB-storage apps only. |
| `db_mutations` | `string[]` | `[]` | Named UPDATE mutations exposed via `mutate_app_db`. UPDATE-only, no INSERT or DELETE. DB-storage apps only. |
| `db_inserts` | `string[]` | `[]` | Named INSERT operations exposed via `insert_app_db`. Each requires a JSON Schema file for param validation. DB-storage apps only. |
| `requires_admin_approval` | boolean | `false` | If true, the hub admin must explicitly grant AI access after install. |

### KV apps — reading and writing via MCP

With `allowed: true` and `mode: "read"`, an AI client can read any key from your app's KV store via the `get_app_data` tool. With `mode: "read_write"`, it can also write via `set_app_data`.

```json
{
  "ai_access": {
    "allowed": true,
    "mode": "read_write"
  }
}
```

KV access goes through the normal MCP tool layer — no additional app-side work needed.

### DB apps — named query exports

DB-storage apps cannot be queried with raw SQL via MCP. Instead, declare named SELECT queries in `ai_access.db_exports` and put the SQL files in `src/queries/`:

```json
{
  "storage": "db",
  "ai_access": {
    "allowed": true,
    "mode": "read",
    "db_exports": ["open_tasks", "overdue_tasks", "task_summary"]
  }
}
```

Each name maps to `src/queries/{name}.sql`. The build script includes everything under `src/` in the bundle, so these files are automatically packaged and served.

**Query file conventions:**

- Files must be `SELECT` or `WITH ... SELECT` statements — the hub rejects anything else
- Always filter by `household_id` explicitly — do not rely on default values alone:
  ```sql
  WHERE household_id = current_setting('app.household_id', true)::uuid
  ```
- Include `LIMIT` to bound result size
- The query runs under the `hub_app_executor` Postgres role with `search_path` set to your app's schema — unqualified table names resolve to your schema, not hub tables
- No parameterized inputs — named queries are fixed SELECT statements with no user-supplied values

Example (`src/queries/open_tasks.sql`):

```sql
SELECT
  t.id,
  t.title,
  t.assignee_id,
  t.due_date,
  t.priority,
  l.name AS list_name
FROM tasks t
LEFT JOIN lists l
  ON l.id = t.list_id
  AND l.household_id = t.household_id
WHERE t.household_id = current_setting('app.household_id', true)::uuid
  AND t.completed = 0
ORDER BY t.due_date NULLS LAST, t.priority DESC
LIMIT 200
```

### DB apps — named INSERT operations

AI INSERT access requires an additional validation layer because the AI client supplies the data values. Each named insert has two bundle files:

**`src/inserts/{name}.sql`** — the INSERT SQL. User-supplied params use `$1`, `$2`, etc. System values are generated by SQL built-ins — never rely on the AI client to supply IDs, household_id, or timestamps:

```sql
INSERT INTO items (
  id, household_id, name, name_normalized, added_by_name, created_at
) VALUES (
  gen_random_uuid()::text,
  current_setting('app.household_id', true)::uuid,
  $1,
  lower(trim($1)),
  'AI',
  NOW()::text
)
ON CONFLICT (household_id, name_normalized) DO NOTHING
```

**`src/schemas/{name}.json`** — JSON Schema (draft-07) describing the user-supplied params array. The hub validates params against this schema before executing the SQL:

```json
{
  "type": "array",
  "items": [
    { "type": "string", "minLength": 1, "maxLength": 200, "description": "item name" }
  ],
  "minItems": 1,
  "maxItems": 1
}
```

Declare in the manifest:
```json
"ai_access": {
  "allowed": true,
  "mode": "read_write",
  "db_inserts": ["add_item"]
}
```

**Migration constraints are your second validation layer.** JS validation in the app front-end enforces business rules at runtime, but AI inserts bypass the front-end. Move those constraints into the DB so both paths enforce them:

```sql
-- In a migration: add constraints that the front-end currently enforces in JS
ALTER TABLE items ADD CONSTRAINT items_name_len CHECK (length(name) > 0) IF NOT EXISTS;
ALTER TABLE tasks ADD CONSTRAINT tasks_priority_check CHECK (priority BETWEEN 0 AND 3) IF NOT EXISTS;
ALTER TABLE tasks ADD CONSTRAINT tasks_list_fk FOREIGN KEY (list_id) REFERENCES lists(id) IF NOT EXISTS;
```

**SQL file rules (enforced by hub at runtime and tested by CI):**
- Must start with `INSERT`
- Must contain `household_id` (set via `current_setting()`, never from params)
- User params are positional (`$1`, `$2` — max 50)
- System values always come from SQL built-ins: `gen_random_uuid()`, `current_setting()`, `NOW()`
- Include `ON CONFLICT DO NOTHING` or `DO UPDATE` where duplicates are possible

**Schema file rules:**
- Must be valid JSON Schema (draft-07)
- Use `items` (array form) for tuple/positional validation, not `prefixItems`
- Declare `minItems` and `maxItems` to match the SQL param count
- Add format constraints (`pattern`, `minLength`, `maxLength`, `minimum`, `maximum`) to catch bad input before it reaches the DB

### Privacy and admin overrides

- Apps with no `ai_access` field (or `allowed: false`) are completely invisible to MCP clients — they do not appear in `list_apps` results and their data cannot be accessed
- A hub admin can set `disabled: true` via `PATCH /api/apps/{id}/ai-access` to block MCP access for any app regardless of its manifest
- Admins cannot *enable* AI access for an app that declared `allowed: false` — only the manifest can grant it
- Consider whether your app contains sensitive content before enabling `ai_access`. Couples apps, therapy journals, and similar private apps should leave `allowed: false`
