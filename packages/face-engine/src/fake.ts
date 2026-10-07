import { inflateSync } from "node:zlib";
import type {
  EmbedSelfieInput,
  EmbedSelfieResult,
  FaceEngine,
  ImageContentType,
  IndexedFace,
  IndexPhotoInput,
  SearchByVectorInput,
  SearchFacesInput,
  SearchHit,
  SearchInput,
  VectorHit,
} from "./types.ts";

const FULL_FRAME = { left: 0, top: 0, width: 1, height: 1 } as const;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/**
 * Fake embeddings are one-hot over 512 dimensions: the colour key quantized to 8 levels per
 * channel (`(r>>5)*64 + (g>>5)*8 + (b>>5)`). Two keys in the same bucket have cosine 1, any
 * other pair has cosine 0, so the worker's thresholds behave like with a real engine.
 */
export const FAKE_EMBEDDING_DIMENSIONS = 512;
/** Pixel frame the fake reports for a selfie: large enough for every size gate. */
const FAKE_SELFIE_FRAME = 1024;

export interface FaceIndexRecord {
  externalFaceId: string;
  eventId: string;
  photoId: string;
  r: number;
  g: number;
  b: number;
  /**
   * v6 hardening H4 (agent H): the album this face belongs to (`face_index.album_id`,
   * migration 016). Null only for a row written before that migration — a stored face whose
   * album is unknown is excluded from every album-filtered search rather than matching all
   * of them, because the rule it would break ("a crowd album is never biometric") is a
   * product decision with legal weight, not a default.
   */
  albumId: string | null;
}

export interface FaceIndexStore {
  upsert(record: FaceIndexRecord): Promise<void>;
  findById(externalFaceId: string): Promise<FaceIndexRecord | null>;
  /**
   * `albumIds` is the fake's equivalent of the `album_id = any($n)` filter every real search
   * path carries (v6 A3): undefined = the whole event (v5 behaviour), an empty array = no
   * album to search, which matches nothing.
   */
  findByColor(
    eventId: string,
    r: number,
    g: number,
    b: number,
    albumIds?: readonly string[],
  ): Promise<FaceIndexRecord[]>;
  deleteIds(eventId: string, externalFaceIds: string[]): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;
}

export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

interface PixelSum {
  sumR: number;
  sumG: number;
  sumB: number;
  count: number;
}

interface PgPool {
  query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  on(event: "error", listener: (error: unknown) => void): void;
}

interface PgPoolConstructor {
  new (config: { connectionString: string; max?: number }): PgPool;
}

const pools = new Map<string, PgPool>();

export class MemoryFaceIndexStore implements FaceIndexStore {
  private readonly rows = new Map<string, FaceIndexRecord>();

  async upsert(record: FaceIndexRecord): Promise<void> {
    for (const [id, row] of this.rows) {
      if (row.eventId === record.eventId && row.photoId === record.photoId) {
        this.rows.delete(id);
      }
    }
    this.rows.set(record.externalFaceId, { ...record });
  }

  async findById(externalFaceId: string): Promise<FaceIndexRecord | null> {
    const row = this.rows.get(externalFaceId);
    return row ? { ...row } : null;
  }

  async findByColor(
    eventId: string,
    r: number,
    g: number,
    b: number,
    albumIds?: readonly string[],
  ): Promise<FaceIndexRecord[]> {
    if (albumIds !== undefined && albumIds.length === 0) return [];
    const allowed = albumIds === undefined ? null : new Set(albumIds);
    const hits: FaceIndexRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.eventId !== eventId || row.r !== r || row.g !== g || row.b !== b) continue;
      if (allowed && (row.albumId === null || !allowed.has(row.albumId))) continue;
      hits.push({ ...row });
    }
    return hits;
  }

  async deleteIds(eventId: string, externalFaceIds: string[]): Promise<void> {
    const ids = new Set(externalFaceIds);
    for (const [id, row] of this.rows) {
      if (row.eventId === eventId && ids.has(id)) this.rows.delete(id);
    }
  }

  async deleteEvent(eventId: string): Promise<void> {
    for (const [id, row] of this.rows) {
      if (row.eventId === eventId) this.rows.delete(id);
    }
  }
}

/**
 * Reads and writes `face_index`. If the table is missing (42P01), later calls
 * use an in-memory store for this instance.
 */
export class SqlFaceIndexStore implements FaceIndexStore {
  private readonly memory = new MemoryFaceIndexStore();
  private readonly db: Queryable;
  private useMemory = false;

  constructor(db: Queryable) {
    this.db = db;
  }

  async upsert(record: FaceIndexRecord): Promise<void> {
    await this.run(
      () => this.memory.upsert(record),
      async (db) => {
        await db.query(
          `INSERT INTO face_index (external_face_id, event_id, photo_id, r, g, b, album_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (external_face_id) DO UPDATE SET
             event_id = EXCLUDED.event_id,
             photo_id = EXCLUDED.photo_id,
             r = EXCLUDED.r,
             g = EXCLUDED.g,
             b = EXCLUDED.b,
             album_id = EXCLUDED.album_id`,
          [
            record.externalFaceId,
            record.eventId,
            record.photoId,
            record.r,
            record.g,
            record.b,
            record.albumId,
          ],
        );
      },
    );
  }

  async findById(externalFaceId: string): Promise<FaceIndexRecord | null> {
    return this.run(
      () => this.memory.findById(externalFaceId),
      async (db) => {
        const result = await db.query<FaceIndexSql>(
          `SELECT external_face_id, photo_id, event_id, r, g, b, album_id
           FROM face_index
           WHERE external_face_id = $1`,
          [externalFaceId],
        );
        const row = result.rows[0];
        return row ? mapFaceIndexRow(row) : null;
      },
    );
  }

  async findByColor(
    eventId: string,
    r: number,
    g: number,
    b: number,
    albumIds?: readonly string[],
  ): Promise<FaceIndexRecord[]> {
    if (albumIds !== undefined && albumIds.length === 0) return [];
    return this.run(
      () => this.memory.findByColor(eventId, r, g, b, albumIds),
      async (db) => {
        // `album_id = any($5)` with a null $5 is never true, so the filter is spelled out:
        // undefined = the whole event, a list = those albums only (never a null album).
        const result = await db.query<FaceIndexSql>(
          `SELECT external_face_id, photo_id, event_id, r, g, b, album_id
           FROM face_index
           WHERE event_id = $1 AND r = $2 AND g = $3 AND b = $4
             AND ($5::uuid[] IS NULL OR album_id = ANY($5::uuid[]))`,
          [eventId, r, g, b, albumIds === undefined ? null : [...albumIds]],
        );
        return result.rows.map(mapFaceIndexRow);
      },
    );
  }

  async deleteIds(eventId: string, externalFaceIds: string[]): Promise<void> {
    if (externalFaceIds.length === 0) return;
    await this.run(
      () => this.memory.deleteIds(eventId, externalFaceIds),
      async (db) => {
        await db.query(
          `DELETE FROM face_index
           WHERE event_id = $1 AND external_face_id = ANY($2::text[])`,
          [eventId, externalFaceIds],
        );
      },
    );
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.run(
      () => this.memory.deleteEvent(eventId),
      async (db) => {
        await db.query(`DELETE FROM face_index WHERE event_id = $1`, [eventId]);
      },
    );
  }

  private async run<T>(
    memory: () => Promise<T>,
    query: (db: Queryable) => Promise<T>,
  ): Promise<T> {
    if (this.useMemory) return memory();
    try {
      return await query(this.db);
    } catch (error) {
      if (isUndefinedTable(error)) {
        this.useMemory = true;
        return memory();
      }
      throw sanitizeDbError(error);
    }
  }
}

/**
 * Local adapter. Subject key is the quantized average color (16 levels per channel).
 * `external_face_id` is `fake-${photoId}` (CONTRACTS.md §2.1).
 * Pass a store to tests; otherwise uses Postgres when `DATABASE_URL` is set.
 */
export class FakeFaceEngine implements FaceEngine {
  private readonly store: FaceIndexStore;

  constructor(store?: FaceIndexStore, env: NodeJS.ProcessEnv = process.env) {
    if (store) {
      this.store = store;
    } else if (env.DATABASE_URL) {
      this.store = new SqlFaceIndexStore(createPgQueryable(env.DATABASE_URL));
    } else {
      this.store = new MemoryFaceIndexStore();
    }
  }

  async indexPhoto(input: IndexPhotoInput): Promise<IndexedFace[]> {
    const color = readQuantizedColor(input.imageBytes, input.contentType);
    if (!color) return [];
    const externalFaceId = `fake-${input.photoId}`;
    await this.store.upsert({
      externalFaceId,
      eventId: input.eventId,
      photoId: input.photoId,
      r: color.r,
      g: color.g,
      b: color.b,
      // v6 H4: the worker always passes it (handlers.ts `indexPhoto`); a caller that does
      // not gets a face that no album-filtered search will ever return.
      albumId: input.albumId ?? null,
    });
    return [{ externalFaceId, confidence: 99, bbox: { ...FULL_FRAME } }];
  }

  async search(input: SearchInput): Promise<SearchHit[]> {
    const color = readQuantizedColor(input.imageBytes, input.contentType);
    if (!color) return [];
    const rows = await this.store.findByColor(
      input.eventId,
      color.r,
      color.g,
      color.b,
      input.albumIds,
    );
    return rows.map((row) => ({
      externalFaceId: row.externalFaceId,
      photoId: row.photoId,
      similarity: 99,
      cosine: 1,
    }));
  }

  async searchFaces(input: SearchFacesInput): Promise<SearchHit[]> {
    const anchor = await this.store.findById(input.externalFaceId);
    if (!anchor || anchor.eventId !== input.eventId) return [];
    // Absent `albumIds` means the anchor's own album, which is what `attach` needs: a face
    // is only ever compared inside its album (see SearchFacesInput).
    //
    // An anchor with no album falls back to the whole event, i.e. exactly v5. That is the
    // only meaning "inside my album" can have without an album, and it is unreachable in
    // production: `face_vectors.album_id` is NOT NULL after migration 011 and the worker
    // always passes `photo.albumId` (handlers.ts). Note where the strictness lives — when a
    // caller *does* pass `albumIds`, a null-album row is never returned, and that is the
    // path the crowd-album rule travels (the caller passes the recognising albums).
    const albumIds = input.albumIds ?? (anchor.albumId === null ? undefined : [anchor.albumId]);
    const rows = await this.store.findByColor(
      input.eventId,
      anchor.r,
      anchor.g,
      anchor.b,
      albumIds,
    );
    return rows
      .filter((row) => row.externalFaceId !== input.externalFaceId)
      .map((row) => ({
        externalFaceId: row.externalFaceId,
        photoId: row.photoId,
        similarity: 99,
        cosine: 1,
      }));
  }

  /** One full-frame face per image (none for an empty image), with the colour-key embedding. */
  async embedSelfie(input: EmbedSelfieInput): Promise<EmbedSelfieResult> {
    const color = readQuantizedColor(input.imageBytes, input.contentType);
    if (!color) return { faces: [], width: FAKE_SELFIE_FRAME, height: FAKE_SELFIE_FRAME };
    return {
      width: FAKE_SELFIE_FRAME,
      height: FAKE_SELFIE_FRAME,
      faces: [
        {
          bbox: { ...FULL_FRAME },
          score: 0.99,
          quality: 1,
          embedding: fakeEmbedding(color.r, color.g, color.b),
        },
      ],
    };
  }

  /** Every indexed face whose colour key falls in the vector's bucket (cosine 1). */
  async searchByVector(input: SearchByVectorInput): Promise<VectorHit[]> {
    const bucket = fakeBucket(input.embedding);
    if (bucket === null || (input.minCosine ?? 0) > 1) return [];
    if (input.albumIds !== undefined && input.albumIds.length === 0) return [];
    const hits: VectorHit[] = [];
    for (const key of bucketKeys(bucket)) {
      const rows = await this.store.findByColor(
        input.eventId,
        key.r,
        key.g,
        key.b,
        input.albumIds,
      );
      for (const row of rows) {
        hits.push({
          externalFaceId: row.externalFaceId,
          photoId: row.photoId,
          similarity: 99,
          cosine: 1,
        });
      }
    }
    return input.maxFaces === undefined ? hits : hits.slice(0, input.maxFaces);
  }

  async faceEmbedding(input: SearchFacesInput): Promise<number[] | null> {
    const row = await this.store.findById(input.externalFaceId);
    if (!row || row.eventId !== input.eventId) return null;
    // A face outside the requested albums is not readable through this path either: the
    // embedding is the face, and handing it out would be the album boundary leaking.
    if (input.albumIds !== undefined) {
      if (row.albumId === null || !input.albumIds.includes(row.albumId)) return null;
    }
    return fakeEmbedding(row.r, row.g, row.b);
  }

  async deleteFaces(eventId: string, externalFaceIds: string[]): Promise<void> {
    if (externalFaceIds.length === 0) return;
    await this.store.deleteIds(eventId, externalFaceIds);
  }

  async deleteCollection(eventId: string): Promise<void> {
    await this.store.deleteEvent(eventId);
  }
}

/** See {@link FAKE_EMBEDDING_DIMENSIONS}. */
export function fakeEmbedding(r: number, g: number, b: number): number[] {
  const vector = new Array<number>(FAKE_EMBEDDING_DIMENSIONS).fill(0);
  vector[((r >> 5) << 6) + ((g >> 5) << 3) + (b >> 5)] = 1;
  return vector;
}

/** Index of the largest component, or null for an empty / zero vector. */
function fakeBucket(embedding: readonly number[]): number | null {
  let best = -1;
  let bestValue = 0;
  for (let index = 0; index < Math.min(embedding.length, FAKE_EMBEDDING_DIMENSIONS); index += 1) {
    const value = embedding[index] ?? 0;
    if (value > bestValue) {
      bestValue = value;
      best = index;
    }
  }
  return best < 0 ? null : best;
}

/** The eight 16-level colour keys (the store's granularity) inside one 32-level bucket. */
function bucketKeys(bucket: number): Array<{ r: number; g: number; b: number }> {
  const r = (bucket >> 6) << 5;
  const g = ((bucket >> 3) & 7) << 5;
  const b = (bucket & 7) << 5;
  const keys: Array<{ r: number; g: number; b: number }> = [];
  for (const dr of [0, 16]) {
    for (const dg of [0, 16]) {
      for (const db of [0, 16]) keys.push({ r: r + dr, g: g + dg, b: b + db });
    }
  }
  return keys;
}

type FaceIndexSql = {
  external_face_id: string;
  photo_id: string;
  event_id: string;
  r: number;
  g: number;
  b: number;
  album_id: string | null;
};

function mapFaceIndexRow(row: FaceIndexSql): FaceIndexRecord {
  return {
    externalFaceId: String(row.external_face_id),
    photoId: String(row.photo_id),
    eventId: String(row.event_id),
    r: Number(row.r),
    g: Number(row.g),
    b: Number(row.b),
    albumId: row.album_id === null || row.album_id === undefined ? null : String(row.album_id),
  };
}

function createPgQueryable(databaseUrl: string): Queryable {
  return {
    async query(sql, params) {
      const pool = await loadPool(databaseUrl);
      return pool.query(sql, params);
    },
  };
}

async function loadPool(databaseUrl: string): Promise<PgPool> {
  const existing = pools.get(databaseUrl);
  if (existing) return existing;
  const imported = (await import("pg")) as {
    Pool?: PgPoolConstructor;
    default?: { Pool?: PgPoolConstructor };
  };
  const Pool = imported.Pool ?? imported.default?.Pool;
  if (!Pool) throw new Error("PostgreSQL driver is missing a Pool export");
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  pool.on("error", () => {
    // Do not log: the driver message can include the connection string.
  });
  pools.set(databaseUrl, pool);
  return pool;
}

function isUndefinedTable(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}

function sanitizeDbError(error: unknown): Error {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const safe = new Error(
    code ? `face_index query failed (${code})` : "face_index query failed",
  );
  safe.name = "FaceIndexError";
  return safe;
}

function readQuantizedColor(
  bytes: Uint8Array,
  contentType: ImageContentType,
): { r: number; g: number; b: number } | null {
  const primary = contentType === "image/jpeg" ? jpegAverage : pngAverage;
  const secondary = contentType === "image/jpeg" ? pngAverage : jpegAverage;
  let sum: PixelSum;
  try {
    sum = primary(bytes);
  } catch (primaryError) {
    try {
      sum = secondary(bytes);
    } catch {
      throw new Error(
        `Could not read image as PNG or JPEG (${safeReason(primaryError)})`,
      );
    }
  }
  if (sum.count === 0) return null;
  return {
    r: quantChannel(sum.sumR / sum.count),
    g: quantChannel(sum.sumG / sum.count),
    b: quantChannel(sum.sumB / sum.count),
  };
}

function quantChannel(average: number): number {
  const rounded = Math.round(average);
  const clamped = Math.min(255, Math.max(0, rounded));
  return Math.floor(clamped / 16) * 16;
}

function safeReason(error: unknown): string {
  if (!(error instanceof Error) || !error.message) return "unreadable image";
  const text = error.message.replace(/[^\t\n\r\x20-\x7E]/g, "").slice(0, 160);
  return text || "unreadable image";
}

function emptySum(): PixelSum {
  return { sumR: 0, sumG: 0, sumB: 0, count: 0 };
}

function pngAverage(bytes: Uint8Array): PixelSum {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error("Invalid PNG signature");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let sawIhdr = false;
  const idatParts: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = latin1(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error("Truncated PNG");
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (data.length < 13) throw new Error("Truncated PNG");
      width = readU32(data, 0);
      height = readU32(data, 4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? -1;
      const compression = data[10] ?? 1;
      const filter = data[11] ?? 1;
      const interlace = data[12] ?? 1;
      if (compression !== 0) throw new Error("Unsupported PNG compression");
      if (filter !== 0) throw new Error("Unsupported PNG filter method");
      if (interlace !== 0) throw new Error("Interlaced PNG is not supported");
      sawIhdr = true;
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!sawIhdr) throw new Error("PNG is missing IHDR");
  if (width === 0 || height === 0) return emptySum();
  if (bitDepth !== 8) throw new Error("Only 8-bit PNG is supported");
  const bpp = bytesPerPixel(colorType);
  if (idatParts.length === 0) throw new Error("PNG is missing pixel data");
  const compressedLength = idatParts.reduce((sum, part) => sum + part.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let cursor = 0;
  for (const part of idatParts) {
    compressed.set(part, cursor);
    cursor += part.length;
  }
  let raw: Uint8Array;
  try {
    raw = inflateSync(compressed);
  } catch {
    throw new Error("PNG pixel data is not valid");
  }
  const stride = width * bpp;
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error("PNG pixel data is not valid");
  const pixels = unfilterPng(raw, height, stride, bpp);
  const sum = emptySum();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * bpp;
      if (colorType === 0 || colorType === 4) {
        const gray = pixels[i] ?? 0;
        sum.sumR += gray;
        sum.sumG += gray;
        sum.sumB += gray;
      } else {
        sum.sumR += pixels[i] ?? 0;
        sum.sumG += pixels[i + 1] ?? 0;
        sum.sumB += pixels[i + 2] ?? 0;
      }
      sum.count += 1;
    }
  }
  return sum;
}

function bytesPerPixel(colorType: number): number {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new Error(`Unsupported PNG color type ${colorType}`);
}

function unfilterPng(
  raw: Uint8Array,
  height: number,
  stride: number,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src] ?? 0;
    src += 1;
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src] ?? 0;
      src += 1;
      const left = x >= bpp ? (out[rowStart + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (out[rowStart - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= bpp ? (out[rowStart - stride + x - bpp] ?? 0) : 0;
      let recon = value;
      if (filter === 0) recon = value;
      else if (filter === 1) recon = (value + left) & 255;
      else if (filter === 2) recon = (value + up) & 255;
      else if (filter === 3) recon = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) recon = (value + paeth(left, up, upLeft)) & 255;
      else throw new Error("Unsupported PNG filter");
      out[rowStart + x] = recon;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
];

interface HuffmanTable {
  mincode: number[];
  maxcode: number[];
  valptr: number[];
  values: Uint8Array;
}

interface FrameComponent {
  id: number;
  h: number;
  v: number;
  quantId: number;
  plane: number;
  dcTable: number;
  acTable: number;
}

function jpegAverage(bytes: Uint8Array): PixelSum {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Invalid JPEG signature");
  }
  const dcTables: Array<HuffmanTable | undefined> = [];
  const acTables: Array<HuffmanTable | undefined> = [];
  const quantTables: Array<Uint16Array | undefined> = [];
  const frame: FrameComponent[] = [];
  let width = 0;
  let height = 0;
  let restartInterval = 0;
  let pos = 2;
  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) throw new Error("JPEG marker expected");
    while (bytes[pos] === 0xff) pos += 1;
    const marker = bytes[pos] ?? 0;
    pos += 1;
    if (marker === 0xd9) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (pos + 2 > bytes.length) throw new Error("Truncated JPEG");
    const segmentLength = readU16(bytes, pos);
    if (segmentLength < 2 || pos + segmentLength > bytes.length) {
      throw new Error("Truncated JPEG");
    }
    const payload = bytes.subarray(pos + 2, pos + segmentLength);
    pos += segmentLength;
    if (marker === 0xc0) {
      parseSof(payload, frame);
      height = readU16(payload, 1);
      width = readU16(payload, 3);
    } else if (marker === 0xc1) {
      throw new Error("Extended sequential JPEG is not supported");
    } else if (marker === 0xc2 || marker === 0xc3) {
      throw new Error("Progressive JPEG is not supported");
    } else if (marker === 0xc4) {
      parseDht(payload, dcTables, acTables);
    } else if (marker === 0xdb) {
      parseDqt(payload, quantTables);
    } else if (marker === 0xdd) {
      if (payload.length < 2) throw new Error("Truncated JPEG");
      restartInterval = readU16(payload, 0);
    } else if (marker === 0xda) {
      if (width === 0 || height === 0) return emptySum();
      const scan = parseSos(payload, frame);
      const entropy = bytes.subarray(pos);
      return decodeJpegScan({
        entropy,
        width,
        height,
        frame,
        scan,
        quantTables,
        dcTables,
        acTables,
        restartInterval,
      });
    }
  }
  throw new Error("JPEG frame is missing a scan");
}

function parseSof(payload: Uint8Array, frame: FrameComponent[]): void {
  if (payload.length < 6) throw new Error("Truncated JPEG");
  const precision = payload[0] ?? 0;
  if (precision !== 8) throw new Error("Only 8-bit JPEG is supported");
  const count = payload[5] ?? 0;
  if (count < 1 || count > 3) throw new Error("Unsupported JPEG component count");
  if (payload.length < 6 + count * 3) throw new Error("Truncated JPEG");
  frame.length = 0;
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 3;
    const sampling = payload[base + 1] ?? 0;
    const h = sampling >> 4;
    const v = sampling & 0x0f;
    if (h < 1 || v < 1) throw new Error("Unsupported JPEG sampling factors");
    frame.push({
      id: payload[base] ?? 0,
      h,
      v,
      quantId: payload[base + 2] ?? 0,
      plane: i,
      dcTable: 0,
      acTable: 0,
    });
  }
}

function parseDqt(payload: Uint8Array, tables: Array<Uint16Array | undefined>): void {
  let i = 0;
  while (i < payload.length) {
    const info = payload[i] ?? 0;
    i += 1;
    const precision = info >> 4;
    const id = info & 0x0f;
    const quant = new Uint16Array(64);
    if (precision === 0) {
      if (i + 64 > payload.length) throw new Error("Truncated JPEG");
      for (let k = 0; k < 64; k++) quant[k] = payload[i + k] ?? 0;
      i += 64;
    } else if (precision === 1) {
      if (i + 128 > payload.length) throw new Error("Truncated JPEG");
      for (let k = 0; k < 64; k++) {
        quant[k] = readU16(payload, i + k * 2);
      }
      i += 128;
    } else {
      throw new Error("Unsupported JPEG quantization table");
    }
    tables[id] = quant;
  }
}

function parseDht(
  payload: Uint8Array,
  dcTables: Array<HuffmanTable | undefined>,
  acTables: Array<HuffmanTable | undefined>,
): void {
  let i = 0;
  while (i < payload.length) {
    const info = payload[i] ?? 0;
    i += 1;
    const cls = info >> 4;
    const id = info & 0x0f;
    if (i + 16 > payload.length) throw new Error("Truncated JPEG");
    const counts = payload.subarray(i, i + 16);
    i += 16;
    let total = 0;
    for (const count of counts) total += count;
    if (i + total > payload.length) throw new Error("Truncated JPEG");
    const values = payload.subarray(i, i + total);
    i += total;
    const table = buildHuffman(counts, values);
    if (cls === 0) dcTables[id] = table;
    else if (cls === 1) acTables[id] = table;
    else throw new Error("Unsupported JPEG Huffman table");
  }
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): HuffmanTable {
  const mincode = new Array<number>(17).fill(0);
  const maxcode = new Array<number>(17).fill(-1);
  const valptr = new Array<number>(17).fill(0);
  let code = 0;
  let index = 0;
  let started = false;
  for (let len = 1; len <= 16; len++) {
    const count = counts[len - 1] ?? 0;
    if (!started) {
      if (count === 0) continue;
      started = true;
    } else if (count === 0) {
      code <<= 1;
      continue;
    }
    valptr[len] = index;
    mincode[len] = code;
    index += count;
    code += count;
    maxcode[len] = code - 1;
    code <<= 1;
  }
  return { mincode, maxcode, valptr, values };
}

function parseSos(payload: Uint8Array, frame: FrameComponent[]): FrameComponent[] {
  if (payload.length < 1) throw new Error("Truncated JPEG");
  const count = payload[0] ?? 0;
  if (payload.length < 1 + count * 2 + 3) throw new Error("Truncated JPEG");
  const scan: FrameComponent[] = [];
  for (let i = 0; i < count; i++) {
    const id = payload[1 + i * 2] ?? 0;
    const tables = payload[2 + i * 2] ?? 0;
    const component = frame.find((item) => item.id === id);
    if (!component) throw new Error("JPEG scan references an unknown component");
    component.dcTable = tables >> 4;
    component.acTable = tables & 0x0f;
    scan.push(component);
  }
  return scan;
}

function decodeJpegScan(args: {
  entropy: Uint8Array;
  width: number;
  height: number;
  frame: FrameComponent[];
  scan: FrameComponent[];
  quantTables: Array<Uint16Array | undefined>;
  dcTables: Array<HuffmanTable | undefined>;
  acTables: Array<HuffmanTable | undefined>;
  restartInterval: number;
}): PixelSum {
  const { width, height, scan, quantTables, dcTables, acTables, restartInterval } = args;
  if (scan.length === 0) throw new Error("JPEG scan has no components");
  let maxH = 1;
  let maxV = 1;
  for (const component of args.frame) {
    if (component.h > maxH) maxH = component.h;
    if (component.v > maxV) maxV = component.v;
  }
  for (const component of scan) {
    if (maxH % component.h !== 0 || maxV % component.v !== 0) {
      throw new Error("Unsupported JPEG sampling factors");
    }
  }
  const mcuPixelW = maxH * 8;
  const mcuPixelH = maxV * 8;
  const mcuCols = Math.ceil(width / mcuPixelW);
  const mcuRows = Math.ceil(height / mcuPixelH);
  const reader = new JpegBitReader(args.entropy);
  const dcPred = new Array<number>(args.frame.length).fill(0);
  const planes = args.frame.map(() => new Float64Array(mcuPixelW * mcuPixelH));
  const sum = emptySum();
  let mcuCount = 0;
  for (let row = 0; row < mcuRows; row++) {
    for (let col = 0; col < mcuCols; col++) {
      if (restartInterval > 0 && mcuCount > 0 && mcuCount % restartInterval === 0) {
        reader.consumeRestart();
        dcPred.fill(0);
      }
      for (const plane of planes) plane.fill(0);
      for (const component of scan) {
        const quant = quantTables[component.quantId];
        const dcTable = dcTables[component.dcTable];
        const acTable = acTables[component.acTable];
        if (!quant || !dcTable || !acTable) {
          throw new Error("JPEG is missing a Huffman or quantization table");
        }
        const hScale = maxH / component.h;
        const vScale = maxV / component.v;
        const plane = planes[component.plane];
        if (!plane) throw new Error("JPEG component plane is missing");
        for (let by = 0; by < component.v; by++) {
          for (let bx = 0; bx < component.h; bx++) {
            const decoded = decodeBlock(reader, dcTable, acTable, quant, dcPred[component.plane] ?? 0);
            dcPred[component.plane] = decoded.dc;
            const samples = idct8(decoded.block);
            const originX = bx * 8 * hScale;
            const originY = by * 8 * vScale;
            for (let y = 0; y < 8; y++) {
              for (let x = 0; x < 8; x++) {
                const sample = samples[y * 8 + x] ?? 0;
                for (let dy = 0; dy < vScale; dy++) {
                  for (let dx = 0; dx < hScale; dx++) {
                    const px = originX + x * hScale + dx;
                    const py = originY + y * vScale + dy;
                    if (px >= mcuPixelW || py >= mcuPixelH) continue;
                    plane[py * mcuPixelW + px] = sample;
                  }
                }
              }
            }
          }
        }
      }
      const originX = col * mcuPixelW;
      const originY = row * mcuPixelH;
      const copyW = Math.min(mcuPixelW, width - originX);
      const copyH = Math.min(mcuPixelH, height - originY);
      for (let y = 0; y < copyH; y++) {
        for (let x = 0; x < copyW; x++) {
          const index = y * mcuPixelW + x;
          if (scan.length === 1) {
            const gray = clampByte(planes[0]?.[index] ?? 0);
            sum.sumR += gray;
            sum.sumG += gray;
            sum.sumB += gray;
          } else {
            const yValue = planes[0]?.[index] ?? 0;
            const cb = planes[1]?.[index] ?? 128;
            const cr = planes[2]?.[index] ?? 128;
            const rgb = ycbcrToRgb(yValue, cb, cr);
            sum.sumR += rgb[0];
            sum.sumG += rgb[1];
            sum.sumB += rgb[2];
          }
          sum.count += 1;
        }
      }
      mcuCount += 1;
    }
  }
  return sum;
}

function decodeBlock(
  reader: JpegBitReader,
  dcTable: HuffmanTable,
  acTable: HuffmanTable,
  quant: Uint16Array,
  prevDc: number,
): { block: Float64Array; dc: number } {
  const block = new Float64Array(64);
  const dcSize = decodeHuffman(reader, dcTable);
  const dcDiff = receiveExtend(reader, dcSize);
  const dc = prevDc + dcDiff;
  block[0] = dc * (quant[0] ?? 1);
  let k = 1;
  while (k < 64) {
    const symbol = decodeHuffman(reader, acTable);
    if (symbol === 0) break;
    if (symbol === 0xf0) {
      k += 16;
      continue;
    }
    const run = symbol >> 4;
    const size = symbol & 0x0f;
    k += run;
    if (size === 0 || k >= 64) throw new Error("Invalid JPEG AC coefficient");
    const ac = receiveExtend(reader, size);
    const natural = ZIGZAG[k];
    if (natural === undefined) throw new Error("Invalid JPEG AC coefficient");
    block[natural] = ac * (quant[k] ?? 1);
    k += 1;
  }
  return { block, dc };
}

function decodeHuffman(reader: JpegBitReader, table: HuffmanTable): number {
  let code = 0;
  for (let len = 1; len <= 16; len++) {
    code = (code << 1) | reader.readBit();
    const max = table.maxcode[len] ?? -1;
    if (code <= max) {
      const min = table.mincode[len] ?? 0;
      const index = (table.valptr[len] ?? 0) + (code - min);
      const value = table.values[index];
      if (value === undefined) throw new Error("Invalid JPEG Huffman code");
      return value;
    }
  }
  throw new Error("Invalid JPEG Huffman code");
}

function receiveExtend(reader: JpegBitReader, length: number): number {
  if (length === 0) return 0;
  let value = 0;
  for (let i = 0; i < length; i++) value = (value << 1) | reader.readBit();
  const threshold = 1 << (length - 1);
  if (value < threshold) value -= (1 << length) - 1;
  return value;
}

function idct8(block: Float64Array): Float64Array {
  const tmp = new Float64Array(64);
  const out = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) {
        const c = u === 0 ? Math.SQRT1_2 : 1;
        sum += c * (block[y * 8 + u] ?? 0) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
      }
      tmp[y * 8 + x] = sum;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        const c = v === 0 ? Math.SQRT1_2 : 1;
        sum += c * (tmp[v * 8 + x] ?? 0) * Math.cos(((2 * y + 1) * v * Math.PI) / 16);
      }
      out[y * 8 + x] = sum / 4 + 128;
    }
  }
  return out;
}

function ycbcrToRgb(y: number, cb: number, cr: number): [number, number, number] {
  const cbf = cb - 128;
  const crf = cr - 128;
  return [
    clampByte(y + 1.402 * crf),
    clampByte(y - 0.344136 * cbf - 0.714136 * crf),
    clampByte(y + 1.772 * cbf),
  ];
}

function clampByte(value: number): number {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

class JpegBitReader {
  private pos = 0;
  private bitBuf = 0;
  private bitCount = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  readBit(): number {
    if (this.bitCount === 0) {
      const next = this.nextByte();
      if (next === "end" || next === "restart") {
        throw new Error("JPEG scan ended before the image was complete");
      }
      this.bitBuf = next;
      this.bitCount = 8;
    }
    this.bitCount -= 1;
    return (this.bitBuf >> this.bitCount) & 1;
  }

  consumeRestart(): void {
    this.bitCount = 0;
    this.bitBuf = 0;
    if (this.pos >= this.data.length || this.data[this.pos] !== 0xff) {
      throw new Error("JPEG restart marker missing");
    }
    while (this.pos < this.data.length && this.data[this.pos] === 0xff) this.pos += 1;
    const marker = this.data[this.pos] ?? 0;
    this.pos += 1;
    if (marker < 0xd0 || marker > 0xd7) throw new Error("JPEG restart marker missing");
  }

  private nextByte(): number | "restart" | "end" {
    if (this.pos >= this.data.length) return "end";
    const value = this.data[this.pos] ?? 0;
    this.pos += 1;
    if (value !== 0xff) return value;
    while (this.pos < this.data.length && this.data[this.pos] === 0xff) this.pos += 1;
    if (this.pos >= this.data.length) return "end";
    const marker = this.data[this.pos] ?? 0;
    this.pos += 1;
    if (marker === 0x00) return 0xff;
    if (marker >= 0xd0 && marker <= 0xd7) return "restart";
    return "end";
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function latin1(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[offset + i] ?? 0);
  return text;
}
