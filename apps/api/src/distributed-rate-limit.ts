/** Optional Upstash limiter. Returns null when no shared limiter is configured. */
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
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`shared rate limiter returned ${response.status}`);
  const result = (await response.json()) as Array<{ result?: unknown }>;
  const count = Number(result[0]?.result);
  if (!Number.isFinite(count)) throw new Error("shared rate limiter returned an invalid count");
  return count;
}
