// Frames of Me — server-side bulk importer for the test campaign.
//
//   node --env-file=.env --import tsx scripts/ingest/ingest.ts \
//     --dir /data/photos --event conferenza-2026 --photographer foto1@test.rephoto.local \
//     --parallel 8 --manifest manifest.csv --state ingest.state.jsonl
//
// Writes objects straight into MinIO/S3 and rows straight into Postgres: no HTTP, no presigned
// URLs. Every photo ends up exactly as `POST /v1/uploads/complete` leaves it (apps/api/src/routes.ts):
//   photos (status 'uploaded', original_status 'present', original_key originals/<event>/<photoId>)
//   and one `derive` job with dedupe key derive:<photoId>.
// The worker then runs derive → index → attach as for a browser upload.
//
// See README.md next to this file for the options.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DEFAULT_ALBUM_SLUG, jobDedupeKey, objectKeys } from "@rephoto/contracts";
import { createSql, DuplicateKeyError, PostgresDatabase } from "@rephoto/db";
import type { ImageContentType } from "@rephoto/db";

// ------------------------------------------------------------------ CLI

const HELP = `Frames of Me ingest — import a folder of photos straight into MinIO + Postgres.

Usage:
  node --env-file=.env --import tsx scripts/ingest/ingest.ts --dir <folder> --event <slug> --photographer <email> [options]

Required:
  --dir <path>            Folder scanned recursively for .jpg/.jpeg/.png (and .heic/.heif/.tif/.tiff with --convert)
  --event <slug>          Event slug (must exist; see scripts/seed-test.ts)
  --photographer <email>  Photographer e-mail; created and added to the event when missing

Options:
  --album <slug>          Album of the event the photos land in (default "ufficiale", the
                          official album every event gets from migration 009)
  --parallel <n>          Files in flight at once (default 8)
  --rate <photos/s>       Cap on starts per second (default unlimited)
  --synth <n>             For every real photo also import n synthetic copies: same pixels, random
                          bytes appended after the JPEG EOI / PNG IEND so the sha256 differs
  --state <jsonl>         Resume file: one line per processed file; files already there are skipped
  --manifest <csv>        Append "filename,sha256,photoId,status,bytes,ms" per file (header on create)
  --tags a,b              Tags stored in photos.tags when the column exists (migration 007)
  --convert               HEIC/PNG/TIFF → JPEG quality 92 through sharp (sha256 of the converted bytes)
  --limit <n>             Stop after n files (quick checks)
  --dry-run               Scan, hash and print the plan; no database, no object store
  --help                  This text

Environment (same names as api/worker): DATABASE_URL, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY,
S3_SECRET_KEY, S3_REGION (default eu-central-1), S3_FORCE_PATH_STYLE.

Manifest statuses: uploaded | duplicate (same sha256 already in the SAME album) | error | dry-run.
Dedup is per album since v6 (photos unique (album_id, sha256)): the same bytes may exist once
in the official album and once in a crowd album.
`;

type Options = {
  dir: string;
  event: string;
  photographer: string;
  /** v6: album slug within the event; the official album when not given. */
  album: string;
  parallel: number;
  rate: number | null;
  synth: number;
  state: string | null;
  manifest: string | null;
  tags: string[];
  convert: boolean;
  limit: number | null;
  dryRun: boolean;
};

function parseOptions(argv: string[]): Options | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      event: { type: "string" },
      photographer: { type: "string" },
      album: { type: "string", default: DEFAULT_ALBUM_SLUG },
      parallel: { type: "string", default: "8" },
      rate: { type: "string" },
      synth: { type: "string", default: "0" },
      state: { type: "string" },
      manifest: { type: "string" },
      tags: { type: "string", default: "" },
      convert: { type: "boolean", default: false },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return null;
  }
  const missing = ["dir", "event", "photographer"].filter((name) => !values[name as "dir"]);
  if (missing.length > 0) {
    process.stderr.write(`missing: --${missing.join(", --")}\n\n${HELP}`);
    process.exit(2);
  }
  const int = (raw: string | undefined, name: string, min: number): number | null => {
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min) {
      process.stderr.write(`--${name} must be a number >= ${min}\n`);
      process.exit(2);
    }
    return value;
  };
  return {
    dir: resolve(values.dir as string),
    event: values.event as string,
    photographer: (values.photographer as string).toLowerCase(),
    album: (values.album as string).trim() || DEFAULT_ALBUM_SLUG,
    parallel: Math.max(1, Math.floor(int(values.parallel, "parallel", 1) ?? 8)),
    rate: int(values.rate, "rate", 0.001),
    synth: Math.floor(int(values.synth, "synth", 0) ?? 0),
    state: values.state ? resolve(values.state) : null,
    manifest: values.manifest ? resolve(values.manifest) : null,
    tags: (values.tags as string)
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    convert: Boolean(values.convert),
    limit: int(values.limit, "limit", 1),
    dryRun: Boolean(values["dry-run"]),
  };
}

// ------------------------------------------------------------------ files

const NATIVE_EXT = new Set([".jpg", ".jpeg", ".png"]);
const CONVERT_EXT = new Set([".heic", ".heif", ".tif", ".tiff"]);

async function listFiles(dir: string, convert: boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (NATIVE_EXT.has(ext) || (convert && CONVERT_EXT.has(ext))) out.push(full);
    }
  };
  await walk(dir);
  return out.sort();
}

function sha256Stream(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    createReadStream(path)
      .on("data", (chunk: Buffer | string) => {
        hash.update(chunk);
        bytes += chunk.length;
      })
      .on("error", reject)
      .on("end", () => resolvePromise({ sha256: hash.digest("hex"), bytes }));
  });
}

function sha256Buffer(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sniffContentType(path: string): Promise<ImageContentType | null> {
  const handle = await readFile(path).catch(() => null);
  if (!handle) return null;
  return contentTypeOf(handle);
}

function contentTypeOf(bytes: Uint8Array): ImageContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  return null;
}

/** A copy whose pixels are identical but whose sha256 is new: random bytes after the end marker. */
function synthesize(original: Uint8Array, seed: number): Uint8Array {
  // Decoders stop at EOI (JPEG) / IEND (PNG); anything after is ignored but changes the hash.
  const pad = Buffer.alloc(64 + (seed % 192));
  for (let i = 0; i < pad.length; i += 1) pad[i] = Math.floor(Math.random() * 256);
  return Buffer.concat([Buffer.from(original), pad]);
}

// ------------------------------------------------------------------ state + manifest

type StateLine = { file: string; sha256: string; photoId: string | null; status: string };

async function loadState(path: string | null): Promise<Map<string, StateLine>> {
  const done = new Map<string, StateLine>();
  if (!path) return done;
  const text = await readFile(path, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as StateLine;
      if (parsed.file && parsed.status !== "error") done.set(parsed.file, parsed);
    } catch {
      // A torn last line from a killed run: ignore it, the file will be redone.
    }
  }
  return done;
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function ensureManifest(path: string | null): Promise<void> {
  if (!path) return;
  const exists = await stat(path).then(() => true, () => false);
  if (exists) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "filename,sha256,photoId,status,bytes,ms\n");
}

// ------------------------------------------------------------------ stores

function s3FromEnv(): { client: S3Client; bucket: string } {
  const env = process.env;
  const bucket = env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET is required");
  const credentials =
    env.S3_ACCESS_KEY && env.S3_SECRET_KEY
      ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY }
      : undefined;
  const forcePathStyle =
    env.S3_FORCE_PATH_STYLE === undefined ? Boolean(env.S3_ENDPOINT) : env.S3_FORCE_PATH_STYLE === "true";
  const client = new S3Client({
    region: env.S3_REGION ?? "eu-central-1",
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle,
    ...(credentials ? { credentials } : {}),
  });
  return { client, bucket };
}

type Sharp = typeof import("sharp");

async function loadSharp(): Promise<Sharp> {
  const mod = await import("sharp");
  return (mod.default ?? mod) as Sharp;
}

// ------------------------------------------------------------------ work items

type Item = {
  /** Relative path as recorded in state/manifest; synthetic copies get a `#synthN` suffix. */
  name: string;
  path: string;
  synthIndex: number;
};

type Outcome = {
  name: string;
  sha256: string;
  photoId: string | null;
  status: "uploaded" | "duplicate" | "error" | "dry-run";
  bytes: number;
  ms: number;
  error?: string;
};

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) return;

  const files = await listFiles(options.dir, options.convert);
  if (files.length === 0) {
    console.error(`no images under ${options.dir}`);
    process.exit(1);
  }
  const done = await loadState(options.state);
  const items: Item[] = [];
  for (const path of files) {
    const name = relative(options.dir, path);
    const variants = [{ name, path, synthIndex: 0 }];
    for (let i = 1; i <= options.synth; i += 1) variants.push({ name: `${name}#synth${i}`, path, synthIndex: i });
    for (const variant of variants) {
      if (done.has(variant.name)) continue;
      items.push(variant);
      if (options.limit !== null && items.length >= options.limit) break;
    }
    if (options.limit !== null && items.length >= options.limit) break;
  }
  console.log(
    `${files.length} files under ${options.dir}, ${done.size} already in state, ${items.length} to process` +
      (options.synth > 0 ? ` (synth ×${options.synth})` : "") +
      (options.dryRun ? " [dry-run]" : ""),
  );
  if (items.length === 0) return;
  await ensureManifest(options.manifest);

  // --- dry run: hash + plan only
  if (options.dryRun) {
    const started = Date.now();
    let total = 0;
    for (const item of items) {
      const t0 = Date.now();
      const { sha256, bytes } = await sha256Stream(item.path);
      const contentType = (await sniffContentType(item.path)) ?? "image/jpeg";
      total += bytes;
      const outcome: Outcome = {
        name: item.name,
        sha256: item.synthIndex === 0 ? sha256 : `synth:${sha256.slice(0, 16)}:${item.synthIndex}`,
        photoId: null,
        status: "dry-run",
        bytes,
        ms: Date.now() - t0,
      };
      console.log(`${outcome.status.padEnd(9)} ${item.name}  ${contentType}  ${bytes} B  sha256=${outcome.sha256}`);
      await record(options, outcome);
    }
    console.log(
      `plan: ${items.length} photos, ${(total / 1024 / 1024).toFixed(1)} MiB, event=${options.event}, photographer=${options.photographer}` +
        `, album=${options.album}` +
        (options.convert ? ", convert" : "") +
        (options.tags.length ? `, tags=${options.tags.join(",")}` : "") +
        ` (${((Date.now() - started) / 1000).toFixed(1)} s)`,
    );
    return;
  }

  // --- live run
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sql = createSql(databaseUrl, { max: options.parallel + 2 });
  const db = new PostgresDatabase(sql);
  const { client: s3, bucket } = s3FromEnv();
  const sharp = options.convert ? await loadSharp() : null;

  try {
    const event = await db.findEventBySlug(options.event);
    if (!event) throw new Error(`event not found: ${options.event} (create it with scripts/seed-test.ts)`);
    let photographer = await db.findUserByEmailRole(options.photographer, "photographer");
    if (!photographer) {
      photographer = await db.createUser({ email: options.photographer, role: "photographer" });
      console.log(`created photographer ${photographer.email} (${photographer.id})`);
    }
    await db.addEventPhotographer(event.id, photographer.id);

    // v6: every photo belongs to an album (`photos.album_id`, migration 009) and dedup is
    // per album, so the album is resolved once, up front, and a wrong slug stops the run
    // before a single object is written.
    const album = await db.findAlbumBySlug(event.id, options.album);
    if (!album) {
      throw new Error(
        `album not found: ${options.album} in event ${options.event} ` +
          `(the official album is "${DEFAULT_ALBUM_SLUG}"; create others from the admin console)`,
      );
    }
    if (album.kind === "crowd") {
      console.warn(
        `album ${album.slug} is a crowd album: it never gets face recognition (decision 2)`,
      );
    }

    // photos.filename / photos.tags arrive with migration 007; fill them when present.
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'photos' and column_name in ('filename', 'tags')
    `;
    const hasFilename = columns.some((c) => c.column_name === "filename");
    const hasTags = columns.some((c) => c.column_name === "tags");
    if (options.tags.length > 0 && !hasTags) console.warn("photos.tags column missing (migration 007): --tags ignored");
    const tags = options.tags;

    const started = Date.now();
    let processed = 0;
    let uploaded = 0;
    let duplicates = 0;
    let errors = 0;
    let bytesTotal = 0;
    let nextSlot = Date.now();
    const interval = options.rate ? 1000 / options.rate : 0;

    const processItem = async (item: Item): Promise<Outcome> => {
      const t0 = Date.now();
      const ext = extname(item.path).toLowerCase();
      let body: Uint8Array | null = null;
      let contentType: ImageContentType;
      let sha256: string;
      let bytes: number;

      if (options.convert && (CONVERT_EXT.has(ext) || ext === ".png")) {
        if (!sharp) throw new Error("sharp unavailable");
        body = await sharp(item.path).rotate().jpeg({ quality: 92, mozjpeg: false }).toBuffer();
        contentType = "image/jpeg";
      } else {
        const sniffed = await sniffContentType(item.path);
        if (!sniffed) throw new Error("not a JPEG/PNG (use --convert for HEIC/TIFF)");
        contentType = sniffed;
      }
      if (item.synthIndex > 0) {
        body = synthesize(body ?? (await readFile(item.path)), item.synthIndex * 7919);
      }
      if (body) {
        sha256 = sha256Buffer(body);
        bytes = body.length;
      } else {
        ({ sha256, bytes } = await sha256Stream(item.path));
      }

      const existing = await db.findPhotoByAlbumSha(album.id, sha256);
      if (existing) {
        return { name: item.name, sha256, photoId: existing.id, status: "duplicate", bytes, ms: Date.now() - t0 };
      }

      const photoId = randomUUID();
      const originalKey = objectKeys.original(event.id, photoId);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: originalKey,
          Body: body ?? createReadStream(item.path),
          ContentLength: bytes,
          ContentType: contentType,
        }),
      );
      try {
        await db.insertPhoto({
          id: photoId,
          eventId: event.id,
          photographerId: photographer.id,
          sha256,
          originalKey,
          contentType,
          bytes,
          originalStatus: "present",
          albumId: album.id,
        });
      } catch (error) {
        if (!(error instanceof DuplicateKeyError)) throw error;
        // Same bytes landed first under a parallel slot: the object we wrote is unreferenced.
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: originalKey })).catch(() => undefined);
        const winner = await db.findPhotoByAlbumSha(album.id, sha256);
        return { name: item.name, sha256, photoId: winner?.id ?? null, status: "duplicate", bytes, ms: Date.now() - t0 };
      }
      if (hasFilename || hasTags) {
        const filename = basename(item.name);
        const itemTags = item.synthIndex > 0 ? [...tags, "synth"] : tags;
        if (hasFilename && hasTags) {
          await sql`update photos set filename = ${filename}, tags = ${itemTags} where id = ${photoId}`;
        } else if (hasFilename) {
          await sql`update photos set filename = ${filename} where id = ${photoId}`;
        } else {
          await sql`update photos set tags = ${itemTags} where id = ${photoId}`;
        }
      }
      const dedupeKey = jobDedupeKey("derive", { photoId });
      await db.enqueueJob("derive", { photoId }, dedupeKey ? { dedupeKey } : {});
      return { name: item.name, sha256, photoId, status: "uploaded", bytes, ms: Date.now() - t0 };
    };

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        const item = items[index]!;
        if (interval > 0) {
          const wait = nextSlot - Date.now();
          nextSlot = Math.max(nextSlot, Date.now()) + interval;
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
        let outcome: Outcome;
        try {
          outcome = await processItem(item);
        } catch (error) {
          outcome = {
            name: item.name,
            sha256: "",
            photoId: null,
            status: "error",
            bytes: 0,
            ms: 0,
            error: error instanceof Error ? error.message : String(error),
          };
          console.error(`error ${item.name}: ${outcome.error}`);
        }
        await record(options, outcome);
        processed += 1;
        if (outcome.status === "uploaded") {
          uploaded += 1;
          bytesTotal += outcome.bytes;
        } else if (outcome.status === "duplicate") duplicates += 1;
        else if (outcome.status === "error") errors += 1;
        if (processed % 100 === 0 || processed === items.length) {
          const elapsed = (Date.now() - started) / 1000;
          console.log(
            `${processed}/${items.length}  uploaded=${uploaded} dup=${duplicates} err=${errors}  ` +
              `${(processed / Math.max(elapsed, 0.001)).toFixed(1)} photos/s  ` +
              `${(bytesTotal / 1024 / 1024 / Math.max(elapsed, 0.001)).toFixed(1)} MiB/s  ${elapsed.toFixed(0)} s`,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.parallel, items.length) }, worker));
    const elapsed = (Date.now() - started) / 1000;
    console.log(
      `done: ${uploaded} uploaded, ${duplicates} duplicates, ${errors} errors, ` +
        `${(bytesTotal / 1024 / 1024).toFixed(1)} MiB in ${elapsed.toFixed(1)} s`,
    );
    if (errors > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
    s3.destroy();
  }
}

async function record(options: Options, outcome: Outcome): Promise<void> {
  if (options.state && outcome.status !== "dry-run") {
    const line: StateLine & { error?: string } = {
      file: outcome.name,
      sha256: outcome.sha256,
      photoId: outcome.photoId,
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    await appendFile(options.state, `${JSON.stringify(line)}\n`);
  }
  if (options.manifest) {
    await appendFile(
      options.manifest,
      [outcome.name, outcome.sha256, outcome.photoId, outcome.status, outcome.bytes, outcome.ms]
        .map(csvCell)
        .join(",") + "\n",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
