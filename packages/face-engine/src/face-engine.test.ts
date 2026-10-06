import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { describe, it } from "node:test";
import {
  FakeFaceEngine,
  MemoryFaceIndexStore,
  SqlFaceIndexStore,
  createFaceEngine,
  type FaceIndexStore,
} from "./index.ts";
import { RekognitionFaceEngine, type RekognitionFaceClient } from "./rekognition.ts";

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
      deleteIds: (eventId, ids) => inner.deleteIds(eventId, ids),
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
    assert.ok(created instanceof RekognitionFaceEngine);
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
        assert.equal(input.MaxFaces, 50);
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
      async deleteFaces(input) {
        calls.push(`delete:${input.FaceIds.join(",")}`);
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
      async deleteFaces() {
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
      async deleteFaces() {
        calls.push("deleteFaces");
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
    async deleteFaces() {
      onCall();
    },
  };
}
