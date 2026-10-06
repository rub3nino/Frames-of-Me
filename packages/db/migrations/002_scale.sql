-- claimed_at marks when a worker took a running job.
-- A stale running row returns to queued; it is not failed for age alone.

alter table jobs add column claimed_at timestamptz null;

create index faces_event_external_idx on faces (event_id, external_id);

create index jobs_match_user_event_idx
  on jobs ((payload->>'userId'), (payload->>'eventId'), created_at desc)
  where type = 'match';
