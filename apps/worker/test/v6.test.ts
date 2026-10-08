/**
 * v6 A (agent A): what the worker does with albums.
 *
 * - `index` computes and stores no vector at all for an album with recognition = false
 *   (decision 2, second half: the database `check` is the first half).
 * - `index` tells the engine which album the photo belongs to, so every vector carries it.
 * - `attach` only ever searches inside the photo's own album.
 * - `match` searches the recognising albums of the event and nothing else.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createQueue, type JobQueue } from "@rephoto/api/queue";
import { objectKeys } from "@rephoto/contracts";
import { MemoryDatabase } from "@rephoto/db";
import { FakeFaceEngine, MemoryFaceIndexStore } from "../../../packages/face-engine/src/fake.ts";
import type {
  FaceEngine,
  IndexPhotoInput,
  SearchByVectorInput,
  SearchFacesInput,
  SearchInput,
} from "../../../packages/face-engine/src/types.ts";
import type { WorkerDeps } from "../src/handlers.js";
import { MemoryObjectStore, RecordingMailer, drain, env, quiet, solidPng, storePhoto } from "./helpers.ts";

type Recorder = FaceEngine & {
  indexed: IndexPhotoInput[];
  faceSearches: SearchFacesInput[];
  vectorSearches: SearchByVectorInput[];
  searches: SearchInput[];
};

/** The fake engine with every album-carrying input recorded. */
function recordingEngine(): Recorder {
  const inner = new FakeFaceEngine(new MemoryFaceIndexStore());
  const indexed: IndexPhotoInput[] = [];
  const faceSearches: SearchFacesInput[] = [];
  const vectorSearches: SearchByVectorInput[] = [];
  const searches: SearchInput[] = [];
  return {
    indexed,
    faceSearches,
    vectorSearches,
    searches,
    indexPhoto(input) {
      indexed.push(input);
      return inner.indexPhoto(input);
    },
    search(input) {
      searches.push(input);
      return inner.search(input);
    },
    searchFaces(input) {
      faceSearches.push(input);
      return inner.searchFaces(input);
    },
    embedSelfie(input) {
      return inner.embedSelfie(input);
    },
    searchByVector(input) {
      vectorSearches.push(input);
      return inner.searchByVector(input);
    },
    faceEmbedding(input) {
      return inner.faceEmbedding(input);
    },
    deleteFaces(eventId, ids) {
      return inner.deleteFaces(eventId, ids);
    },
    deleteCollection(eventId) {
      return inner.deleteCollection(eventId);
    },
  };
}

type Fixture = {
  db: MemoryDatabase;
  eventId: string;
  photographerId: string;
  participantId: string;
  officialAlbumId: string;
  crowdAlbumId: string;
  objects: MemoryObjectStore;
  faces: Recorder;
  queue: JobQueue;
  deps: WorkerDeps;
};

async function fixture(): Promise<Fixture> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const official = await db.findDefaultAlbum(event.id);
  assert.ok(official, "the event has its official album");
  const crowd = await db.createAlbum({
    eventId: event.id,
    slug: "tutti",
    name: "Album di tutti",
    kind: "crowd",
  });
  const photographer = await db.createUser({ email: "shooter@example.com", role: "photographer" });
  const participant = await db.createUser({ email: "guest@example.com", role: "participant" });
  const objects = new MemoryObjectStore();
  const faces = recordingEngine();
  const queue = createQueue(db);
  const deps: WorkerDeps = {
    env,
    db,
    objects,
    mailer: new RecordingMailer(),
    queue,
    faces,
    log: quiet,
  };
  return {
    db,
    eventId: event.id,
    photographerId: photographer.id,
    participantId: participant.id,
    officialAlbumId: official.id,
    crowdAlbumId: crowd.id,
    objects,
    faces,
    queue,
    deps,
  };
}

let size = 16;

/** Uploads a photo into an album and runs the whole pipeline. */
async function ingest(f: Fixture, albumId: string, rgb: [number, number, number]): Promise<string> {
  size += 8;
  const bytes = new Uint8Array(await solidPng(...rgb, size));
  const photoId = await storePhoto(f.deps, {
    eventId: f.eventId,
    photographerId: f.photographerId,
    bytes,
    albumId,
  });
  await f.queue.enqueue("derive", { photoId });
  await drain(f.deps);
  return photoId;
}

test("index stores no vector for an album without recognition", async () => {
  const f = await fixture();
  const photoId = await ingest(f, f.crowdAlbumId, [10, 200, 30]);
  // No engine call at all: no bytes left for embedding, so no vector could be computed.
  assert.deepEqual(f.faces.indexed, []);
  assert.deepEqual(await f.db.listExternalIds(photoId), []);
  assert.deepEqual(await f.db.findFaceRowsByPhoto(photoId), []);
  // The photo still finished its pipeline, so it is served and counted like any other.
  // `status` is the pipeline state machine; `moderation_state` is a separate one and
  // neither says anything about the other.
  assert.equal((await f.db.findPhoto(photoId))?.status, "indexed");
  // Ported from main's `d477c3a`: skipping recognition must not skip the derivatives.
  // Without both of them the album feed drops the photo (it selects on thumb + web),
  // so "no vector" silently becoming "no thumb" would make the upload disappear.
  assert.deepEqual(
    (await f.db.listDerivatives(photoId)).map((row) => row.kind).sort(),
    ["thumb", "web"],
  );
  assert.ok(await f.objects.get(objectKeys.thumb(photoId)), "thumb bytes stored");
  assert.ok(await f.objects.get(objectKeys.web(photoId)), "web bytes stored");
  // And nothing was attached to any gallery either.
  assert.deepEqual(f.faces.faceSearches, []);
});

test("index embeds a photo of a recognising album and tells the engine its album", async () => {
  const f = await fixture();
  const photoId = await ingest(f, f.officialAlbumId, [200, 10, 30]);
  assert.equal(f.faces.indexed.length, 1);
  assert.equal(f.faces.indexed[0]?.photoId, photoId);
  assert.equal(f.faces.indexed[0]?.albumId, f.officialAlbumId);
  assert.equal((await f.db.listExternalIds(photoId)).length, 1);
  assert.equal((await f.db.findPhoto(photoId))?.status, "indexed");
});

test("attach searches inside the photo's own album only", async () => {
  const f = await fixture();
  // A gallery with an anchor, so `attach` does its searches at all.
  const first = await ingest(f, f.officialAlbumId, [200, 10, 30]);
  const face = (await f.db.findFaceRowsByPhoto(first))[0];
  assert.ok(face);
  await f.db.replaceGallery(
    f.participantId,
    f.eventId,
    [{ photoId: first, faceId: face.id, score: 0.9 }],
    [face.externalId],
  );
  f.faces.faceSearches.length = 0;
  const second = await ingest(f, f.officialAlbumId, [200, 10, 30]);
  assert.ok(f.faces.faceSearches.length > 0, "attach searched");
  for (const search of f.faces.faceSearches) {
    assert.deepEqual(search.albumIds, [f.officialAlbumId]);
  }
  // The crowd photo is never searched: it has no face row to search with.
  f.faces.faceSearches.length = 0;
  await ingest(f, f.crowdAlbumId, [200, 10, 30]);
  assert.deepEqual(f.faces.faceSearches, []);
  assert.ok(second);
});

test("match searches the recognising albums of the event and nothing else", async () => {
  const f = await fixture();
  await ingest(f, f.officialAlbumId, [200, 10, 30]);
  await ingest(f, f.crowdAlbumId, [200, 10, 30]);
  const selfieKey = objectKeys.selfie(f.eventId, f.participantId, randomUUID());
  await f.objects.put(selfieKey, new Uint8Array(await solidPng(200, 10, 30)), "image/png");
  await f.queue.enqueue("match", { userId: f.participantId, eventId: f.eventId, selfieKey });
  await drain(f.deps);
  const albumIds = [...f.faces.vectorSearches, ...f.faces.searches].map((input) => input.albumIds);
  assert.ok(albumIds.length > 0, "match searched");
  for (const ids of albumIds) {
    assert.deepEqual(ids, [f.officialAlbumId], "the crowd album is never searched");
  }
});
