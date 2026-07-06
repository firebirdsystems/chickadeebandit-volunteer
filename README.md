# Volunteer Sign-Up

SignUpGenius-style slot sheets for Chickadee Bandit households, organizations, and
HOAs. Adults create a sheet (a potluck, classroom-helper day, carpool coverage, or a
shift backfill) with capacity-limited slots. Members **claim**, **swap**, and
**release** slots without ever overbooking a slot.

Capacity is enforced atomically by the hub's **`slot_claims`** protocol — the
`app_volunteer__slot_claims` table is `endpoint_only`, so a browser cannot race the
capacity check by POSTing raw SQL to `/api/db`.

---

## Data model

| Table | Policy | Notes |
|---|---|---|
| `sheets` | `adult_writable` | Everyone reads, only adults create/edit/archive. |
| `slots` | `adult_writable` | Everyone reads, only adults create/edit. `capacity`, `status`. |
| `slot_claims` | `endpoint_only` | Written only by the hub claim/release/swap endpoints. |

## Claim flow

- **Claim** → `POST window.__CLAIM_URL { slot_id, note }` — inserts iff the slot is
  `open`, capacity remains, and the caller has not already claimed it. `409` reasons:
  `slot_full`, `slot_closed`, `already_claimed`.
- **Release** → `POST window.__RELEASE_URL { slot_id }` — removes only the caller's claim.
- **Swap** → `POST window.__SWAP_URL { from_slot_id, to_slot_id }` — claims the
  destination first, then releases the source; if the destination is full/closed the
  original claim is untouched.

## Quick start

```bash
npm run dev     # preview at http://localhost:3001
npm run build   # produce dist/bundle.json
npm test        # run manifest + logic tests
```
