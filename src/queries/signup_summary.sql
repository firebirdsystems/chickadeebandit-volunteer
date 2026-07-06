SELECT
  c.member_id,
  COUNT(*) AS slot_count
FROM app_volunteer__slot_claims c
JOIN app_volunteer__slots sl
  ON sl.id = c.slot_id
GROUP BY c.member_id
ORDER BY slot_count DESC
LIMIT 100
