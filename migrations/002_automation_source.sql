-- Automations open a sign-up sheet when another app's event calls for helpers
-- (manifest.automation_actions.create_sheet).
--
-- `source_event_id` records which app event produced the sheet. The
-- dispatcher's dedupe guard reads it before running the action (SELECT 1 ...
-- WHERE source_event_id = ? LIMIT 1), so one event never opens two sheets — not
-- on a retry, and not from two rules watching the same trigger. The action also
-- looks the new sheet back up by this column to attach its first slot.
--
-- Nullable on purpose: sheets an adult creates in the app leave it NULL.
ALTER TABLE app_volunteer__sheets ADD COLUMN source_event_id TEXT;

CREATE INDEX IF NOT EXISTS app_volunteer__sheets_source_event_idx
  ON app_volunteer__sheets (source_event_id);
