-- v4 report S4: concurrent consent POSTs each inserted a fresh row, so 8 parallel
-- requests produced 8 active consent rows for the same (user, event). Collapse any
-- existing duplicate *active* consents down to the earliest row per (user, event),
-- then enforce a single active consent per (user, event) with a partial unique index.
--
-- Withdrawn rows are left untouched: the withdrawal history stays intact, and a
-- participant can re-consent after a withdrawal (that inserts a new active row,
-- which is allowed because the previous one has withdrawn_at set).

delete from consents c
using consents keep
where c.user_id = keep.user_id
  and c.event_id = keep.event_id
  and c.withdrawn_at is null
  and keep.withdrawn_at is null
  and (keep.granted_at, keep.id) < (c.granted_at, c.id);

create unique index if not exists consents_active_unique
  on consents (user_id, event_id)
  where withdrawn_at is null;
