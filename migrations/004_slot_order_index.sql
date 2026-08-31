-- The slots preload runs on every app launch and orders by sort_order, id. The
-- statement has no WHERE and no LIMIT, so the scan itself is correct — it wants
-- every slot — but without an index the rows were sorted in a temp b-tree each
-- time. This index returns them already ordered.
--
-- The ordering used to end in `title ASC`, which was worse than redundant:
-- `title` is encrypted at rest, so that term sorted AES ciphertext. It was
-- harmless only because sheetSlots() in src/index.html re-sorts by title after
-- the hub decrypts, which is where the alphabetical comparison belongs. `id` is
-- the plaintext tiebreak that replaced it.
CREATE INDEX IF NOT EXISTS app_volunteer__slots_order_idx
  ON app_volunteer__slots (sort_order, id);
