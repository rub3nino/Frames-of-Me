import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rekognitionCollectionId } from "./face-engine.ts";

describe("rekognitionCollectionId", () => {
  it("keeps uuid hyphens and prefixes rephoto-", () => {
    const eventId = "550e8400-e29b-41d4-a716-446655440000";
    assert.equal(
      rekognitionCollectionId(eventId),
      "rephoto-550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("strips only characters outside [a-zA-Z0-9_.\\-]", () => {
    assert.equal(rekognitionCollectionId("ab/cd ef"), "rephoto-abcdef");
  });

  it("rejects an empty id", () => {
    assert.throws(() => rekognitionCollectionId("///", ""));
  });
});
