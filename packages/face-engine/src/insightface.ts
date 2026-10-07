import postgres from "postgres";
import type {
  Box,
  EmbedSelfieInput,
  EmbedSelfieResult,
  FaceEngine,
  ImageContentType,
  IndexedFace,
  IndexPhotoInput,
  LivenessInput,
  LivenessResult,
  SearchByVectorInput,
  SearchFacesInput,
  SearchHit,
  SearchInput,
  VectorHit,
} from "./types.ts";

export const DEFAULT_FACE_SERVICE_URL = "http://localhost:8090";
export const DEFAULT_MIN_COSINE = 0.5;
export const DEFAULT_SURE_COSINE = 0.7;
export const DEFAULT_SEARCH_MAX_FACES = 200;
export const DEFAULT_MIN_FACE_QUALITY = 0.2;
/** Faces asked of the service per indexed photo (`INSIGHTFACE_INDEX_MAX_FACES`); the service caps at 150. */
export const DEFAULT_INDEX_MAX_FACES = 100;
const INDEX_MAX_FACES_CAP = 150;
/** Smallest face (pixels on the detection image) the service is asked to return. */
export const INDEX_MIN_FACE_SIZE = 24;
/** `search` returns at most this many rows whatever the env says. */
const SEARCH_MAX_FACES_CAP = 4096;
/** Embed and search round trips are abandoned after this; the worker requeues the job. */
export const EMBED_TIMEOUT_MS = 60_000;
export const HEALTH_TIMEOUT_MS = 10_000;
const DELETE_FACES_CHUNK = 1000;
/** HNSW candidate list: never below 100, at least the requested limit. */
const MIN_EF_SEARCH = 100;
const EMBEDDING_DIMENSIONS = 512;
/** The service accepts up to 8 MiB; refuse larger bodies before the round trip. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const POOL_MAX = 4;
const TABLE_NAME = "face_vectors";

/**
 * The face service is down, unreachable or answered 5xx. The worker retries
 * the job like any other error. The message never includes image bytes.
 */
export class FaceServiceUnavailable extends Error {
  constructor(message = "Face service unavailable") {
    super(message);
    this.name = "FaceServiceUnavailable";
  }
}

/** A definitive answer from the face service that is not "no faces" (413, 422, ...). */
export class FaceServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FaceServiceError";
    this.status = status;
  }
}

/** `face_vectors` is absent and the engine could not create the pgvector extension itself. */
export class FaceVectorsTableMissing extends Error {
  constructor(databaseHint: string) {
    super(
      `Table ${TABLE_NAME} is missing${databaseHint}. FACE_ENGINE=insightface needs the pgvector ` +
        "extension: run Postgres from the pgvector/pgvector:pg16 image (or install the extension); " +
        "the engine then creates the table itself at first use.",
    );
    this.name = "FaceVectorsTableMissing";
  }
}

/** Shape of one face as the face service returns it from `POST /v1/embed`. */
export interface ServiceFace {
  bbox: Box;
  score: number;
  quality: number;
  embedding: number[];
}

export interface EmbedResponse {
  width: number;
  height: number;
  faces: ServiceFace[];
}

type Row = Record<string, unknown>;

/**
 * The slice of the `postgres` client the engine uses, so tests can stub it.
 * `unsafe` runs a text query with positional parameters; `begin` runs the
 * callback in one transaction (needed for `set local`).
 */
export interface VectorSql {
  unsafe(query: string, params?: unknown[]): Promise<Row[]>;
  begin<T>(fn: (tx: VectorSql) => Promise<T>): Promise<T>;
  end?(): Promise<void>;
}

export interface InsightFaceEngineOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected database client; otherwise one is opened lazily from `DATABASE_URL`. */
  sql?: VectorSql;
  /** Injected HTTP client; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const clients = new Map<string, VectorSql>();

/**
 * Face engine backed by the InsightFace HTTP service (`apps/face-service`) for
 * embeddings and by Postgres + pgvector for storage and nearest-neighbour
 * search. Cosine similarity is mapped to the 0–100 scale the rest of the
 * system expects: `MIN` ↔ 80, `SURE` ↔ 100, pairs below `MIN` are dropped.
 * Image bytes are sent to the service only and never logged.
 */
export class InsightFaceEngine implements FaceEngine {
  readonly serviceUrl: string;
  readonly minCosine: number;
  readonly sureCosine: number;
  readonly searchMaxFaces: number;
  readonly indexMaxFaces: number;
  readonly minFaceQuality: number;
  private readonly databaseUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private sql: VectorSql | undefined;
  private tableChecked: Promise<void> | undefined;

  constructor(options: InsightFaceEngineOptions = {}) {
    const env = options.env ?? process.env;
    this.serviceUrl = readServiceUrl(env.FACE_SERVICE_URL);
    this.minCosine = readUnit(env.INSIGHTFACE_MIN_COSINE, "INSIGHTFACE_MIN_COSINE", DEFAULT_MIN_COSINE);
    this.sureCosine = readUnit(
      env.INSIGHTFACE_SURE_COSINE,
      "INSIGHTFACE_SURE_COSINE",
      DEFAULT_SURE_COSINE,
    );
    if (this.sureCosine <= this.minCosine) {
      throw new Error("INSIGHTFACE_SURE_COSINE must be greater than INSIGHTFACE_MIN_COSINE");
    }
    this.searchMaxFaces = readSearchMaxFaces(env.INSIGHTFACE_MAX_FACES);
    this.indexMaxFaces = readIndexMaxFaces(env.INSIGHTFACE_INDEX_MAX_FACES);
    this.minFaceQuality = readUnit(
      env.INSIGHTFACE_MIN_FACE_QUALITY,
      "INSIGHTFACE_MIN_FACE_QUALITY",
      DEFAULT_MIN_FACE_QUALITY,
    );
    this.databaseUrl = env.DATABASE_URL;
    this.sql = options.sql;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.sql && !this.databaseUrl) {
      throw new Error("DATABASE_URL is required for FACE_ENGINE=insightface");
    }
  }

  /** Cosine → 0..100 similarity; `undefined` below the minimum. */
  mapSimilarity(cosine: number): number | undefined {
    return mapCosine(cosine, this.minCosine, this.sureCosine);
  }

  /** Verifies that `face_vectors` exists. Called on first use; callable at boot to fail early. */
  async ready(): Promise<void> {
    if (!this.tableChecked) {
      this.tableChecked = this.checkTable().catch((error: unknown) => {
        this.tableChecked = undefined;
        throw error;
      });
    }
    await this.tableChecked;
  }

  /**
   * Embeds the photo and replaces its rows in `face_vectors`: the delete of the photo's
   * previous vectors and the insert run in one transaction, so a re-run (reclaimed job,
   * re-index) never leaves duplicates or orphans (v5, A2).
   */
  async indexPhoto(input: IndexPhotoInput): Promise<IndexedFace[]> {
    const sql = await this.db();
    const embedded = await this.embed(input.imageBytes, input.contentType, this.indexMaxFaces);
    const faces = (embedded?.faces ?? []).filter(
      (face) => isEmbedding(face.embedding) && face.quality >= this.minFaceQuality,
    );
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(DELETE_PHOTO_SQL, [input.photoId]);
      if (faces.length === 0) return [];
      return tx.unsafe(INSERT_FACES_SQL, [
        input.eventId,
        input.photoId,
        faces.map((face) => vectorText(face.embedding)),
      ]);
    });
    if (faces.length === 0) return [];
    if (rows.length !== faces.length) {
      throw new Error(`face_vectors insert returned ${rows.length} rows for ${faces.length} faces`);
    }
    return faces.map((face, index) => ({
      externalFaceId: String(rows[index]?.external_face_id),
      bbox: normalizeBox(face.bbox),
      confidence: clamp(face.score, 0, 1) * 100,
    }));
  }

  async search(input: SearchInput): Promise<SearchHit[]> {
    const sql = await this.db();
    const embedded = await this.embed(input.imageBytes, input.contentType, this.indexMaxFaces);
    if (!embedded) return [];
    // Same shape check as indexPhoto: the vector literal must be 512 finite numbers.
    const largest = largestFace(embedded.faces.filter((face) => isEmbedding(face.embedding)));
    if (!largest) return [];
    return this.nearest(sql, input.eventId, vectorText(largest.embedding), null, {});
  }

  async searchFaces(input: SearchFacesInput): Promise<SearchHit[]> {
    const sql = await this.db();
    const rows = await sql.unsafe(SELECT_VECTOR_SQL, [input.externalFaceId, input.eventId]);
    const stored = rows[0]?.embedding;
    if (typeof stored !== "string") return [];
    return this.nearest(sql, input.eventId, stored, input.externalFaceId, {});
  }

  /**
   * All faces of the selfie with their embeddings, in detection order, plus the pixel
   * size the service worked on. Faces with a malformed embedding are dropped; no quality
   * filter here (the worker decides). `faces: []` for a 400 or an empty answer.
   */
  async embedSelfie(input: EmbedSelfieInput): Promise<EmbedSelfieResult> {
    const embedded = await this.embed(input.imageBytes, input.contentType, this.indexMaxFaces);
    if (!embedded) return { faces: [], width: 0, height: 0 };
    return {
      width: embedded.width,
      height: embedded.height,
      faces: embedded.faces
        .filter((face) => isEmbedding(face.embedding))
        .map((face) => ({
          bbox: normalizeBox(face.bbox),
          score: clamp(face.score, 0, 1),
          quality: clamp(face.quality, 0, 1),
          embedding: [...face.embedding],
        })),
    };
  }

  /** Nearest faces to a raw embedding; `minCosine` may go below the engine's minimum (match log). */
  async searchByVector(input: SearchByVectorInput): Promise<VectorHit[]> {
    if (!isEmbedding(input.embedding)) {
      throw new Error(`searchByVector needs a ${EMBEDDING_DIMENSIONS}-dimensional embedding`);
    }
    const sql = await this.db();
    const hits = await this.nearest(sql, input.eventId, vectorText(input.embedding), null, {
      minCosine: input.minCosine,
      limit: input.maxFaces,
    });
    return hits as VectorHit[];
  }

  async faceEmbedding(input: SearchFacesInput): Promise<number[] | null> {
    const sql = await this.db();
    const rows = await sql.unsafe(SELECT_VECTOR_SQL, [input.externalFaceId, input.eventId]);
    const stored = rows[0]?.embedding;
    if (typeof stored !== "string") return null;
    const parsed = parseVectorText(stored);
    return isEmbedding(parsed) ? parsed : null;
  }

  /** `GET /health` of the face service within {@link HEALTH_TIMEOUT_MS}; false on any failure. */
  async health(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.serviceUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async deleteFaces(eventId: string, externalFaceIds: string[]): Promise<void> {
    if (externalFaceIds.length === 0) return;
    const sql = await this.db();
    for (let start = 0; start < externalFaceIds.length; start += DELETE_FACES_CHUNK) {
      const chunk = externalFaceIds.slice(start, start + DELETE_FACES_CHUNK);
      await sql.unsafe(DELETE_FACES_SQL, [eventId, chunk]);
    }
  }

  async deleteCollection(eventId: string): Promise<void> {
    const sql = await this.db();
    await sql.unsafe(DELETE_EVENT_SQL, [eventId]);
  }

  async checkLiveness(input: LivenessInput): Promise<LivenessResult> {
    const response = await this.post("/v1/liveness", input.imageBytes, input.contentType);
    if (response.status === 400) {
      // Not an image the service can judge; the search will find no face either.
      return { live: true, score: 0, method: "none" };
    }
    if (!response.ok) throw await serviceError(response);
    const body = (await response.json()) as Partial<LivenessResult>;
    return {
      live: body.live !== false,
      score: typeof body.score === "number" ? clamp(body.score, 0, 1) : 0,
      method: typeof body.method === "string" ? body.method : "none",
    };
  }

  /**
   * Nearest neighbours of `vector` in the event, mapped and filtered. Every hit carries
   * the raw cosine. Hits between `minCosine` and the engine's minimum (match log only)
   * get `similarity = 0`: they are never a match, only a record.
   */
  private async nearest(
    sql: VectorSql,
    eventId: string,
    vector: string,
    excludeFaceId: string | null,
    options: { minCosine?: number; limit?: number },
  ): Promise<SearchHit[]> {
    const limit = clampLimit(options.limit ?? this.searchMaxFaces);
    const minCosine = options.minCosine ?? this.minCosine;
    const efSearch = Math.max(MIN_EF_SEARCH, limit);
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`set local hnsw.ef_search = ${efSearch}`);
      return excludeFaceId === null
        ? tx.unsafe(SEARCH_SQL, [vector, eventId, limit])
        : tx.unsafe(SEARCH_EXCLUDING_SQL, [vector, eventId, limit, excludeFaceId]);
    });
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const cosine = Number(row.cos);
      if (!Number.isFinite(cosine) || cosine < minCosine) continue;
      hits.push({
        externalFaceId: String(row.external_face_id),
        photoId: String(row.photo_id),
        similarity: this.mapSimilarity(cosine) ?? 0,
        cosine,
      });
    }
    return hits;
  }

  /** `null` when the service cannot find an image in the bytes (400). */
  private async embed(
    imageBytes: Uint8Array,
    contentType: ImageContentType,
    maxFaces: number,
  ): Promise<EmbedResponse | null> {
    const query = `?max_faces=${maxFaces}&min_size=${INDEX_MIN_FACE_SIZE}`;
    const response = await this.post(`/v1/embed${query}`, imageBytes, contentType);
    if (response.status === 400) return null;
    if (!response.ok) throw await serviceError(response);
    const body = (await response.json()) as Partial<EmbedResponse>;
    const faces = Array.isArray(body.faces) ? body.faces : [];
    return {
      width: Number(body.width ?? 0),
      height: Number(body.height ?? 0),
      faces: faces.filter(isServiceFace),
    };
  }

  private async post(
    path: string,
    imageBytes: Uint8Array,
    contentType: ImageContentType,
  ): Promise<Response> {
    if (imageBytes.byteLength > MAX_IMAGE_BYTES) {
      throw new FaceServiceError(413, "Image exceeds the face service limit of 8 MiB");
    }
    const form = new FormData();
    form.append(
      "image",
      new Blob([imageBytes as BlobPart], { type: contentType }),
      contentType === "image/png" ? "image.png" : "image.jpg",
    );
    try {
      return await this.fetchImpl(`${this.serviceUrl}${path}`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
    } catch (error) {
      // Includes the timeout (AbortError / TimeoutError): a slow service is an unavailable one.
      const cause = error instanceof Error ? error.message : String(error);
      throw new FaceServiceUnavailable(
        `Face service at ${this.serviceUrl} unreachable: ${cause.slice(0, 200)}`,
      );
    }
  }

  private async db(): Promise<VectorSql> {
    await this.ready();
    return this.resolveSql();
  }

  private resolveSql(): VectorSql {
    if (!this.sql) {
      this.sql = clientFor(this.databaseUrl as string);
    }
    return this.sql;
  }

  /**
   * Self-healing schema: when `face_vectors` is missing (migration 005 ran on a
   * Postgres without pgvector), create the extension and the same DDL as 005 in
   * one transaction. Only a failing `create extension` is fatal.
   */
  private async checkTable(): Promise<void> {
    const sql = this.resolveSql();
    const rows = await sql.unsafe(TABLE_EXISTS_SQL);
    if (rows[0]?.present === true) return;
    const hint = this.databaseUrl ? ` in ${redactUrl(this.databaseUrl)}` : "";
    await sql.begin(async (tx) => {
      try {
        await tx.unsafe(CREATE_EXTENSION_SQL);
      } catch {
        throw new FaceVectorsTableMissing(hint);
      }
      for (const statement of FACE_VECTORS_DDL) await tx.unsafe(statement);
    });
  }
}

// --- SQL (documented in CONTRACTS.md) -------------------------------------

/** One row per face; the input text[] of vector literals is expanded in order. */
export const INSERT_FACES_SQL = `
insert into face_vectors (event_id, photo_id, embedding)
select $1::uuid, $2::uuid, input.embedding::vector
from unnest($3::text[]) with ordinality as input(embedding, ord)
order by input.ord
returning external_face_id`;

/** Nearest neighbours of a query vector within one event (cosine distance, HNSW). */
export const SEARCH_SQL = `
select external_face_id, photo_id, 1 - (embedding <=> $1::vector) as cos
from face_vectors
where event_id = $2::uuid
order by embedding <=> $1::vector
limit $3`;

/** Same as {@link SEARCH_SQL}, minus the face whose vector is being searched. */
export const SEARCH_EXCLUDING_SQL = `
select external_face_id, photo_id, 1 - (embedding <=> $1::vector) as cos
from face_vectors
where event_id = $2::uuid and external_face_id <> $4::uuid
order by embedding <=> $1::vector
limit $3`;

export const SELECT_VECTOR_SQL = `
select embedding::text as embedding
from face_vectors
where external_face_id = $1::uuid and event_id = $2::uuid`;

export const DELETE_FACES_SQL = `
delete from face_vectors
where event_id = $1::uuid and external_face_id = any($2::uuid[])`;

/** Run before every insert of a photo's faces (re-index, reclaimed job): no duplicates. */
export const DELETE_PHOTO_SQL = `
delete from face_vectors
where photo_id = $1::uuid`;

export const DELETE_EVENT_SQL = `
delete from face_vectors
where event_id = $1::uuid`;

export const TABLE_EXISTS_SQL = `select to_regclass('public.face_vectors') is not null as present`;

export const CREATE_EXTENSION_SQL = `create extension if not exists vector`;

/**
 * Same DDL as migrations 005_face_vectors.sql + 006_recognition.sql (the face_vectors part),
 * run by the engine when the table is missing. The foreign key is added only when `photos`
 * exists (it always does once the migrations ran).
 */
export const FACE_VECTORS_DDL: readonly string[] = [
  `create table if not exists face_vectors (
  external_face_id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  photo_id uuid not null,
  embedding vector(512) not null,
  created_at timestamptz not null default now()
)`,
  `create index if not exists face_vectors_event_idx on face_vectors (event_id)`,
  `create index if not exists face_vectors_photo_idx on face_vectors (photo_id)`,
  `create index if not exists face_vectors_embedding_idx on face_vectors using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)`,
  `do $$
begin
  if to_regclass('public.photos') is not null
     and not exists (select 1 from pg_constraint where conname = 'face_vectors_photo_id_fkey') then
    alter table face_vectors
      add constraint face_vectors_photo_id_fkey
      foreign key (photo_id) references photos(id) on delete cascade;
  end if;
end
$$`,
];

// --- helpers ---------------------------------------------------------------

/**
 * `similarity = 80 + 20 × clamp((c − MIN) / (SURE − MIN), 0, 1)` for `c ≥ MIN`;
 * below `MIN` the pair is not a match (`undefined`).
 */
export function mapCosine(cosine: number, minCosine: number, sureCosine: number): number | undefined {
  if (!Number.isFinite(cosine) || cosine < minCosine) return undefined;
  const t = clamp((cosine - minCosine) / (sureCosine - minCosine), 0, 1);
  return 80 + 20 * t;
}

/** pgvector text literal: `[0.1,0.2,...]`. */
export function vectorText(embedding: readonly number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Inverse of {@link vectorText}; non-numeric parts become NaN (callers validate). */
export function parseVectorText(text: string): number[] {
  const inner = text.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner === "") return [];
  return inner.split(",").map((part) => Number(part));
}

/** Cosine similarity of two vectors; 0 when either is empty or zero-length. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

export function largestFace<T extends { bbox: Box }>(faces: readonly T[]): T | undefined {
  let best: T | undefined;
  let bestArea = -1;
  for (const face of faces) {
    const area = Math.max(0, face.bbox.width) * Math.max(0, face.bbox.height);
    if (area > bestArea) {
      best = face;
      bestArea = area;
    }
  }
  return best;
}

function isEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function isServiceFace(value: unknown): value is ServiceFace {
  if (!value || typeof value !== "object") return false;
  const face = value as Partial<ServiceFace>;
  const box = face.bbox;
  return (
    !!box &&
    typeof box === "object" &&
    typeof box.left === "number" &&
    typeof box.top === "number" &&
    typeof box.width === "number" &&
    typeof box.height === "number" &&
    typeof face.score === "number" &&
    typeof face.quality === "number" &&
    Array.isArray(face.embedding)
  );
}

function normalizeBox(box: Box): Box {
  return {
    left: clamp(box.left, 0, 1),
    top: clamp(box.top, 0, 1),
    width: clamp(box.width, 0, 1),
    height: clamp(box.height, 0, 1),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

async function serviceError(response: Response): Promise<Error> {
  if (response.status >= 500) {
    return new FaceServiceUnavailable(`Face service answered ${response.status}`);
  }
  let detail = "";
  try {
    const text = await response.text();
    detail = text.replace(/[^\t\n\r\x20-\x7E]/g, "").slice(0, 200);
  } catch {
    detail = "";
  }
  return new FaceServiceError(
    response.status,
    `Face service answered ${response.status}${detail ? `: ${detail}` : ""}`,
  );
}

function readServiceUrl(raw: string | undefined): string {
  const value = raw === undefined || raw.trim() === "" ? DEFAULT_FACE_SERVICE_URL : raw.trim();
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new Error("FACE_SERVICE_URL must be an http(s) URL");
  }
  return value.replace(/\/+$/, "");
}

function readUnit(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number from 0 to 1`);
  }
  return value;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(SEARCH_MAX_FACES_CAP, Math.floor(limit));
}

function readIndexMaxFaces(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_INDEX_MAX_FACES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > INDEX_MAX_FACES_CAP) {
    throw new Error(`INSIGHTFACE_INDEX_MAX_FACES must be an integer from 1 to ${INDEX_MAX_FACES_CAP}`);
  }
  return value;
}

function readSearchMaxFaces(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SEARCH_MAX_FACES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > SEARCH_MAX_FACES_CAP) {
    throw new Error(`INSIGHTFACE_MAX_FACES must be an integer from 1 to ${SEARCH_MAX_FACES_CAP}`);
  }
  return value;
}

function redactUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    url.password = "";
    url.username = "";
    return url.toString();
  } catch {
    return "the database";
  }
}

/** One lazily created `postgres` client per DATABASE_URL, shared across engine instances. */
function clientFor(databaseUrl: string): VectorSql {
  const existing = clients.get(databaseUrl);
  if (existing) return existing;
  const client = postgres(databaseUrl, {
    max: POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
    onnotice: () => undefined,
  });
  const adapted = adaptSql(client);
  adapted.end = async () => {
    clients.delete(databaseUrl);
    await client.end({ timeout: 5 });
  };
  clients.set(databaseUrl, adapted);
  return adapted;
}

/** Narrows a `postgres` client to {@link VectorSql}. */
export function adaptSql(client: postgres.Sql): VectorSql {
  return {
    async unsafe(query, params = []) {
      const rows = await client.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as Row[];
    },
    begin<T>(fn: (tx: VectorSql) => Promise<T>): Promise<T> {
      return client.begin((tx) => fn(adaptTransaction(tx))) as Promise<T>;
    },
  };
}

/** Inside a transaction a nested `begin` becomes a savepoint. */
function adaptTransaction(tx: postgres.TransactionSql): VectorSql {
  return {
    async unsafe(query, params = []) {
      const rows = await tx.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as Row[];
    },
    begin<T>(fn: (inner: VectorSql) => Promise<T>): Promise<T> {
      return tx.savepoint((inner) => fn(adaptTransaction(inner))) as Promise<T>;
    },
  };
}
