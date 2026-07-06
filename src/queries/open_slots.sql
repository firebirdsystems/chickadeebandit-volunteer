SELECT
  sl.id,
  sl.sheet_id,
  sl.title,
  sl.details,
  sl.capacity,
  sl.starts_at,
  sl.status,
  sh.title AS sheet_title,
  sh.event_date,
  COUNT(c.id) AS claimed_count
FROM app_volunteer__slots sl
JOIN app_volunteer__sheets sh
  ON sh.id = sl.sheet_id AND sh.archived = 0
LEFT JOIN app_volunteer__slot_claims c
  ON c.slot_id = sl.id
WHERE sl.status = 'open'
GROUP BY sl.id, sl.sheet_id, sl.title, sl.details, sl.capacity, sl.starts_at, sl.status, sh.title, sh.event_date
HAVING COUNT(c.id) < sl.capacity
ORDER BY sh.event_date ASC, sl.sort_order ASC
LIMIT 200
