/**
 * v6 hardening H2 (agent H): the worker refuses `index` work against an incompatible face
 * service, and keeps doing every other kind of job.
 *
 * The incident: a stale `rephoto-face-service` image enforced `max_faces <= 50` while the
 * source said 150 and the worker asked for 100. `/v1/embed?max_faces=100` was rejected with
 * an HTTP 422 by FastAPI's query validator, every `index` job failed five times, and the
 * photos ended in `error` — while `/health` answered `{"ok": true}` throughout.
 *
 * `/health` is stubbed here: no face service, no network.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createQueue, type JobQueue } from "@rephoto/api/queue";
import { objectKeys } from "@rephoto/contracts";
import { MemoryDatabase } from "@rephoto/db";
import { FaceServiceBreaker } from "../src/breaker.ts";
import {
  checkFaceServiceCompat,
  FACE_INCOMPATIBLE_JOB_TYPES,
  FaceServiceGate,
} from "../src/face-compat.ts";
import type { WorkerDeps } from "../src/handlers.js";
import { claimOptions, pollOnce } from "../src/run.ts";
import { MemoryObjectStore, RecordingMailer, env, quiet, solidPng, stubEngine, storePhoto } from "./helpers.ts";

const SERVICE_URL = "http://face-service.local:8090";

/** A `GET /health` that answers exactly this body with this status, and records the calls. */
function stubHealth(
  body: unknown,
  status = 200,
): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

/** The real shape of the fixed service (apps/face-service/app/main.py). */
function healthBody(maxFacesCap: number | null, version = "1.1.0"): Record<string, unknown> {
  return {
    ok: true,
    model: "buffalo_l",
    providers: ["CPUExecutionProvider"],
    version,
    ...(maxFacesCap === null ? {} : { max_faces_cap: maxFacesCap }),
  };
}

// ---- the verdict ----------------------------------------------------------------------------

test("a service whose cap is below what the worker asks for is incompatible", async () => {
  // Exactly the wave-1 incident: the image caps at 50, the worker asks for 100.
  const fetchImpl = stubHealth(healthBody(50, "1.0.0"));
  const result = await checkFaceServiceCompat({
    serviceUrl: SERVICE_URL,
    requiredMaxFaces: 100,
    fetch: fetchImpl,
  });
  assert.equal(result.compatible, false);
  assert.deepEqual(fetchImpl.calls, [`${SERVICE_URL}/health`]);
  assert.equal(result.health?.maxFacesCap, 50);
  assert.equal(result.health?.version, "1.0.0");
  // The line a human has to act on names both numbers and what to do.
  assert.match(result.reason, /max_faces<=50/);
  assert.match(result.reason, /asks for 100/);
  assert.match(result.reason, /INSIGHTFACE_INDEX_MAX_FACES/);
});

test("a service that reports a sufficient cap is compatible", async () => {
  for (const cap of [100, 150]) {
    const result = await checkFaceServiceCompat({
      serviceUrl: SERVICE_URL,
      requiredMaxFaces: 100,
      fetch: stubHealth(healthBody(cap)),
    });
    assert.equal(result.compatible, true, `cap ${cap}`);
    assert.equal(result.health?.maxFacesCap, cap);
  }
});

test("a build that does not report max_faces_cap at all is refused", async () => {
  // The pre-H2 /health: `{ ok, model, providers }`. It cannot be verified, and it is the
  // exact class of image that caused the incident, so it is not trusted.
  const result = await checkFaceServiceCompat({
    serviceUrl: SERVICE_URL,
    requiredMaxFaces: 100,
    fetch: stubHealth({ ok: true, model: "buffalo_l", providers: ["CPUExecutionProvider"] }),
  });
  assert.equal(result.compatible, false);
  assert.match(result.reason, /does not report max_faces_cap/);
  assert.equal(result.health?.maxFacesCap, null);
});

test("a 503 during model load still decides: the version travels with it", async () => {
  // The service answers 503 for the ~60 s the model takes to load, and that 503 carries the
  // build. An incompatible build is caught then, not after the first 422.
  const loading = await checkFaceServiceCompat({
    serviceUrl: SERVICE_URL,
    requiredMaxFaces: 100,
    fetch: stubHealth({ ok: false, model: "buffalo_l", providers: [], version: "1.1.0", max_faces_cap: 50 }, 503),
  });
  assert.equal(loading.compatible, false);
  assert.equal(loading.health?.status, 503);
  const fine = await checkFaceServiceCompat({
    serviceUrl: SERVICE_URL,
    requiredMaxFaces: 100,
    fetch: stubHealth({ ok: false, model: "buffalo_l", providers: [], version: "1.1.0", max_faces_cap: 150 }, 503),
  });
  assert.equal(fine.compatible, true);
});

test("a service that cannot be reached is not called incompatible", async () => {
  // That case belongs to the circuit breaker, which pauses face work on
  // `FaceServiceUnavailable` and retries. Refusing work forever because one probe at boot
  // failed would be the same outage with a different cause.
  const refuse = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8090");
  }) as typeof fetch;
  const down = await checkFaceServiceCompat({
    serviceUrl: SERVICE_URL,
    requiredMaxFaces: 100,
    fetch: refuse,
  });
  assert.equal(down.compatible, true);
  assert.equal(down.health, null);
  assert.match(down.reason, /unreadable/);
  // Same for a body that is not JSON at all (a proxy error page, say).
  const html = (async () =>
    new Response("<html>502 Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
  const garbage = await checkFaceServiceCompat({
    serviceUrl: SERVICE_URL,
    requiredMaxFaces: 100,
    fetch: html,
  });
  assert.equal(garbage.compatible, true);
  assert.equal(garbage.health, null);
});

// ---- the consequence: index work is not claimed ---------------------------------------------

test("the gate logs one loud line and excludes index", async () => {
  const gate = new FaceServiceGate();
  const lines: string[] = [];
  const result = await checkFaceServiceCompat({
    serviceUrl: SERVICE_URL,
    requiredMaxFaces: 100,
    fetch: stubHealth(healthBody(50, "1.0.0")),
  });
  gate.apply(result, (line) => lines.push(line));
  assert.equal(lines.length, 1, "one line, not one per job");
  const logged = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.equal(logged.faceService, "incompatible");
  assert.deepEqual(logged.paused, ["index", "match"]);
  assert.equal(logged.maxFacesCap, 50);
  assert.equal(logged.requiredMaxFaces, 100);
  assert.equal(logged.version, "1.0.0");
  assert.ok(String(logged.error).length > 0);
  assert.equal(gate.isBlocked(), true);
  assert.deepEqual(gate.excludedTypes(), FACE_INCOMPATIBLE_JOB_TYPES);
});

test("a compatible service blocks nothing and still says what it saw", async () => {
  const gate = new FaceServiceGate();
  const lines: string[] = [];
  gate.apply(
    await checkFaceServiceCompat({
      serviceUrl: SERVICE_URL,
      requiredMaxFaces: 100,
      fetch: stubHealth(healthBody(150)),
    }),
    (line) => lines.push(line),
  );
  assert.equal(gate.isBlocked(), false);
  assert.equal(gate.excludedTypes(), undefined);
  const logged = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.equal(logged.faceService, "compatible");
  assert.match(String(logged.detail), /max_faces_cap=150/);
});

test("the claim filter merges the gate with the circuit breaker", async () => {
  const db = new MemoryDatabase();
  const base: WorkerDeps = {
    env,
    db,
    objects: new MemoryObjectStore(),
    mailer: new RecordingMailer(),
    queue: createQueue(db),
    faces: stubEngine(),
    log: quiet,
  };
  assert.equal(claimOptions(base), undefined);

  const gate = new FaceServiceGate();
  gate.apply(
    await checkFaceServiceCompat({
      serviceUrl: SERVICE_URL,
      requiredMaxFaces: 100,
      fetch: stubHealth(healthBody(50)),
    }),
    () => undefined,
  );
  assert.deepEqual([...(claimOptions({ ...base, faceGate: gate })?.excludeTypes ?? [])].sort(), [
    "index",
    "match",
  ]);

  // An open breaker pauses all three face types; the gate's types must not be lost in the
  // union, and must not be dropped when the breaker closes.
  const breaker = new FaceServiceBreaker({ threshold: 1, pauseMs: 60_000 });
  breaker.recordUnavailable();
  const both = claimOptions({ ...base, faceGate: gate, breaker })?.excludeTypes ?? [];
  assert.deepEqual([...both].sort(), ["attach", "index", "match"]);
  assert.equal(new Set(both).size, both.length, "no type listed twice");
  breaker.recordSuccess();
});

test("an incompatible service leaves index AND match queued while other work drains", async () => {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const photographer = await db.createUser({ email: "shooter@example.com", role: "photographer" });
  const participant = await db.createUser({ email: "guest@example.com", role: "participant" });
  const objects = new MemoryObjectStore();
  const queue = createQueue(db);
  // Every engine method that posts to `/v1/embed?max_faces=` throws the way the stale image
  // made it throw. If the gate lets either job through, the count moves and we know.
  const embedCalls = { photo: 0, selfie: 0 };
  const reject = (kind: "photo" | "selfie") => async (): Promise<never> => {
    embedCalls[kind] += 1;
    throw new Error("Face service answered 422");
  };
  const deps: WorkerDeps = {
    env,
    db,
    objects,
    mailer: new RecordingMailer(),
    queue,
    faces: stubEngine({
      // `index` -> indexPhoto; `match` -> embedSelfie (or `search` when the engine has no
      // vector path). All three are the same `embed()` call underneath.
      indexPhoto: reject("photo"),
      embedSelfie: reject("selfie"),
      search: reject("selfie"),
    }),
    log: quiet,
    faceGate: new FaceServiceGate(),
  };
  deps.faceGate?.apply(
    await checkFaceServiceCompat({
      serviceUrl: SERVICE_URL,
      requiredMaxFaces: 100,
      fetch: stubHealth(healthBody(50)),
    }),
    () => undefined,
  );

  const bytes = new Uint8Array(await solidPng(120, 40, 60));
  const photoId = await storePhoto(deps, {
    eventId: event.id,
    photographerId: photographer.id,
    bytes,
  });
  // The web derivative `index` reads before it embeds (FACE_INDEX_SOURCE=web with `fake`),
  // so the index job really does get as far as the engine once nothing stops it.
  await objects.put(objectKeys.web(photoId), bytes, "image/jpeg");
  const selfieKey = objectKeys.selfie(event.id, participant.id, randomUUID());
  await objects.put(selfieKey, bytes, "image/png");
  await queue.enqueue("index", { photoId });
  await queue.enqueue("match", { userId: participant.id, eventId: event.id, selfieKey });
  await queue.enqueue("retention", { eventId: event.id });

  // Every claim the worker can make, until it finds nothing it is willing to do.
  let claimed = 0;
  while (await pollOnce(deps)) claimed += 1;
  assert.equal(claimed, 1, "only the retention job was claimed");
  assert.deepEqual(embedCalls, { photo: 0, selfie: 0 }, "the service was never asked to embed");

  // Both jobs are untouched: still queued, zero errors, nothing running. When the right
  // image is deployed and the worker restarts, they run.
  const byType = (await db.metricsExtras()).jobsByType;
  for (const type of ["index", "match"]) {
    const row = byType.find((job) => job.type === type);
    assert.equal(row?.queued, 1, `${type} is still queued`);
    assert.equal(row?.error, 0, `${type} has no error`);
    assert.equal(row?.running, 0, `${type} is not running`);
  }
  // The photo never reached `error` ...
  const photo = await db.findPhoto(photoId);
  assert.equal(photo?.status, "uploaded");
  assert.equal(photo?.error, null);
  // ... and — the part the participant sees — no gallery was written at all. Before this,
  // a selfie on an event day with a wrong image produced five failed attempts and then an
  // empty gallery with an error, on the one screen the participant is watching.
  assert.equal(await db.findGalleryByUser(participant.id, event.id), null);
  assert.ok(await objects.get(selfieKey), "the selfie is still there for the retry");

  // And the moment the gate is not there, both jobs ARE claimed — so what the assertions
  // above measure is the gate, not an empty queue. (They then fail inside the handler,
  // which is the point: this is the work that used to burn five attempts each.)
  const ungated: WorkerDeps = { ...deps, faceGate: undefined };
  assert.equal(await pollOnce(ungated), true, "without the gate the index job is claimed");
  assert.equal(await pollOnce(ungated), true, "without the gate the match job is claimed");
  assert.deepEqual(
    embedCalls,
    { photo: 1, selfie: 1 },
    "both jobs posted to /v1/embed once the gate was gone — that is the 422 the gate prevents",
  );
});
