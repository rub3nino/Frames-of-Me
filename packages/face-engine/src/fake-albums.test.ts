/**
 * v6 hardening H4 (agent H): the fake engine honours `albumIds`.
 *
 * It did not. Every search path took the argument and dropped it, so the whole album-
 * isolation suite that runs on the fake (`apps/worker/test/v6.test.ts`,
 * `apps/api/test/*`) proved one thing only: that the worker *passes* the right album ids.
 * Whether passing them isolated anything was never exercised — a regression inside an
 * engine would have been invisible, and "a crowd album is never biometric" is a frozen
 * product rule with legal weight, not a default.
 *
 * The fake now filters exactly like the real paths (migration 011 for `face_vectors`,
 * migration 016 for the fake's own `face_index`): undefined = the whole event (v5
 * behaviour), a list = those albums only, an empty list = nothing, and a stored face whose
 * album is unknown is never returned by a filtered search.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeFaceEngine, MemoryFaceIndexStore, fakeEmbedding } from "./fake.ts";
import type { SearchHit } from "./types.ts";

const EVENT = "11111111-1111-4111-8111-111111111111";
const OTHER_EVENT = "99999999-9999-4999-8999-999999999999";
const OFFICIAL = "22222222-2222-4222-8222-222222222222";
const CROWD = "33333333-3333-4333-8333-333333333333";
const SECOND_OFFICIAL = "44444444-4444-4444-8444-444444444444";

/**
 * A solid PNG of one colour. The fake's embedding is the colour key, so two images of the
 * same colour are "the same person" — the strongest possible case for the filter: without
 * it every photo below matches every other.
 */
async function solidPng(r: number, g: number, b: number, size = 8): Promise<Uint8Array> {
  const { deflateSync } = await import("node:zlib");
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const payload = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(payload));
    return Buffer.concat([length, payload, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const RED: [number, number, number] = [200, 10, 30];

type Fixture = {
  engine: FakeFaceEngine;
  /** One photo per album, all the same colour: only the album can tell them apart. */
  official: string;
  crowd: string;
  secondOfficial: string;
  /** Indexed with no album at all (a row from before migration 016). */
  albumless: string;
  bytes: Uint8Array;
};

async function fixture(): Promise<Fixture> {
  const engine = new FakeFaceEngine(new MemoryFaceIndexStore());
  const bytes = await solidPng(...RED);
  const index = async (photoId: string, albumId?: string): Promise<void> => {
    const faces = await engine.indexPhoto({
      eventId: EVENT,
      photoId,
      imageBytes: bytes,
      contentType: "image/png",
      ...(albumId ? { albumId } : {}),
    });
    assert.equal(faces.length, 1, "the fake indexes one full-frame face");
  };
  await index("photo-official", OFFICIAL);
  // A vector that should not exist: the worker never indexes a crowd album. It is written
  // here on purpose — this is the defence in depth. A re-index from an older build, a seed
  // script writing SQL, an album whose rows predate the rule: the search must still refuse.
  await index("photo-crowd", CROWD);
  await index("photo-second", SECOND_OFFICIAL);
  await index("photo-albumless");
  return {
    engine,
    official: "photo-official",
    crowd: "photo-crowd",
    secondOfficial: "photo-second",
    albumless: "photo-albumless",
    bytes,
  };
}

function photoIds(hits: readonly SearchHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.photoId))].sort();
}

describe("the fake engine honours albumIds", () => {
  it("search with no album sees the whole event (the v5 behaviour)", async () => {
    const f = await fixture();
    const hits = await f.engine.search({
      eventId: EVENT,
      imageBytes: f.bytes,
      contentType: "image/png",
    });
    assert.deepEqual(photoIds(hits), [f.albumless, f.crowd, f.official, f.secondOfficial].sort());
  });

  it("search restricted to one album returns that album only", async () => {
    const f = await fixture();
    const hits = await f.engine.search({
      eventId: EVENT,
      imageBytes: f.bytes,
      contentType: "image/png",
      albumIds: [OFFICIAL],
    });
    assert.deepEqual(photoIds(hits), [f.official]);
  });

  it("search restricted to several albums returns exactly those", async () => {
    const f = await fixture();
    const hits = await f.engine.search({
      eventId: EVENT,
      imageBytes: f.bytes,
      contentType: "image/png",
      albumIds: [OFFICIAL, SECOND_OFFICIAL],
    });
    assert.deepEqual(photoIds(hits), [f.official, f.secondOfficial].sort());
  });

  it("an empty album list searches nothing", async () => {
    const f = await fixture();
    const hits = await f.engine.search({
      eventId: EVENT,
      imageBytes: f.bytes,
      contentType: "image/png",
      albumIds: [],
    });
    assert.deepEqual(hits, []);
    const vectorHits = await f.engine.searchByVector({
      eventId: EVENT,
      embedding: fakeEmbedding(...RED),
      albumIds: [],
    });
    assert.deepEqual(vectorHits, []);
  });

  it("searchByVector — the match path — filters by album", async () => {
    const f = await fixture();
    const embedding = fakeEmbedding(...RED);
    const all = await f.engine.searchByVector({ eventId: EVENT, embedding });
    assert.equal(photoIds(all).length, 4);
    const official = await f.engine.searchByVector({
      eventId: EVENT,
      embedding,
      albumIds: [OFFICIAL],
    });
    assert.deepEqual(photoIds(official), [f.official]);
    // `maxFaces` still applies, after the filter and not instead of it.
    const capped = await f.engine.searchByVector({
      eventId: EVENT,
      embedding,
      albumIds: [OFFICIAL, SECOND_OFFICIAL],
      maxFaces: 1,
    });
    assert.equal(capped.length, 1);
    assert.ok([f.official, f.secondOfficial].includes(capped[0]?.photoId ?? ""));
  });

  it("searchFaces — the attach path — compares a face inside its own album by default", async () => {
    const f = await fixture();
    // The anchor is in the official album; the crowd and second-official photos are the
    // same colour, so without the filter all three are hits.
    const hits = await f.engine.searchFaces({
      eventId: EVENT,
      externalFaceId: `fake-${f.official}`,
    });
    assert.deepEqual(photoIds(hits), []);
    const widened = await f.engine.searchFaces({
      eventId: EVENT,
      externalFaceId: `fake-${f.official}`,
      albumIds: [OFFICIAL, SECOND_OFFICIAL],
    });
    assert.deepEqual(photoIds(widened), [f.secondOfficial]);
    // An anchor in the crowd album cannot reach the official one.
    const fromCrowd = await f.engine.searchFaces({
      eventId: EVENT,
      externalFaceId: `fake-${f.crowd}`,
    });
    assert.deepEqual(photoIds(fromCrowd), []);
  });

  it("faceEmbedding does not hand out a face from outside the requested albums", async () => {
    const f = await fixture();
    assert.ok(
      await f.engine.faceEmbedding({ eventId: EVENT, externalFaceId: `fake-${f.official}` }),
    );
    assert.ok(
      await f.engine.faceEmbedding({
        eventId: EVENT,
        externalFaceId: `fake-${f.official}`,
        albumIds: [OFFICIAL],
      }),
    );
    assert.equal(
      await f.engine.faceEmbedding({
        eventId: EVENT,
        externalFaceId: `fake-${f.crowd}`,
        albumIds: [OFFICIAL],
      }),
      null,
    );
  });

  it("a face stored without an album is never a result of an album-filtered search", async () => {
    const f = await fixture();
    for (const albumIds of [[OFFICIAL], [OFFICIAL, CROWD, SECOND_OFFICIAL]]) {
      const hits = await f.engine.search({
        eventId: EVENT,
        imageBytes: f.bytes,
        contentType: "image/png",
        albumIds,
      });
      assert.equal(photoIds(hits).includes(f.albumless), false);
    }
    // An anchor with no album is the one place where the v5 meaning survives: "inside my
    // album" has no answer without an album, so it falls back to the whole event, exactly
    // as in v5 (`packages/face-engine/src/face-engine.test.ts` pins that). Unreachable in
    // production — `face_vectors.album_id` is NOT NULL (migration 011) and the worker
    // always passes the album — and it does not weaken anything above: the moment a caller
    // passes `albumIds`, an albumless row is gone.
    const hits = await f.engine.searchFaces({
      eventId: EVENT,
      externalFaceId: `fake-${f.albumless}`,
    });
    assert.deepEqual(photoIds(hits), [f.crowd, f.official, f.secondOfficial].sort());
    const filtered = await f.engine.searchFaces({
      eventId: EVENT,
      externalFaceId: `fake-${f.albumless}`,
      albumIds: [OFFICIAL, CROWD, SECOND_OFFICIAL],
    });
    assert.deepEqual(photoIds(filtered), [f.crowd, f.official, f.secondOfficial].sort());
  });

  it("the album filter does not replace the event filter", async () => {
    const f = await fixture();
    const hits = await f.engine.search({
      eventId: OTHER_EVENT,
      imageBytes: f.bytes,
      contentType: "image/png",
      albumIds: [OFFICIAL],
    });
    assert.deepEqual(hits, []);
  });

  it("a crowd album is never searchable, even when a vector for it exists", async () => {
    const f = await fixture();
    // What `match` does: it asks the database for the event's *recognising* albums and
    // searches those (handlers.ts). A crowd album can never be in that list — migration 009
    // has a `check` that forbids `kind = 'crowd' and recognition`.
    const recognising = [OFFICIAL, SECOND_OFFICIAL];
    const embedding = fakeEmbedding(...RED);
    const hits = await f.engine.searchByVector({ eventId: EVENT, embedding, albumIds: recognising });
    assert.equal(photoIds(hits).includes(f.crowd), false, "no crowd photo in a match");
    const byImage = await f.engine.search({
      eventId: EVENT,
      imageBytes: f.bytes,
      contentType: "image/png",
      albumIds: recognising,
    });
    assert.equal(photoIds(byImage).includes(f.crowd), false);
    // Not even by asking for the crowd album's own face by id.
    assert.equal(
      await f.engine.faceEmbedding({
        eventId: EVENT,
        externalFaceId: `fake-${f.crowd}`,
        albumIds: recognising,
      }),
      null,
    );
  });

  it("deleting a face leaves the other albums alone", async () => {
    const f = await fixture();
    await f.engine.deleteFaces(EVENT, [`fake-${f.crowd}`]);
    const hits = await f.engine.search({
      eventId: EVENT,
      imageBytes: f.bytes,
      contentType: "image/png",
    });
    assert.deepEqual(photoIds(hits), [f.albumless, f.official, f.secondOfficial].sort());
  });
});
