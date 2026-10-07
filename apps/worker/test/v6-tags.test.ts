/**
 * v6 E (agent E): the tag notification, end to end through the worker.
 *
 * The tag route enqueues an `email` job of kind `tagged` instead of talking to SMTP itself,
 * so the mail is actually sent by `sendGalleryMail` — the same handler the "le tue foto sono
 * pronte" mail goes through. This test is here because the API-side test can only assert the
 * job payload: it proves the worker recognises the new kind, sends to the TAGGED person (not
 * the tagger), with Italian subject and a link into the tag area.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueue } from "@rephoto/api/queue";
import { MemoryDatabase } from "@rephoto/db";
import { FakeFaceEngine, MemoryFaceIndexStore } from "../../../packages/face-engine/src/fake.ts";
import type { WorkerDeps } from "../src/handlers.js";
import { MemoryObjectStore, RecordingMailer, drain, env, quiet } from "./helpers.ts";

test("the worker sends the tag notification to the tagged person", async () => {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const tagged = await db.createUser({ email: "tagged@example.com", role: "participant" });
  const tagger = await db.createUser({ email: "tagger@example.com", role: "participant" });
  const mailer = new RecordingMailer();
  const queue = createQueue(db);
  const deps: WorkerDeps = {
    env,
    db,
    objects: new MemoryObjectStore(),
    mailer,
    queue,
    faces: new FakeFaceEngine(new MemoryFaceIndexStore()),
    log: quiet,
  };

  await queue.enqueue("email", {
    userId: tagged.id,
    eventId: event.id,
    galleryPath: "/tag",
    kind: "tagged",
  });
  await drain(deps);

  assert.equal(mailer.sent.length, 1);
  const [message] = mailer.sent;
  assert.equal(message?.to, "tagged@example.com", "the tagged person, never the tagger");
  assert.notEqual(message?.to, tagger.email);
  assert.equal(message?.subject, "Ti hanno taggato in una foto");
  assert.equal(message?.text.trim(), "http://localhost:3000/tag");
});
