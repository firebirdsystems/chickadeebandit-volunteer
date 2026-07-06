-- Sign-up sheets — an event or effort that needs volunteers (potluck, classroom
-- helpers, carpool coverage, shift backfills). Everyone reads; only adults create.
CREATE TABLE IF NOT EXISTS app_volunteer__sheets (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  location        TEXT NOT NULL DEFAULT '',
  event_date      TEXT NOT NULL DEFAULT '',
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  archived        INTEGER NOT NULL DEFAULT 0
);

-- Individual slots on a sheet — a task with a capacity, claimable up to capacity.
CREATE TABLE IF NOT EXISTS app_volunteer__slots (
  id          TEXT PRIMARY KEY,
  sheet_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  capacity    INTEGER NOT NULL DEFAULT 1 CHECK (capacity > 0),
  starts_at   TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (sheet_id) REFERENCES app_volunteer__sheets(id) ON DELETE CASCADE
);

-- Who holds each slot — written ONLY by the hub's slot-claims endpoints
-- (claim / release / swap), which atomically enforce capacity. Direct app SQL
-- against this table is rejected by the endpoint_only row policy.
CREATE TABLE IF NOT EXISTS app_volunteer__slot_claims (
  id         TEXT PRIMARY KEY,
  slot_id    TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (slot_id) REFERENCES app_volunteer__slots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS app_volunteer__sheets_date_idx
  ON app_volunteer__sheets(archived, event_date);
CREATE INDEX IF NOT EXISTS app_volunteer__slots_sheet_idx
  ON app_volunteer__slots(sheet_id, sort_order);
CREATE INDEX IF NOT EXISTS app_volunteer__slot_claims_slot_idx
  ON app_volunteer__slot_claims(slot_id);
CREATE INDEX IF NOT EXISTS app_volunteer__slot_claims_member_idx
  ON app_volunteer__slot_claims(member_id, slot_id);
