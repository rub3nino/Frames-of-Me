/**
 * v6 hardening H2 (agent H): read the face service's build at start and refuse the work it
 * cannot do (`index` and `match`; see FACE_INCOMPATIBLE_JOB_TYPES).
 *
 * The incident this exists for: during wave 1 a stale `rephoto-face-service` image enforced
 * `max_faces <= 50` while the source said `MAX_FACES_CAP = 150` and the worker asked for
 * 100. `/v1/embed?max_faces=100` was rejected by FastAPI's query validator with an HTTP 422
 * before any image was decoded. Every single `index` job failed, five attempts each, and the
 * photos ended in `error`. Meanwhile `GET /health` answered `{"ok": true}` all along,
 * because "ok" meant "the model object exists" and nothing else.
 *
 * So `/health` now reports `version` and the real `max_faces_cap` (apps/face-service), and
 * the worker compares that cap with what it is about to ask for (`INSIGHTFACE_INDEX_MAX_FACES`,
 * the `max_faces` of every `/v1/embed` call). If the service cannot serve it, the worker
 * stops claiming the jobs that would send that request and says so once, loudly. Failing
 * fast beats failing 150 000 times silently.
 *
 * What is deliberately NOT treated as incompatible: a service that does not answer. It may
 * be loading its model (a 503 during the ~60 s model load is normal, and that 503 still
 * carries the version), or restarting. That case belongs to the circuit breaker, which
 * already pauses face work on `FaceServiceUnavailable` and retries. Refusing work forever
 * because of one failed probe at boot would be the same outage with a different cause.
 */
import type { JobType } from "@rephoto/contracts";

/**
 * Paused when the service cannot serve the `max_faces` the worker will ask for.
 *
 * Exactly the job types that reach `POST /v1/embed?max_faces=…`, which is the request the
 * cap applies to. `embed()` (insightface.ts) is the only caller of that endpoint, and it is
 * reached from three engine methods:
 *
 *   `indexPhoto`                 -> the `index` job   (handlers.ts, indexPhoto)
 *   `embedSelfie`, `search`      -> the `match` job   (handlers.ts, matchSelfie)
 *
 * `match` matters more than `index`, not less: on an event day with a wrong image, `index`
 * being paused is invisible bulk work waiting, while every participant who sends a selfie
 * gets five failed attempts and then an error — on the one path they actually watch. A job
 * sitting `queued` until someone rebuilds the image is strictly better than telling a
 * participant their selfie failed.
 *
 * Deliberately NOT here:
 *   - `verify` — it is a sha256 integrity check of the original object in the store and
 *     never touches the engine (`verifyOriginal` makes zero `deps.faces` calls). Pausing it
 *     would stop unrelated work and leave originals stuck in `pending` for no benefit.
 *   - `attach` — `searchFaces` / `faceEmbedding` are pgvector-only; no HTTP, no `max_faces`.
 *   - `retention` / `reset` — `deleteFaces` / `deleteCollection`, pgvector-only.
 *
 * (`/v1/liveness` carries no `max_faces` at all, and is only ever called from `match`,
 * which is paused anyway.)
 */
export const FACE_INCOMPATIBLE_JOB_TYPES: readonly JobType[] = ["index", "match"];

export const COMPAT_TIMEOUT_MS = 10_000;

/** The parts of `GET /health` this check is about. */
export type FaceServiceHealth = {
  status: number;
  ok: boolean;
  version: string | null;
  maxFacesCap: number | null;
  model: string | null;
};

export type FaceCompatResult = {
  /** False only when the service answered and what it answered cannot serve us. */
  compatible: boolean;
  /** One line, for the log. */
  reason: string;
  /** What `/health` said, or null when it could not be read. */
  health: FaceServiceHealth | null;
  /** What the worker is about to ask for. */
  requiredMaxFaces: number;
};

export type FaceCompatInput = {
  serviceUrl: string;
  /** `max_faces` of every `/v1/embed` call: `INSIGHTFACE_INDEX_MAX_FACES`. */
  requiredMaxFaces: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Probes `GET <serviceUrl>/health` once. Never throws: an unreachable or unreadable service
 * is reported as compatible with the reason saying so (see the note above).
 */
export async function checkFaceServiceCompat(input: FaceCompatInput): Promise<FaceCompatResult> {
  const requiredMaxFaces = input.requiredMaxFaces;
  const fetchImpl = input.fetch ?? globalThis.fetch;
  // Same normalisation as the engine's `readServiceUrl`, so both probe the same URL.
  const serviceUrl = input.serviceUrl.trim().replace(/\/+$/, "");
  let health: FaceServiceHealth;
  try {
    const response = await fetchImpl(`${serviceUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(input.timeoutMs ?? COMPAT_TIMEOUT_MS),
    });
    // The body is read whatever the status: a 503 while the model loads still names the
    // build, which is exactly what we need to decide (apps/face-service/app/main.py).
    const body: unknown = await response.json();
    health = readHealth(response.status, body);
  } catch (error) {
    return {
      compatible: true,
      reason: `face service at ${serviceUrl} /health unreadable (${errorText(error)}); the breaker owns this case`,
      health: null,
      requiredMaxFaces,
    };
  }
  if (health.maxFacesCap === null) {
    // Every build that reports a cap is new enough to have been checked. A build that does
    // not is from before this check existed — the exact class of image that caused the
    // incident — and cannot be verified, so it is refused rather than trusted.
    return {
      compatible: false,
      reason:
        `face service at ${serviceUrl} does not report max_faces_cap ` +
        `(version=${health.version ?? "unknown"}, model=${health.model ?? "unknown"}): ` +
        `too old to be trusted with max_faces=${requiredMaxFaces}. Rebuild the image ` +
        "(apps/face-service) or lower INSIGHTFACE_INDEX_MAX_FACES.",
      health,
      requiredMaxFaces,
    };
  }
  if (health.maxFacesCap < requiredMaxFaces) {
    return {
      compatible: false,
      reason:
        `face service at ${serviceUrl} accepts max_faces<=${health.maxFacesCap} but the ` +
        `worker asks for ${requiredMaxFaces} (version=${health.version ?? "unknown"}): every ` +
        "index job would fail with HTTP 422. Rebuild the image (apps/face-service) or set " +
        `INSIGHTFACE_INDEX_MAX_FACES<=${health.maxFacesCap}.`,
      health,
      requiredMaxFaces,
    };
  }
  return {
    compatible: true,
    reason:
      `face service version=${health.version ?? "unknown"} max_faces_cap=${health.maxFacesCap} ` +
      `>= INSIGHTFACE_INDEX_MAX_FACES=${requiredMaxFaces}`,
    health,
    requiredMaxFaces,
  };
}

/**
 * The claim filter for an incompatible service. Separate from the circuit breaker: the
 * breaker is a transient pause that closes on the next success, this is a standing refusal
 * that only a new deploy clears.
 */
export class FaceServiceGate {
  private blocked = false;

  /** Applies a verdict: blocks `index` and writes the one loud line. */
  apply(result: FaceCompatResult, log: (line: string) => void = defaultLog): FaceCompatResult {
    if (result.compatible) {
      log(
        JSON.stringify({
          ts: new Date().toISOString(),
          faceService: "compatible",
          detail: result.reason,
        }),
      );
      return result;
    }
    this.blocked = true;
    log(
      JSON.stringify({
        ts: new Date().toISOString(),
        faceService: "incompatible",
        paused: FACE_INCOMPATIBLE_JOB_TYPES,
        requiredMaxFaces: result.requiredMaxFaces,
        maxFacesCap: result.health?.maxFacesCap ?? null,
        version: result.health?.version ?? null,
        error: result.reason,
      }),
    );
    return result;
  }

  isBlocked(): boolean {
    return this.blocked;
  }

  /** Types the next claim must skip, or undefined when every type may run. */
  excludedTypes(): readonly JobType[] | undefined {
    return this.blocked ? FACE_INCOMPATIBLE_JOB_TYPES : undefined;
  }
}

function readHealth(status: number, body: unknown): FaceServiceHealth {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const cap = record.max_faces_cap;
  const version = record.version;
  const model = record.model;
  return {
    status,
    ok: record.ok === true,
    version: typeof version === "string" && version !== "" ? version : null,
    maxFacesCap: typeof cap === "number" && Number.isInteger(cap) && cap > 0 ? cap : null,
    model: typeof model === "string" && model !== "" ? model : null,
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.replace(/\s+/g, " ").slice(0, 200);
  return String(error).slice(0, 200);
}

function defaultLog(line: string): void {
  console.error(line);
}
