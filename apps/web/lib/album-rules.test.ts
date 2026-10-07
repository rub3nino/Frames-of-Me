/*
 * v6 D (agent D): the two frozen album rules as the admin form renders them.
 * Run: node --import tsx --test apps/web/lib/album-rules.test.ts
 *
 * These are the acceptance tests of the album form: decision 2 (a crowd album never gets
 * face recognition) and decision 3 (the recognition flag is immutable once the album has
 * its first upload). The database is the authority for both — the `crowd_never_recognizes`
 * check and the `recognition` trigger of migration 009 — and `apps/api/test/v6-admin.test.ts`
 * proves the api refuses them. What is proven here is the other half of the requirement:
 * that the form makes them VISIBLE, with a reason, and never sends a value that would be
 * refused.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createBody,
  emptyDraft,
  patchBody,
  RECOGNITION_CROWD_REASON,
  RECOGNITION_LOCKED_REASON,
  recognitionField,
  withKind,
  type AlbumDraft,
  type AlbumSnapshot,
} from "./album-rules";

const officialAlbum: AlbumSnapshot = {
  name: "Album ufficiale",
  kind: "official" as const,
  recognition: true,
  moderation: "off" as const,
  visibility: "participants" as const,
  maxPhotosPerUser: null,
  uploadsOpen: true,
  retentionDays: null,
  firstUploadAt: null,
};

function draftOf(album: AlbumSnapshot, overrides: Partial<AlbumDraft> = {}): AlbumDraft {
  return {
    slug: "ufficiale",
    name: album.name,
    kind: album.kind,
    recognition: album.recognition,
    moderation: album.moderation,
    visibility: album.visibility,
    maxPhotosPerUser: album.maxPhotosPerUser,
    uploadsOpen: album.uploadsOpen,
    retentionDays: album.retentionDays,
    ...overrides,
  };
}

test("rule 2: a crowd album disables the recognition switch, greyed and explained", () => {
  const field = recognitionField({ kind: "crowd", recognition: false, firstUploadAt: null });
  assert.equal(field.disabled, true);
  assert.equal(field.value, false);
  assert.equal(field.lock, "crowd");
  assert.equal(field.reason, RECOGNITION_CROWD_REASON);
});

test("rule 2: a recognition value typed before switching to crowd is forced back to false", () => {
  // The switch was on while the album was official; choosing `crowd` drops it there and
  // then, so the form shows what the database would accept and nothing else.
  const live = recognitionField({ kind: "official", recognition: true, firstUploadAt: null });
  assert.equal(live.disabled, false);
  assert.equal(live.value, true);

  const switched = withKind(draftOf(officialAlbum, { recognition: true }), "crowd");
  assert.equal(switched.recognition, false);

  const forced = recognitionField({ kind: "crowd", recognition: true, firstUploadAt: null });
  assert.equal(forced.value, false, "a crowd album never reports recognition on");

  const body = createBody({ ...emptyDraft(), kind: "crowd", recognition: true });
  assert.equal(body.recognition, false, "the create body can never carry crowd + recognition");
});

test("rule 3: after the first upload the switch is read-only, with the reason shown", () => {
  const field = recognitionField({
    kind: "official",
    recognition: true,
    firstUploadAt: "2026-10-07T09:00:00.000Z",
  });
  assert.equal(field.disabled, true);
  assert.equal(field.value, true, "it keeps showing the stored value, it does not reset it");
  assert.equal(field.lock, "first-upload");
  assert.equal(field.reason, RECOGNITION_LOCKED_REASON);
});

test("rule 3: the switch is live while the album has no upload yet", () => {
  const field = recognitionField({ kind: "official", recognition: false, firstUploadAt: null });
  assert.equal(field.disabled, false);
  assert.equal(field.lock, null);
  assert.equal(field.reason, null);
});

test("rule 3: the patch never carries recognition once the album is locked", () => {
  const album: AlbumSnapshot = { ...officialAlbum, firstUploadAt: "2026-10-07T09:00:00.000Z" };
  // Even if something flipped the draft (a stale state, a crafted request from the page),
  // the body the form sends leaves `recognition` out: the api would refuse it with
  // AlbumRecognitionLockedError and the person would see an error instead of an explanation.
  const body = patchBody(draftOf(album, { recognition: false, name: "Nuovo nome" }), album);
  assert.equal("recognition" in body, false);
  assert.equal(body.name, "Nuovo nome");
});

test("rule 3: before the first upload the patch does carry a changed recognition", () => {
  const body = patchBody(draftOf(officialAlbum, { recognition: false }), officialAlbum);
  assert.equal(body.recognition, false);
});

test("the patch carries only what changed", () => {
  const body = patchBody(draftOf(officialAlbum), officialAlbum);
  assert.deepEqual(body, {});

  const changed = patchBody(
    draftOf(officialAlbum, { uploadsOpen: false, maxPhotosPerUser: 20 }),
    officialAlbum,
  );
  assert.deepEqual(changed, { uploadsOpen: false, maxPhotosPerUser: 20 });
});

test("a crowd album's patch never carries recognition either", () => {
  const crowd: AlbumSnapshot = {
    ...officialAlbum,
    kind: "crowd",
    recognition: false,
    name: "Album di tutti",
  };
  const body = patchBody(draftOf(crowd, { recognition: true }), crowd);
  assert.equal("recognition" in body, false);
});
