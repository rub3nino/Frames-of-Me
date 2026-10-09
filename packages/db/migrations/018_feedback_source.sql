-- v6 (integration): `gallery_feedback` was carrying two different meanings in one column.
--
-- The table is the ground truth the recognition thresholds are tuned from: a `not_me` row
-- means "the matcher put a photo in my gallery and it is not me", i.e. a false positive. The
-- precision/recall numbers computed after the event come straight out of
-- `GET /v1/admin/export/feedback.csv`.
--
-- v6 E (tagging) then reused the same row for tag removal, deliberately: the participant
-- learns ONE gesture, "non sono io", and it works the same way on a match and on a tag. That
-- is right for the participant and stays. But a tag is a human assertion, not a matcher
-- output, so a `not_me` that retracts a tag is NOT a false positive of the recognition
-- system. Mixed into the same column, those rows quietly inflate the measured false-positive
-- rate and the thresholds get tuned against polluted data.
--
-- So: one column recording WHICH FLOW wrote the row.
--
--   'recognition'  the matcher put this photo in the person's personal match gallery and
--                  they ruled on it — `verdict = 'me'` confirms the match, `verdict =
--                  'not_me'` is a FALSE POSITIVE of face recognition. These are the only
--                  rows that belong in a precision/recall calculation.
--                  Written by POST /v1/events/:slug/gallery/feedback (the gallery's "Non
--                  sono io" / "Sono io" buttons) and by the crowd report button when the
--                  reported photo is in the reporter's own gallery (`hideForReporter`,
--                  routes.crowd.ts), which is the same judgement reached by another door.
--
--   'tag'          a human tagged this person in this photo and the person refused the tag.
--                  `verdict` is always 'not_me'. It says nothing about the matcher and must
--                  be EXCLUDED when measuring recognition quality. Written by
--                  DELETE /v1/events/:slug/tags/:photoId.
--
-- The default is 'recognition' on purpose: every row that exists today was written by the
-- gallery feedback route, so defaulting preserves their meaning exactly and no backfill is
-- needed or wanted.
--
-- Additive only. `galleries` and `gallery_items` (the personal match galleries) are not read
-- or written here, and nothing about existing `gallery_feedback` rows changes.

alter table gallery_feedback
  add column if not exists source text not null default 'recognition';

-- Added separately and guarded, so re-running this file on a database that already has the
-- column cannot fail on a duplicate constraint name.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'gallery_feedback_source_check'
  ) then
    alter table gallery_feedback
      add constraint gallery_feedback_source_check check (source in ('recognition', 'tag'));
  end if;
end $$;

-- The export reads per event ordered by email/created_at; tuning reads 'recognition' only.
create index if not exists gallery_feedback_source_idx
  on gallery_feedback (event_id, source, created_at desc);
