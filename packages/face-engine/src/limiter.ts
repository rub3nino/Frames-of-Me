import type {
  FaceEngine,
  IndexedFace,
  IndexPhotoInput,
  LivenessInput,
  LivenessResult,
  SearchFacesInput,
  SearchHit,
  SearchInput,
} from "./types.ts";

/**
 * Continuous-refill token bucket. Capacity is `max(1, ceil(tps))`, so a
 * burst of one second is allowed and the long-run rate is `tps`.
 * Waiters are served in FIFO order.
 */
export class TokenBucket {
  private readonly tps: number;
  private readonly capacity: number;
  private tokens: number;
  private last: number;
  private readonly waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(tps: number) {
    if (!Number.isFinite(tps) || tps <= 0) {
      throw new Error("Token bucket rate must be a positive number");
    }
    this.tps = tps;
    this.capacity = Math.max(1, Math.ceil(tps));
    this.tokens = this.capacity;
    this.last = Date.now();
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.drain();
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.tps);
    this.last = now;
  }

  private drain(): void {
    if (this.timer) return;
    this.refill();
    while (this.waiters.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
    if (this.waiters.length === 0) return;
    const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.tps) * 1000));
    // Not unref'd: a pending waiter must keep the process alive until served.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drain();
    }, waitMs);
  }
}

export interface RateLimitOptions {
  indexTps: number;
  searchTps: number;
}

/**
 * Per-process throttle in front of a remote engine. `indexPhoto` uses the index
 * bucket; `search`, `searchFaces` and `checkLiveness` share the search bucket.
 * Deletes are not limited. With several worker instances the effective quota
 * is the sum. `checkLiveness` is exposed only when the inner engine has it.
 */
export class RateLimitedFaceEngine implements FaceEngine {
  private readonly indexBucket: TokenBucket;
  private readonly searchBucket: TokenBucket;
  readonly checkLiveness?: (input: LivenessInput) => Promise<LivenessResult>;

  constructor(
    private readonly inner: FaceEngine,
    options: RateLimitOptions,
  ) {
    this.indexBucket = new TokenBucket(options.indexTps);
    this.searchBucket = new TokenBucket(options.searchTps);
    const liveness = inner.checkLiveness?.bind(inner);
    if (liveness) {
      this.checkLiveness = async (input) => {
        await this.searchBucket.acquire();
        return liveness(input);
      };
    }
  }

  async indexPhoto(input: IndexPhotoInput): Promise<IndexedFace[]> {
    await this.indexBucket.acquire();
    return this.inner.indexPhoto(input);
  }

  async search(input: SearchInput): Promise<SearchHit[]> {
    await this.searchBucket.acquire();
    return this.inner.search(input);
  }

  async searchFaces(input: SearchFacesInput): Promise<SearchHit[]> {
    await this.searchBucket.acquire();
    return this.inner.searchFaces(input);
  }

  deleteFaces(eventId: string, externalFaceIds: string[]): Promise<void> {
    return this.inner.deleteFaces(eventId, externalFaceIds);
  }

  deleteCollection(eventId: string): Promise<void> {
    return this.inner.deleteCollection(eventId);
  }
}

/** Blank or missing → default. Anything else must be a positive number. */
export function readTps(raw: string | undefined, name: string, fallback = 5): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}
