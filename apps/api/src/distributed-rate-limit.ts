/**
 * The one limiter in this codebase that holds ACROSS api replicas without a database round
 * trip. Ported from `main`, where it was introduced for the participant upload flood path.
 *
 * Read this before adding a limiter anywhere: "rate limited" is three different guarantees
 * in this repo and the call sites read the same at a glance.
 *
 *  1. **Database-backed counts** — magic links (`countMagicLinksSince`), selfies
 *     (`countMatchJobsSince`), reports (`countReportsByUserSince`), password reset. These are
 *     exact and cross-replica already, because the rows they count are the shared state.
 *     They cost one query. Nothing here improves them.
 *  2. **In-process `Map` windows** — `createRateLimiter` (self-registration, routes.ts) and
 *     `createTagLimiter` (routes.tags.ts). These are per process: the effective limit is the
 *     configured one TIMES the number of replicas, and it resets on every deploy. That is
 *     acceptable only where a hard backstop exists elsewhere — for registration it is
 *     `event_codes.max_uses`, enforced in one statement.
 *  3. **This**, a fixed window in Upstash Redis, shared by every replica, used in front of a
 *     database count so the common case costs no query and the limit is still correct when
 *     Redis is absent or down.
 *
 * Fixed window, not sliding: a caller can get up to 2× the limit across a window boundary.
 * That is the trade main accepted and it is the right one for a flood gate — the point is to
 * bound the volume, and an exact count is one `countAlbumUploadsSince` away when it matters.
 *
 * Returns `null` when no shared limiter is configured, which is the signal to fall back to
 * the database count. It THROWS on a transport or protocol failure, so the caller can decide
 * between falling back and failing closed; every call site here falls back.
 */
export async function incrementSharedLimit(input: {
  url?: string;
  token?: string;
  key: string;
  windowSeconds: number;
}): Promise<number | null> {
  if (!input.url || !input.token) return null;
  const response = await fetch(`${input.url.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      ["INCR", input.key],
      ["EXPIRE", input.key, input.windowSeconds],
    ]),
    // A limiter that hangs is worse than a limiter that is missing: the fallback is a single
    // indexed count, so 1.5 s is already generous.
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`shared rate limiter returned ${response.status}`);
  const result = (await response.json()) as Array<{ result?: unknown }>;
  const count = Number(result[0]?.result);
  if (!Number.isFinite(count)) throw new Error("shared rate limiter returned an invalid count");
  return count;
}
