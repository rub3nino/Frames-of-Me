// Frames of Me — face pipeline throughput benchmark (v6 F1).
//
// Answers the one number the whole production deployment is sized from and that had never been
// measured: how many photos per hour does one host take through derive -> index -> attach with
// detection on a 2560 px long edge?
//
//   node --env-file=.env --import tsx scripts/bench/index-throughput.ts \
//     --dir /data/photos-campione --photos 200 --concurrency 4 --json bench.json
//
// It drives the REAL pipeline: the same `scripts/ingest` upload path, then the real worker loop
// (apps/worker/src/loop.ts) with the real handlers, the real face engine and the real face
// service. Nothing is stubbed, so the numbers are the numbers api/worker would produce.
//
// See scripts/bench/README.md for how to run it on the production host, and
// docs/face-throughput.md for the measurement that shipped with v6.
//
// What it reports:
//   - photos/hour, from the wall clock of the queue drain (the figure to size the host with)
//   - per job type: count, p50, p95, p99, max, and the outcome breakdown (done/retry/requeued/error)
//   - faces detected per photo (detection cost scales with it)
//   - CPU and RSS of the face-service container (docker stats) and of this process
//
// It never touches an existing event: it creates `--event` (default `bench-throughput`) and, with
// `--cleanup`, deletes it and its objects again at the end.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "@rephoto/api/env";
import { loadFaceEngine } from "@rephoto/api/face";
import { createMailer } from "@rephoto/api/mailer";
import { createS3ObjectStore } from "@rephoto/api/objects";
import { createQueue } from "@rephoto/api/queue";
import { jobDedupeKey, objectKeys } from "@rephoto/contracts";
import { createSql, DuplicateKeyError, migrate, PostgresDatabase } from "@rephoto/db";
// `@rephoto/worker` publishes no `exports` map, so the loop and its types are imported by path.
import type { JobLogEntry, WorkerDeps } from "../../apps/worker/src/handlers.ts";
import { runWorkerLoop } from "../../apps/worker/src/loop.ts";

const HELP = `Frames of Me face pipeline throughput benchmark (v6 F1).

Usage:
  node --env-file=.env --import tsx scripts/bench/index-throughput.ts [options]

Photo source (one of; --dir is strongly preferred):
  --dir <path>            Folder of real event photos, scanned recursively (.jpg/.jpeg/.png).
                          Reused cyclically when --photos exceeds the file count; every copy gets
                          random bytes appended after the JPEG EOI, so the sha256 differs and the
                          pixels (and therefore the faces) stay identical.
  --source <file>         A single image, used for every photo. Same byte trick.
                          Without either, scripts/loadtest/fixtures/sample.jpg is used and the run
                          is flagged UNREPRESENTATIVE: it is 640x480 with no face, so detection
                          does a fraction of the work a 24 MP hall photo costs.

Options:
  --photos <n>            Photos to push through the pipeline (default 100).
  --concurrency <n>       Jobs in flight, i.e. WORKER_CONCURRENCY (default: env, else 4).
  --event <slug>          Event to create and use (default bench-throughput).
  --warmup <n>            Photos processed and discarded from the statistics before the measured
                          run, so the first-call model load does not skew p50 (default 3).
  --face-container <name> Container to read CPU/RAM from with \`docker stats\`
                          (default: autodetect a running *face-service* container).
  --json <file>           Write the full result, including every job sample, as JSON.
  --cleanup               Delete the event, its photos and its objects at the end.
  --keep-queue            Do not fail when the queue already holds jobs from another run.
  --help                  This text.

Environment: the same names as api/worker (.env). FACE_ENGINE must be a real engine
(\`insightface\`, or \`rekognition\`); with FACE_ENGINE=fake the run aborts, because measuring the
fake engine measures nothing. FACE_DETECT_LONG_EDGE is reported and should be 2560 for the v6
figure. The face service's own DET_SIZE / DET_LONG_EDGE / UVICORN_WORKERS / MODEL_CONCURRENCY are
read from its /health and reported too: they belong in the note next to the number.
`;

type Options = {
  dir: string | null;
  source: string | null;
  photos: number;
  concurrency: number | null;
  event: string;
  warmup: number;
  faceContainer: string | null;
  json: string | null;
  cleanup: boolean;
  keepQueue: boolean;
};

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const FALLBACK_IMAGE = "scripts/loadtest/fixtures/sample.jpg";

function parseOptions(argv: string[]): Options | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      source: { type: "string" },
      photos: { type: "string", default: "100" },
      concurrency: { type: "string" },
      event: { type: "string", default: "bench-throughput" },
      warmup: { type: "string", default: "3" },
      "face-container": { type: "string" },
      json: { type: "string" },
      cleanup: { type: "boolean", default: false },
      "keep-queue": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) return null;
  const photos = Number(values.photos);
  const warmup = Number(values.warmup);
  if (!Number.isInteger(photos) || photos < 1) throw new Error("--photos must be a positive integer");
  if (!Number.isInteger(warmup) || warmup < 0) throw new Error("--warmup must be 0 or more");
  return {
    dir: values.dir ?? null,
    source: values.source ?? null,
    photos,
    concurrency: values.concurrency === undefined ? null : Number(values.concurrency),
    event: values.event as string,
    warmup,
    faceContainer: values["face-container"] ?? null,
    json: values.json ?? null,
    cleanup: values.cleanup === true,
    keepQueue: values["keep-queue"] === true,
  };
}

// ------------------------------------------------------------------ statistics

/** Nearest-rank percentile on an ascending copy; `samples` must not be empty. */
function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] as number;
}

type JobStats = {
  type: string;
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  outcomes: Record<string, number>;
};

function summarise(entries: JobLogEntry[]): JobStats[] {
  const byType = new Map<string, JobLogEntry[]>();
  for (const entry of entries) {
    const bucket = byType.get(entry.type);
    if (bucket) bucket.push(entry);
    else byType.set(entry.type, [entry]);
  }
  const stats: JobStats[] = [];
  for (const [type, bucket] of byType) {
    // Only successful jobs go into the latency distribution: a `requeued` job did no work, and a
    // `retry`/`error` measures a failure, not the pipeline's speed. The outcomes are reported
    // separately so a run with failures cannot be mistaken for a clean one.
    const done = bucket.filter((entry) => entry.outcome === "done").map((entry) => entry.ms);
    const outcomes: Record<string, number> = {};
    for (const entry of bucket) outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
    stats.push({
      type,
      count: bucket.length,
      p50: done.length ? percentile(done, 0.5) : 0,
      p95: done.length ? percentile(done, 0.95) : 0,
      p99: done.length ? percentile(done, 0.99) : 0,
      max: done.length ? Math.max(...done) : 0,
      mean: done.length ? done.reduce((sum, ms) => sum + ms, 0) / done.length : 0,
      outcomes,
    });
  }
  return stats.sort((a, b) => a.type.localeCompare(b.type));
}

// ------------------------------------------------------------------ resource sampling

type ResourceSample = { cpuPercent: number; memBytes: number; at: number };

/** The first running container whose name contains `face-service`. */
async function autodetectFaceContainer(): Promise<string | null> {
  const output = await runCommand("docker", ["ps", "--format", "{{.Names}}"]);
  if (!output.ok) return null;
  const names = output.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return names.find((name) => name.includes("face-service")) ?? null;
}

async function sampleContainer(container: string): Promise<ResourceSample | null> {
  const result = await runCommand("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.CPUPerc}}\t{{.MemUsage}}",
    container,
  ]);
  if (!result.ok) return null;
  const [cpu, mem] = result.stdout.trim().split("\t");
  if (!cpu || !mem) return null;
  const cpuPercent = Number(cpu.replace("%", ""));
  // "1.234GiB / 4GiB" -> the used side.
  const used = mem.split("/")[0]?.trim() ?? "";
  const memBytes = parseBytes(used);
  if (!Number.isFinite(cpuPercent) || memBytes === null) return null;
  return { cpuPercent, memBytes, at: Date.now() };
}

function parseBytes(text: string): number | null {
  const match = /^([\d.]+)\s*([KMGT]?i?)B$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? "").toUpperCase();
  const scale: Record<string, number> = {
    "": 1,
    K: 1000,
    KI: 1024,
    M: 1000 ** 2,
    MI: 1024 ** 2,
    G: 1000 ** 3,
    GI: 1024 ** 3,
    T: 1000 ** 4,
    TI: 1024 ** 4,
  };
  const factor = scale[unit];
  return factor === undefined || !Number.isFinite(value) ? null : value * factor;
}

async function runCommand(
  command: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolve({ ok: false, stdout, stderr }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

// ------------------------------------------------------------------ photo source

type SourceImage = { name: string; bytes: Buffer; contentType: "image/jpeg" | "image/png" };

async function loadSourceImages(options: Options): Promise<{ images: SourceImage[]; representative: boolean }> {
  if (options.dir) {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path);
      }
    };
    await walk(options.dir);
    if (files.length === 0) throw new Error(`no .jpg/.jpeg/.png under ${options.dir}`);
    files.sort();
    const images: SourceImage[] = [];
    for (const path of files) images.push(await readImage(path));
    return { images, representative: true };
  }
  if (options.source) return { images: [await readImage(options.source)], representative: true };
  return { images: [await readImage(FALLBACK_IMAGE)], representative: false };
}

async function readImage(path: string): Promise<SourceImage> {
  const bytes = await readFile(path);
  const extension = extname(path).toLowerCase();
  return {
    name: path,
    bytes,
    contentType: extension === ".png" ? "image/png" : "image/jpeg",
  };
}

/**
 * A byte-unique copy of `image`: random bytes appended AFTER the JPEG EOI / PNG IEND, so decoders
 * ignore them and the pixels (and the faces) are identical while the sha256 differs. Same trick as
 * `scripts/ingest --synth`; it is what lets one sample photo stand in for N uploads without the
 * `unique (event_id, sha256)` dedup rejecting them.
 */
function uniqueCopy(image: SourceImage, index: number): Buffer {
  const salt = Buffer.alloc(16);
  salt.writeUInt32BE(index, 0);
  salt.write(randomUUID().replace(/-/g, "").slice(0, 24), 4, "hex");
  return Buffer.concat([image.bytes, salt]);
}

// ------------------------------------------------------------------ main

const options = (() => {
  try {
    return parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n`);
    console.error(HELP);
    process.exit(64);
  }
})();
if (!options) {
  console.log(HELP);
  process.exit(0);
}

const env = loadEnv();
if (env.FACE_ENGINE === "fake") {
  console.error(
    "FACE_ENGINE=fake: this benchmark would measure the fake engine, not the face service.\n" +
      "Set FACE_ENGINE=insightface (and FACE_SERVICE_URL) and run again.",
  );
  process.exit(2);
}

const concurrency = options.concurrency ?? env.WORKER_CONCURRENCY;
if (!Number.isInteger(concurrency) || concurrency < 1) {
  console.error("--concurrency must be a positive integer");
  process.exit(64);
}

const sql = createSql(env.DATABASE_URL, { max: Math.max(4, concurrency + 2) });
await migrate(sql);
const db = new PostgresDatabase(sql);
const objects = createS3ObjectStore(env);

// The face service's own configuration belongs next to the number: the same host answers very
// differently at DET_LONG_EDGE 1600 and 2560.
let faceServiceHealth: unknown = null;
if (env.FACE_ENGINE === "insightface") {
  const url = `${env.FACE_SERVICE_URL.replace(/\/+$/, "")}/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    faceServiceHealth = await response.json();
  } catch (error) {
    console.error(`face service unreachable at ${url}: ${(error as Error).message}`);
    console.error("Start it (docker compose up -d face-service) and run again.");
    await sql.end({ timeout: 2 });
    process.exit(2);
  }
}

const queued = await db.metrics();
if (queued.jobsQueued > 0 && !options.keepQueue) {
  console.error(
    `the queue already holds ${queued.jobsQueued} job(s): this run would measure them too.\n` +
      "Drain it, or pass --keep-queue to accept the contamination.",
  );
  await sql.end({ timeout: 2 });
  process.exit(2);
}

const { images, representative } = await loadSourceImages(options);
if (!representative) {
  console.warn(
    `\n!! UNREPRESENTATIVE RUN: no --dir/--source, falling back to ${FALLBACK_IMAGE} (640x480, no\n` +
      "!! face). Detection does a fraction of the work a 24 MP hall photo costs, so the photos/hour\n" +
      "!! below is an UPPER BOUND and must not be used to size the host. Re-run with --dir.\n",
  );
}

// ------------------------------------------------------------------ fixture

let event = await db.findEventBySlug(options.event);
if (!event) {
  event = await db.createEvent({ slug: options.event, name: "Benchmark throughput" });
  console.log(`created event ${event.slug} (${event.id})`);
} else {
  console.log(`reusing event ${event.slug} (${event.id})`);
}
const photographerEmail = `bench@${options.event}.local`;
let photographer = await db.findUserByEmailRole(photographerEmail, "photographer");
if (!photographer) photographer = await db.createUser({ email: photographerEmail, role: "photographer" });
await db.addEventPhotographer(event.id, photographer.id);

/**
 * Uploads one photo and enqueues its `derive`, leaving exactly what
 * `POST /v1/uploads/complete` leaves (same as `scripts/ingest`). The object goes through the
 * application's own ObjectStore, so the benchmark also exercises the real S3 credentials.
 */
async function ingestOne(index: number): Promise<string | null> {
  const image = images[index % images.length] as SourceImage;
  const bytes = uniqueCopy(image, index);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const photoId = randomUUID();
  const originalKey = objectKeys.original(event!.id, photoId);
  await objects.put(originalKey, bytes, image.contentType);
  try {
    await db.insertPhoto({
      id: photoId,
      eventId: event!.id,
      photographerId: photographer!.id,
      sha256,
      originalKey,
      contentType: image.contentType,
      bytes: bytes.byteLength,
      originalStatus: "present",
      filename: `bench-${index}.jpg`,
      tags: ["bench"],
    });
  } catch (error) {
    if (!(error instanceof DuplicateKeyError)) throw error;
    // Same bytes landed first: the object just written is unreferenced, so drop it.
    await objects.delete(originalKey).catch(() => undefined);
    return null;
  }
  const dedupeKey = jobDedupeKey("derive", { photoId });
  await db.enqueueJob("derive", { photoId }, dedupeKey ? { dedupeKey } : {});
  return photoId;
}

/** Pushes `count` photos through the full pipeline and returns the job log plus the wall clock. */
async function drain(count: number, label: string): Promise<{ entries: JobLogEntry[]; ms: number }> {
  const entries: JobLogEntry[] = [];
  const deps: WorkerDeps = {
    env: { ...env, WORKER_CONCURRENCY: concurrency },
    db,
    objects,
    mailer: createMailer(env),
    queue: createQueue(db),
    faces: loadFaceEngine(env),
    log: (entry) => {
      entries.push(entry);
      if (entries.length % 25 === 0) {
        process.stdout.write(`  ${label}: ${entries.length} jobs done\r`);
      }
    },
  };
  const ingested: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = await ingestOne(ingestOffset + index);
    if (id) ingested.push(id);
  }
  ingestOffset += count;
  console.log(`  ${label}: ${ingested.length} photos uploaded, draining the queue...`);

  // Stopping is decided ONLY by the once-a-second poller, never by how often the loop happens to
  // call `stop`: the loop polls it in a tight claim loop, so counting calls would end the run in
  // milliseconds. The poller requires DRAIN_CONFIRMATIONS consecutive one-second samples with an
  // empty queue and nothing running, which for this benchmark means every derive -> index ->
  // attach chain has finished (each job enqueues the next, so a momentarily empty queue with a
  // job still in flight must not count as drained -- hence `jobsRunning` is checked too).
  drained = false;
  emptyStreak = 0;
  const started = Date.now();
  await runWorkerLoop(deps, {
    concurrency,
    idleMs: 200,
    shutdownMs: 120_000,
    stop: () => drained,
  });
  return { entries, ms: Date.now() - started };
}

let ingestOffset = 0;
/** Consecutive one-second samples with an empty queue needed before the drain is called done. */
const DRAIN_CONFIRMATIONS = 3;
let emptyStreak = 0;
let drained = false;
const resourceSamples: ResourceSample[] = [];
const faceContainer = options.faceContainer ?? (await autodetectFaceContainer());
if (faceContainer) console.log(`reading CPU/RAM from container ${faceContainer}`);
else console.warn("no face-service container found: CPU/RAM of the face service will be absent");

// One poller for both the stop condition and the resource samples.
const poller = setInterval(() => {
  void (async () => {
    try {
      const metrics = await db.metrics();
      if (metrics.jobsQueued === 0 && metrics.jobsRunning === 0) emptyStreak += 1;
      else emptyStreak = 0;
      if (emptyStreak >= DRAIN_CONFIRMATIONS) drained = true;
    } catch {
      // A transient database error must not end the run: keep the streak as it was.
    }
    if (faceContainer) {
      const sample = await sampleContainer(faceContainer);
      if (sample) resourceSamples.push(sample);
    }
  })();
}, 1000);
poller.unref();

const cpuBefore = process.cpuUsage();
if (options.warmup > 0) {
  console.log(`warmup: ${options.warmup} photos (discarded from the statistics)`);
  await drain(options.warmup, "warmup");
  resourceSamples.length = 0;
}

console.log(`measured run: ${options.photos} photos, concurrency ${concurrency}`);
const measuredStart = Date.now();
const measured = await drain(options.photos, "run");
const wallMs = Date.now() - measuredStart;
clearInterval(poller);
const cpuAfter = process.cpuUsage(cpuBefore);

// ------------------------------------------------------------------ report

const stats = summarise(measured.entries);
const indexed = measured.entries.filter((entry) => entry.type === "index" && entry.outcome === "done");
const photosPerHour = wallMs > 0 ? (indexed.length / wallMs) * 3_600_000 : 0;
const facesTotal = await sql<{ faces: number }[]>`
  select count(*)::int as faces from faces f
  join photos p on p.id = f.photo_id where p.event_id = ${event.id}
`;
const facesPerPhoto = indexed.length > 0 ? (facesTotal[0]?.faces ?? 0) / indexed.length : 0;

const cpuSamples = resourceSamples.map((sample) => sample.cpuPercent);
const memSamples = resourceSamples.map((sample) => sample.memBytes);

const report = {
  measuredAt: new Date().toISOString(),
  representative,
  source: options.dir ?? options.source ?? FALLBACK_IMAGE,
  sourceImages: images.length,
  photos: options.photos,
  concurrency,
  env: {
    FACE_ENGINE: env.FACE_ENGINE,
    FACE_DETECT_LONG_EDGE: env.FACE_DETECT_LONG_EDGE,
    FACE_INDEX_SOURCE: env.FACE_INDEX_SOURCE,
    FACE_INDEX_TPS: env.FACE_INDEX_TPS,
    INSIGHTFACE_MAX_FACES: env.INSIGHTFACE_MAX_FACES,
    INSIGHTFACE_MIN_FACE_QUALITY: env.INSIGHTFACE_MIN_FACE_QUALITY,
  },
  faceServiceHealth,
  wallMs,
  photosIndexed: indexed.length,
  photosPerHour: Math.round(photosPerHour),
  facesPerPhoto: Number(facesPerPhoto.toFixed(2)),
  jobs: stats,
  faceService: faceContainer
    ? {
        container: faceContainer,
        samples: resourceSamples.length,
        cpuPercentP50: cpuSamples.length ? percentile(cpuSamples, 0.5) : null,
        cpuPercentMax: cpuSamples.length ? Math.max(...cpuSamples) : null,
        memBytesP50: memSamples.length ? percentile(memSamples, 0.5) : null,
        memBytesMax: memSamples.length ? Math.max(...memSamples) : null,
      }
    : null,
  benchProcess: {
    cpuUserMs: Math.round(cpuAfter.user / 1000),
    cpuSystemMs: Math.round(cpuAfter.system / 1000),
    rssBytes: process.memoryUsage().rss,
  },
  samples: measured.entries,
};

const mib = (bytes: number | null): string =>
  bytes === null ? "n/a" : `${(bytes / 1024 ** 2).toFixed(0)} MiB`;

console.log("");
console.log("================ Frames of Me face pipeline throughput ================");
console.log(`measured at          ${report.measuredAt}`);
console.log(`source               ${report.source} (${report.sourceImages} distinct image(s))`);
if (!representative) console.log("representative       NO -- upper bound only, see the warning above");
console.log(`engine               ${env.FACE_ENGINE}, detection long edge ${env.FACE_DETECT_LONG_EDGE} px`);
console.log(`index source         ${env.FACE_INDEX_SOURCE}`);
if (faceServiceHealth) console.log(`face service         ${JSON.stringify(faceServiceHealth)}`);
console.log(`concurrency          ${concurrency} jobs in flight`);
console.log("");
console.log(`photos indexed       ${report.photosIndexed} / ${options.photos}`);
console.log(`wall clock           ${(wallMs / 1000).toFixed(1)} s`);
console.log(`THROUGHPUT           ${report.photosPerHour} photos/hour`);
console.log(`faces per photo      ${report.facesPerPhoto}`);
console.log("");
console.log("per job type (ms, successful jobs only)");
console.log("  type      count      p50      p95      p99      max     mean   outcomes");
for (const stat of stats) {
  const outcomes = Object.entries(stat.outcomes)
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
  console.log(
    `  ${stat.type.padEnd(9)} ${String(stat.count).padStart(5)} ` +
      `${String(stat.p50).padStart(8)} ${String(stat.p95).padStart(8)} ` +
      `${String(stat.p99).padStart(8)} ${String(stat.max).padStart(8)} ` +
      `${stat.mean.toFixed(0).padStart(8)}   ${outcomes}`,
  );
}
console.log("");
if (report.faceService) {
  console.log(
    `face service CPU     p50 ${report.faceService.cpuPercentP50}% max ${report.faceService.cpuPercentMax}% ` +
      `(${report.faceService.samples} samples of ${report.faceService.container})`,
  );
  console.log(
    `face service RAM     p50 ${mib(report.faceService.memBytesP50)} max ${mib(report.faceService.memBytesMax)}`,
  );
} else {
  console.log("face service CPU/RAM not measured (no container)");
}
console.log(
  `bench process        CPU ${report.benchProcess.cpuUserMs} ms user + ` +
    `${report.benchProcess.cpuSystemMs} ms sys, RSS ${mib(report.benchProcess.rssBytes)}`,
);
console.log("==================================================================");

if (options.json) {
  await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`full result (including every job sample) written to ${options.json}`);
}

if (options.cleanup) {
  console.log("cleanup: deleting the bench event, its photos and its objects");
  const keys = await sql<{ original_key: string; id: string }[]>`
    select original_key, id from photos where event_id = ${event.id}
  `;
  for (const row of keys) {
    for (const key of [row.original_key, objectKeys.web(row.id), objectKeys.thumb(row.id)]) {
      await objects.delete(key).catch(() => undefined);
    }
  }
  await sql`delete from events where id = ${event.id}`;
  await sql`delete from users where id = ${photographer.id}`;
  console.log(`cleanup: removed ${keys.length} photos`);
}

await sql.end({ timeout: 5 });
