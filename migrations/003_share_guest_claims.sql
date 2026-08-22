-- Share-link sign-ups. A sheet could only ever be filled by household members,
-- so the one thing a sign-up sheet exists to do — ask people outside the house
-- to cover a slot — had no path at all. `shareable.sheet.submit` opens that
-- path, and these are the rows it writes.
--
-- Deliberately a SEPARATE table from `slot_claims`, not more rows in it:
-- `slot_claims` is owned by the hub's claim/release/swap endpoints, which
-- require a member id and enforce one-claim-per-member. An anonymous visitor
-- has neither. Keeping the ledgers apart is also what lets `member_references`
-- delete a departing member's claims without touching a guest's.
--
-- No foreign keys, matching potluck's guest_signups: these rows are authored
-- outside the app by the hub's external write path, and the parent linkage is
-- already guaranteed there (sheet_id IS the share link's item id, and slot_id
-- is admitted only by an EXISTS against `slots` inside the INSERT's own WHERE).
CREATE TABLE IF NOT EXISTS app_volunteer__guest_claims (
  id         TEXT NOT NULL PRIMARY KEY,
  sheet_id   TEXT NOT NULL,
  slot_id    TEXT NOT NULL DEFAULT '',
  guest_name TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS app_volunteer__guest_claims_sheet_idx
  ON app_volunteer__guest_claims(sheet_id);
CREATE INDEX IF NOT EXISTS app_volunteer__guest_claims_slot_idx
  ON app_volunteer__guest_claims(slot_id);

-- The guest allowance the public form is bounded by. A SECOND cell, not
-- `slots.capacity`: the hub computes an option's occupancy as a COUNT over the
-- SUBMIT table alone, so pointing `capacity_column` at `capacity` would let a
-- capacity-2 slot take two member claims AND two guest claims. Two columns keep
-- the two ledgers honest and let an organizer close a slot to the public
-- (guest_capacity = 0) while members keep claiming it.
ALTER TABLE app_volunteer__slots ADD COLUMN guest_capacity INTEGER NOT NULL DEFAULT 0;

-- Existing slots mirror their member allowance, so a sheet created before this
-- migration is as open to link guests as it is to members until an organizer
-- retunes it. Column-to-column between two plaintext INTEGER columns — the only
-- kind of backfill that is safe here, because a migration runs OUTSIDE the
-- app-DB codec and any literal it wrote would land unencrypted.
UPDATE app_volunteer__slots SET guest_capacity = capacity;
