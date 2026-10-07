import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JOB_PRIORITY, emailPayloadSchema, jobDedupeKey, jobTypeSchema } from "./jobs.ts";

describe("jobs", () => {
  it("orders priorities match < email < attach < derive < index < verify < retention", () => {
    assert.deepEqual(JOB_PRIORITY, {
      match: 0,
      email: 10,
      attach: 30,
      derive: 50,
      index: 60,
      verify: 70,
      retention: 90,
    });
    for (const type of jobTypeSchema.options) {
      assert.equal(typeof JOB_PRIORITY[type], "number");
    }
  });

  it("builds the dedupe key per type and none for match", () => {
    assert.equal(jobDedupeKey("derive", { photoId: "p1" }), "derive:p1");
    assert.equal(jobDedupeKey("index", { photoId: "p1" }), "index:p1");
    assert.equal(jobDedupeKey("attach", { photoId: "p1" }), "attach:p1");
    assert.equal(jobDedupeKey("verify", { photoId: "p1" }), "verify:p1");
    assert.equal(
      jobDedupeKey("email", { userId: "u1", eventId: "e1", galleryPath: "/x", kind: "new" }),
      "email:new:u1:e1",
    );
    assert.equal(jobDedupeKey("retention", { eventId: "e1", actorId: "a1" }), "retention:e1");
    assert.equal(jobDedupeKey("match", { userId: "u1", eventId: "e1", selfieKey: "k" }), null);
  });

  it("requires the email kind", () => {
    const base = {
      userId: "550e8400-e29b-41d4-a716-446655440000",
      eventId: "550e8400-e29b-41d4-a716-446655440001",
      galleryPath: "/e/demo",
    };
    assert.equal(emailPayloadSchema.safeParse(base).success, false);
    assert.equal(emailPayloadSchema.safeParse({ ...base, kind: "ready" }).success, true);
    assert.equal(emailPayloadSchema.safeParse({ ...base, kind: "later" }).success, false);
  });
});
