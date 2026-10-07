import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { describe, it } from "node:test";
import {
  FakeFaceEngine,
  MemoryFaceIndexStore,
  RateLimitedFaceEngine,
  SqlFaceIndexStore,
  TokenBucket,
  createFaceEngine,
  readTps,
  type FaceEngine,
  type FaceIndexStore,
} from "./index.ts";
import {
  RekognitionFaceEngine,
  RekognitionThrottleError,
  type RekognitionFaceClient,
} from "./rekognition.ts";

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] ?? 0;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function solidPng(r: number, g: number, b: number, width = 4, height = 4): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  return concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function emptyPng(): Uint8Array {
  const ihdr = new Uint8Array(13);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function engine(): FakeFaceEngine {
  return new FakeFaceEngine(new MemoryFaceIndexStore());
}

describe("FakeFaceEngine", () => {
  it("matches two solid PNGs of the same color at similarity 99", async () => {
    const face = engine();
    const indexed = await face.indexPhoto({
      eventId: "event-1",
      photoId: "photo-red",
      imageBytes: solidPng(255, 0, 0),
      contentType: "image/png",
    });
    assert.equal(indexed.length, 1);
    assert.equal(indexed[0]?.externalFaceId, "fake-photo-red");
    assert.equal(indexed[0]?.confidence, 99);
    assert.deepEqual(indexed[0]?.bbox, { left: 0, top: 0, width: 1, height: 1 });

    const hits = await face.search({
      eventId: "event-1",
      imageBytes: solidPng(255, 0, 0, 2, 2),
      contentType: "image/png",
    });
    assert.deepEqual(hits, [
      { externalFaceId: "fake-photo-red", photoId: "photo-red", similarity: 99 },
    ]);
  });

  it("quantizes average color into 16-level buckets", async () => {
    const face = engine();
    await face.indexPhoto({
      eventId: "event-1",
      photoId: "photo-bucket",
      imageBytes: solidPng(255, 16, 0),
      contentType: "image/png",
    });
    const hits = await face.search({
      eventId: "event-1",
      imageBytes: solidPng(248, 31, 15),
      contentType: "image/png",
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.photoId, "photo-bucket");
    assert.equal(hits[0]?.similarity, 99);

    const miss = await face.search({
      eventId: "event-1",
      imageBytes: solidPng(239, 16, 0),
      contentType: "image/png",
    });
    assert.deepEqual(miss, []);
  });

  it("does not hit a different color or a different event", async () => {
    const face = engine();
    await face.indexPhoto({
      eventId: "event-1",
      photoId: "photo-red",
      imageBytes: solidPng(255, 0, 0),
      contentType: "image/png",
    });
    await face.indexPhoto({
      eventId: "event-2",
      photoId: "photo-other-event",
      imageBytes: solidPng(0, 0, 255),
      contentType: "image/png",
    });
    const hits = await face.search({
      eventId: "event-1",
      imageBytes: solidPng(0, 0, 255),
      contentType: "image/png",
    });
    assert.deepEqual(hits, []);
    const otherEvent = await face.search({
      eventId: "event-2",
      imageBytes: solidPng(0, 0, 255),
      contentType: "image/png",
    });
    assert.equal(otherEvent[0]?.photoId, "photo-other-event");
  });

  it("returns no hit after deleteFaces", async () => {
    const face = engine();
    const indexed = await face.indexPhoto({
      eventId: "event-1",
      photoId: "photo-red",
      imageBytes: solidPng(200, 32, 8),
      contentType: "image/png",
    });
    await face.indexPhoto({
      eventId: "event-1",
      photoId: "photo-red-2",
      imageBytes: solidPng(200, 32, 8),
      contentType: "image/png",
    });
    await face.deleteFaces(eventIdOf(indexed), [indexed[0]?.externalFaceId ?? ""]);
    const hits = await face.search({
      eventId: "event-1",
      imageBytes: solidPng(200, 32, 8),
      contentType: "image/png",
    });
    assert.deepEqual(
      hits.map((hit) => hit.photoId),
      ["photo-red-2"],
    );
    await face.deleteFaces("event-1", ["fake-photo-red-2", "missing-id"]);
    const after = await face.search({
      eventId: "event-1",
      imageBytes: solidPng(200, 32, 8),
      contentType: "image/png",
    });
    assert.deepEqual(after, []);
  });

  it("does not write during search and ignores an empty image", async () => {
    let writes = 0;
    const inner = new MemoryFaceIndexStore();
    const store: FaceIndexStore = {
      async upsert(record) {
        writes += 1;
        await inner.upsert(record);
      },
      findByColor: (eventId, r, g, b) => inner.findByColor(eventId, r, g, b),
      findById: (id) => inner.findById(id),
      deleteIds: (eventId, ids) => inner.deleteIds(eventId, ids),
      deleteEvent: (eventId) => inner.deleteEvent(eventId),
    };
    const face = new FakeFaceEngine(store);
    await face.indexPhoto({
      eventId: "event-1",
      photoId: "photo-red",
      imageBytes: solidPng(255, 0, 0),
      contentType: "image/png",
    });
    assert.equal(writes, 1);
    await face.search({
      eventId: "event-1",
      imageBytes: solidPng(255, 0, 0),
      contentType: "image/png",
    });
    assert.equal(writes, 1);
    const indexed = await face.indexPhoto({
      eventId: "event-1",
      photoId: "empty",
      imageBytes: emptyPng(),
      contentType: "image/png",
    });
    assert.deepEqual(indexed, []);
    assert.equal(writes, 1);
  });

  it("falls back to memory when face_index is missing", async () => {
    let queries = 0;
    const face = new FakeFaceEngine(
      new SqlFaceIndexStore({
        async query() {
          queries += 1;
          const error = new Error("relation face_index does not exist");
          (error as Error & { code: string }).code = "42P01";
          throw error;
        },
      }),
    );
    await face.indexPhoto({
      eventId: "event-1",
      photoId: "photo-red",
      imageBytes: solidPng(255, 0, 0),
      contentType: "image/png",
    });
    const hits = await face.search({
      eventId: "event-1",
      imageBytes: solidPng(255, 0, 0),
      contentType: "image/png",
    });
    assert.equal(hits[0]?.photoId, "photo-red");
    assert.equal(hits[0]?.similarity, 99);
    assert.equal(queries, 1);
    await face.deleteFaces("event-1", ["fake-photo-red"]);
    const after = await face.search({
      eventId: "event-1",
      imageBytes: solidPng(255, 0, 0),
      contentType: "image/png",
    });
    assert.deepEqual(after, []);
    assert.equal(queries, 1);
  });

  it("reads solid JPEGs into the same color buckets as PNG", async () => {
    const face = engine();
    await face.indexPhoto({
      eventId: "event-1",
      photoId: "photo-jpeg",
      imageBytes: jpegBytes(SOLID_RED_JPEG),
      contentType: "image/jpeg",
    });
    const same = await face.search({
      eventId: "event-1",
      imageBytes: jpegBytes(SOLID_RED_JPEG),
      contentType: "image/jpeg",
    });
    assert.equal(same[0]?.photoId, "photo-jpeg");
    assert.equal(same[0]?.similarity, 99);
    const fromPng = await face.search({
      eventId: "event-1",
      imageBytes: solidPng(220, 40, 40),
      contentType: "image/png",
    });
    assert.equal(fromPng[0]?.photoId, "photo-jpeg");
    const other = await face.search({
      eventId: "event-1",
      imageBytes: jpegBytes(SOLID_BLUE_JPEG),
      contentType: "image/jpeg",
    });
    assert.deepEqual(other, []);
  });

  it("throws a clear error without echoing image bytes", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 255, 0, 10]);
    await assert.rejects(
      () =>
        engine().indexPhoto({
          eventId: "event-1",
          photoId: "bad",
          imageBytes: bytes,
          contentType: "image/png",
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /PNG or JPEG/);
        assert.equal(error.message.includes("1,2,3"), false);
        assert.equal("imageBytes" in error, false);
        return true;
      },
    );
  });
});

function eventIdOf(
  faces: Array<{ externalFaceId: string }>,
): string {
  assert.ok(faces[0]);
  return "event-1";
}

describe("createFaceEngine", () => {
  it("defaults to the fake engine when FACE_ENGINE is unset", () => {
    const previous = process.env.FACE_ENGINE;
    delete process.env.FACE_ENGINE;
    try {
      const created = createFaceEngine();
      assert.ok(created instanceof FakeFaceEngine);
      assert.ok(!(created instanceof RekognitionFaceEngine));
    } finally {
      if (previous === undefined) delete process.env.FACE_ENGINE;
      else process.env.FACE_ENGINE = previous;
    }
    const explicit = createFaceEngine({});
    assert.ok(explicit instanceof FakeFaceEngine);
  });

  it("constructs the rekognition engine without calling AWS", () => {
    let calls = 0;
    const client = recordingClient(() => {
      calls += 1;
    });
    const created = createFaceEngine({ FACE_ENGINE: "rekognition" });
    // Rekognition is wrapped in the per-process rate limiter.
    assert.ok(created instanceof RateLimitedFaceEngine);
    assert.equal(calls, 0);
    const injected = new RekognitionFaceEngine({
      env: { FACE_ENGINE: "rekognition" },
      client,
    });
    assert.ok(injected instanceof RekognitionFaceEngine);
    assert.equal(calls, 0);
  });

  it("rejects an unknown engine", () => {
    assert.throws(
      () => createFaceEngine({ FACE_ENGINE: "insightface" }),
      /FACE_ENGINE/,
    );
  });
});

describe("RekognitionFaceEngine", () => {
  it("sets ExternalImageId to photoId and does not IndexFaces during search", async () => {
    const calls: string[] = [];
    const client: RekognitionFaceClient = {
      async createCollection(input) {
        calls.push(`create:${input.CollectionId}`);
      },
      async indexFaces(input) {
        calls.push("indexFaces");
        assert.equal(input.ExternalImageId, "photo-1");
        assert.equal(input.MaxFaces, 50);
        assert.equal(input.QualityFilter, "AUTO");
        assert.equal(
          input.CollectionId,
          "rephoto-11111111-1111-4111-8111-111111111111",
        );
        assert.equal(input.Image.Bytes.byteLength, 3);
        assert.equal(Object.hasOwn(input, "DetectionAttributes"), false);
        return {
          FaceRecords: [
            {
              Face: {
                FaceId: "face-1",
                Confidence: 88.5,
                BoundingBox: { Left: 0.1, Top: 0.2, Width: 0.3, Height: 0.4 },
              },
            },
            { Face: { Confidence: 10 } },
          ],
        };
      },
      async searchFacesByImage(input) {
        calls.push("searchFacesByImage");
        assert.equal(input.MaxFaces, 500);
        assert.equal(input.FaceMatchThreshold, 90);
        assert.equal(Object.hasOwn(input, "ExternalImageId"), false);
        assert.equal(
          input.CollectionId,
          "rephoto-11111111-1111-4111-8111-111111111111",
        );
        return {
          FaceMatches: [
            {
              Similarity: 96.5,
              Face: { FaceId: "face-1", ExternalImageId: "photo-1" },
            },
            { Similarity: 99, Face: { FaceId: "face-dropped" } },
            {
              Similarity: 95,
              Face: { FaceId: "face-empty", ExternalImageId: "" },
            },
            {
              Similarity: 80,
              Face: { FaceId: "face-low", ExternalImageId: "photo-low" },
            },
          ],
        };
      },
      async searchFaces() {
        return { FaceMatches: [] };
      },
      async deleteFaces(input) {
        calls.push(`delete:${input.FaceIds.join(",")}`);
      },
      async deleteCollection(input) {
        calls.push(`deleteCollection:${input.CollectionId}`);
      },
    };
    const face = new RekognitionFaceEngine({
      client,
      env: { REKOGNITION_MIN_SIMILARITY: "90", REKOGNITION_COLLECTION_PREFIX: "rephoto-" },
    });
    const eventId = "11111111-1111-4111-8111-111111111111";
    const imageBytes = new Uint8Array([9, 8, 7]);
    const indexed = await face.indexPhoto({
      eventId,
      photoId: "photo-1",
      imageBytes,
      contentType: "image/jpeg",
    });
    assert.deepEqual(indexed, [
      {
        externalFaceId: "face-1",
        confidence: 88.5,
        bbox: { left: 0.1, top: 0.2, width: 0.3, height: 0.4 },
      },
    ]);
    const beforeSearch = calls.length;
    const hits = await face.search({
      eventId,
      imageBytes,
      contentType: "image/jpeg",
    });
    assert.deepEqual(hits, [
      { externalFaceId: "face-1", photoId: "photo-1", similarity: 96.5 },
    ]);
    const searchCalls = calls.slice(beforeSearch);
    assert.deepEqual(searchCalls, ["searchFacesByImage"]);
    assert.equal(searchCalls.includes("indexFaces"), false);

    await face.deleteFaces(eventId, []);
    assert.equal(calls.at(-1), "searchFacesByImage");
    await face.deleteFaces(eventId, ["face-1"]);
    assert.equal(calls.at(-1), "delete:face-1");
  });

  it("sanitizes errors and treats a missing collection as an empty search", async () => {
    const imageBytes = Uint8Array.from("SECRET-IMAGE-BYTES-1234567890", (char) =>
      char.charCodeAt(0),
    );
    const client: RekognitionFaceClient = {
      async createCollection() {
        const error = new Error(`index failed ${Buffer.from(imageBytes).toString("utf8")}\u0000\u00ff`);
        error.name = "ServiceException";
        (error as Error & { Image?: unknown }).Image = { Bytes: imageBytes };
        throw error;
      },
      async indexFaces() {
        throw new Error("index should not run");
      },
      async searchFacesByImage() {
        const error = new Error("missing");
        error.name = "ResourceNotFoundException";
        throw error;
      },
      async searchFaces() {
        return { FaceMatches: [] };
      },
      async deleteFaces() {
        const error = new Error("missing");
        error.name = "ResourceNotFoundException";
        throw error;
      },
      async deleteCollection() {
        const error = new Error("missing");
        error.name = "ResourceNotFoundException";
        throw error;
      },
    };
    const face = new RekognitionFaceEngine({ client, env: {} });
    await assert.rejects(
      () =>
        face.indexPhoto({
          eventId: "event/1",
          photoId: "photo-1",
          imageBytes,
          contentType: "image/jpeg",
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "ServiceException");
        assert.equal(error.message.includes("SECRET-IMAGE-BYTES"), false);
        assert.equal(error.message.includes("\u0000"), false);
        assert.equal("Image" in error, false);
        assert.equal((error as Error & { cause?: unknown }).cause, undefined);
        return true;
      },
    );
    const hits = await face.search({
      eventId: "event/1",
      imageBytes,
      contentType: "image/jpeg",
    });
    assert.deepEqual(hits, []);
    await face.deleteFaces("event/1", ["face-1"]);
  });

  it("accepts a collection that already exists", async () => {
    const calls: string[] = [];
    const client: RekognitionFaceClient = {
      async createCollection() {
        calls.push("create");
        const error = new Error("exists");
        error.name = "ResourceAlreadyExistsException";
        throw error;
      },
      async indexFaces(input) {
        calls.push("indexFaces");
        assert.equal(input.CollectionId, "rephoto-event1");
        assert.equal(input.ExternalImageId, "photo-9");
        return { FaceRecords: [] };
      },
      async searchFacesByImage() {
        calls.push("searchFacesByImage");
        return { FaceMatches: [] };
      },
      async searchFaces() {
        return { FaceMatches: [] };
      },
      async deleteFaces() {
        calls.push("deleteFaces");
      },
      async deleteCollection() {
        calls.push("deleteCollection");
      },
    };
    const face = new RekognitionFaceEngine({
      client,
      env: { REKOGNITION_COLLECTION_PREFIX: "rephoto-" },
    });
    const indexed = await face.indexPhoto({
      eventId: "event/1",
      photoId: "photo-9",
      imageBytes: new Uint8Array([1]),
      contentType: "image/png",
    });
    assert.deepEqual(indexed, []);
    await face.indexPhoto({
      eventId: "event/1",
      photoId: "photo-9",
      imageBytes: new Uint8Array([1]),
      contentType: "image/png",
    });
    assert.deepEqual(calls, ["create", "indexFaces", "indexFaces"]);
  });

  it("turns a throughput error into a throttle error without image bytes", async () => {
    const imageBytes = Uint8Array.from("SECRET-IMAGE-BYTES-1234567890", (char) =>
      char.charCodeAt(0),
    );
    const client: RekognitionFaceClient = {
      async createCollection() {
        return undefined;
      },
      async indexFaces() {
        const error = new Error(`busy ${Buffer.from(imageBytes).toString("utf8")}`);
        error.name = "ProvisionedThroughputExceededException";
        throw error;
      },
      async searchFacesByImage() {
        return { FaceMatches: [] };
      },
      async searchFaces() {
        return { FaceMatches: [] };
      },
      async deleteFaces() {
        return undefined;
      },
      async deleteCollection() {
        return undefined;
      },
    };
    const face = new RekognitionFaceEngine({ client, env: {} });
    await assert.rejects(
      () =>
        face.indexPhoto({
          eventId: "event-1",
          photoId: "photo-1",
          imageBytes,
          contentType: "image/jpeg",
        }),
      (error: unknown) => {
        assert.ok(error instanceof RekognitionThrottleError);
        assert.equal(error.message.includes("SECRET-IMAGE-BYTES"), false);
        return true;
      },
    );
  });

  it("deletes the collection and ignores one that is already gone", async () => {
    const calls: string[] = [];
    const client: RekognitionFaceClient = {
      async createCollection() {
        return undefined;
      },
      async indexFaces() {
        return {};
      },
      async searchFacesByImage() {
        return {};
      },
      async searchFaces() {
        return { FaceMatches: [] };
      },
      async deleteFaces() {
        return undefined;
      },
      async deleteCollection(input) {
        calls.push(input.CollectionId);
        if (calls.length === 2) {
          const error = new Error("missing");
          error.name = "ResourceNotFoundException";
          throw error;
        }
      },
    };
    const face = new RekognitionFaceEngine({
      client,
      env: { REKOGNITION_COLLECTION_PREFIX: "rephoto-" },
    });
    await face.deleteCollection("event-1");
    await face.deleteCollection("event-1");
    assert.deepEqual(calls, ["rephoto-event-1", "rephoto-event-1"]);
  });
});

function jpegBytes(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

const SOLID_RED_JPEG =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAIAAgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwQDAwMEBQQEBAQFBwUFBQUFBwgHBwcHBwcICAgICAgICAoKCgoKCgsLCwsLDQ0NDQ0NDQ0NDf/bAEMBAgICAwMDBgMDBg0JBwkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDf/dAAQAAv/aAAwDAQACEQMRAD8A+d6KKK/Bz/WgKKKKAP/Q+d6KKK/Bz/WgKKKKAP/Z";

const SOLID_BLUE_JPEG =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAIAAgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwQDAwMEBQQEBAQFBwUFBQUFBwgHBwcHBwcICAgICAgICAoKCgoKCgsLCwsLDQ0NDQ0NDQ0NDf/bAEMBAgICAwMDBgMDBg0JBwkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDf/dAAQAAv/aAAwDAQACEQMRAD8A/Jeiiiv9QD4sKKKKAP/Q/Jeiiiv9QD4sKKKKAP/Z";

function recordingClient(onCall: () => void): RekognitionFaceClient {
  return {
    async createCollection() {
      onCall();
    },
    async indexFaces() {
      onCall();
      return {};
    },
    async searchFacesByImage() {
      onCall();
      return {};
    },
    async searchFaces() {
      return { FaceMatches: [] };
    },
    async deleteFaces() {
      onCall();
    },
    async deleteCollection() {
      onCall();
    },
  };
}

describe("searchFaces", () => {
  it("fake: returns same-color faces of the event, excluding the anchor", async () => {
    const face = engine();
    await face.indexPhoto({
      eventId: "event-1",
      photoId: "photo-a",
      imageBytes: solidPng(255, 0, 0),
      contentType: "image/png",
    });
    await face.indexPhoto({
      eventId: "event-1",
      photoId: "photo-b",
      imageBytes: solidPng(255, 0, 0),
      contentType: "image/png",
    });
    await face.indexPhoto({
      eventId: "event-1",
      photoId: "photo-c",
      imageBytes: solidPng(0, 0, 255),
      contentType: "image/png",
    });
    await face.indexPhoto({
      eventId: "event-2",
      photoId: "photo-d",
      imageBytes: solidPng(255, 0, 0),
      contentType: "image/png",
    });
    const hits = await face.searchFaces({ eventId: "event-1", externalFaceId: "fake-photo-a" });
    assert.deepEqual(hits, [
      { externalFaceId: "fake-photo-b", photoId: "photo-b", similarity: 99 },
    ]);
    assert.deepEqual(
      await face.searchFaces({ eventId: "event-1", externalFaceId: "fake-missing" }),
      [],
    );
    assert.deepEqual(
      await face.searchFaces({ eventId: "event-2", externalFaceId: "fake-photo-a" }),
      [],
    );
  });

  it("fake: SqlFaceIndexStore looks the anchor up by id", async () => {
    const queries: string[] = [];
    const store = new SqlFaceIndexStore({
      async query<T>(sql: string, params?: readonly unknown[]) {
        queries.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("WHERE external_face_id = $1")) {
          return {
            rows: [
              { external_face_id: params?.[0], photo_id: "photo-a", event_id: "event-1", r: 15, g: 0, b: 0 },
            ] as T[],
          };
        }
        return {
          rows: [
            { external_face_id: "fake-photo-a", photo_id: "photo-a", event_id: "event-1", r: 15, g: 0, b: 0 },
            { external_face_id: "fake-photo-b", photo_id: "photo-b", event_id: "event-1", r: 15, g: 0, b: 0 },
          ] as T[],
        };
      },
    });
    const face = new FakeFaceEngine(store);
    const hits = await face.searchFaces({ eventId: "event-1", externalFaceId: "fake-photo-a" });
    assert.deepEqual(hits, [
      { externalFaceId: "fake-photo-b", photoId: "photo-b", similarity: 99 },
    ]);
    assert.equal(queries.length, 2);
    assert.match(queries[0] ?? "", /WHERE external_face_id = \$1/);
    assert.match(queries[1] ?? "", /r = \$2 AND g = \$3 AND b = \$4/);
  });

  it("rekognition: calls SearchFaces, filters by similarity and drops the anchor", async () => {
    const inputs: unknown[] = [];
    const client: RekognitionFaceClient = {
      async createCollection() {
        return undefined;
      },
      async indexFaces() {
        return {};
      },
      async searchFacesByImage() {
        return {};
      },
      async searchFaces(input) {
        inputs.push(input);
        return {
          FaceMatches: [
            { Similarity: 99.9, Face: { FaceId: "face-1", ExternalImageId: "photo-1" } },
            { Similarity: 97, Face: { FaceId: "face-2", ExternalImageId: "photo-2" } },
            { Similarity: 80, Face: { FaceId: "face-3", ExternalImageId: "photo-3" } },
            { Similarity: 95, Face: { FaceId: "face-4" } },
          ],
        };
      },
      async deleteFaces() {
        return undefined;
      },
      async deleteCollection() {
        return undefined;
      },
    };
    const face = new RekognitionFaceEngine({
      client,
      env: { REKOGNITION_COLLECTION_PREFIX: "rephoto-", REKOGNITION_SEARCH_MAX_FACES: "7" },
    });
    const hits = await face.searchFaces({ eventId: "event-1", externalFaceId: "face-1" });
    assert.deepEqual(hits, [{ externalFaceId: "face-2", photoId: "photo-2", similarity: 97 }]);
    assert.deepEqual(inputs, [
      { CollectionId: "rephoto-event-1", FaceId: "face-1", MaxFaces: 7, FaceMatchThreshold: 90 },
    ]);
  });

  it("rekognition: a missing collection or face is an empty result, throttles propagate", async () => {
    let name = "ResourceNotFoundException";
    const client: RekognitionFaceClient = {
      async createCollection() {
        return undefined;
      },
      async indexFaces() {
        return {};
      },
      async searchFacesByImage() {
        return {};
      },
      async searchFaces() {
        const error = new Error("nope");
        error.name = name;
        throw error;
      },
      async deleteFaces() {
        return undefined;
      },
      async deleteCollection() {
        return undefined;
      },
    };
    const face = new RekognitionFaceEngine({ client, env: {} });
    assert.deepEqual(await face.searchFaces({ eventId: "e", externalFaceId: "f" }), []);
    name = "ThrottlingException";
    await assert.rejects(
      () => face.searchFaces({ eventId: "e", externalFaceId: "f" }),
      (error: unknown) => error instanceof RekognitionThrottleError,
    );
  });
});

describe("RateLimitedFaceEngine", () => {
  it("limits index and search calls, keeps order and leaves deletes unlimited", async () => {
    const calls: string[] = [];
    const inner: FaceEngine = {
      async indexPhoto(input) {
        calls.push(`index:${input.photoId}`);
        return [];
      },
      async search() {
        calls.push("search");
        return [];
      },
      async searchFaces(input) {
        calls.push(`searchFaces:${input.externalFaceId}`);
        return [];
      },
      async deleteFaces() {
        calls.push("delete");
      },
      async deleteCollection() {
        calls.push("deleteCollection");
      },
    };
    const limited = new RateLimitedFaceEngine(inner, { indexTps: 50, searchTps: 50 });
    const started = Date.now();
    // Capacity is ceil(tps) = 50: the first 50 calls are a burst, the next 10 wait ~200 ms.
    const pending: Promise<unknown>[] = [];
    for (let index = 0; index < 60; index += 1) {
      pending.push(
        limited.indexPhoto({
          eventId: "e",
          photoId: `p${index}`,
          imageBytes: new Uint8Array(),
          contentType: "image/png",
        }),
      );
    }
    pending.push(limited.deleteFaces("e", ["x"]));
    await Promise.all(pending);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 180, `expected at least 180 ms, took ${elapsed}`);
    const indexCalls = calls.filter((call) => call.startsWith("index:"));
    assert.deepEqual(
      indexCalls,
      Array.from({ length: 60 }, (_, index) => `index:p${index}`),
    );
    assert.equal(calls.indexOf("delete") < 55, true);

    const searchStart = Date.now();
    const searches: Promise<unknown>[] = [];
    for (let index = 0; index < 55; index += 1) {
      searches.push(
        index % 2 === 0
          ? limited.search({ eventId: "e", imageBytes: new Uint8Array(), contentType: "image/png" })
          : limited.searchFaces({ eventId: "e", externalFaceId: `f${index}` }),
      );
    }
    await Promise.all(searches);
    assert.ok(Date.now() - searchStart >= 80, "search and searchFaces share one bucket");
  });

  it("rejects a non-positive rate and createFaceEngine wraps rekognition only", () => {
    assert.throws(() => new TokenBucket(0));
    assert.throws(() => readTps("abc", "X"));
    assert.equal(readTps("", "X"), 5);
    assert.equal(readTps("2.5", "X"), 2.5);
    assert.ok(createFaceEngine({ FACE_ENGINE: "fake" }) instanceof FakeFaceEngine);
    assert.ok(
      createFaceEngine({ FACE_ENGINE: "rekognition", REKOGNITION_INDEX_TPS: "1" }) instanceof
        RateLimitedFaceEngine,
    );
    assert.throws(() =>
      createFaceEngine({ FACE_ENGINE: "rekognition", REKOGNITION_SEARCH_TPS: "-1" }),
    );
  });
});
