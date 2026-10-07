import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Runtime web config (v5): the event slug is read from the container env at request time,
 * so a new event does not need a rebuild. `NEXT_PUBLIC_EVENT_SLUG` stays the build-time
 * fallback used until this answers.
 */
export function GET() {
  const raw = process.env.EVENT_SLUG || process.env.NEXT_PUBLIC_EVENT_SLUG || "demo";
  const eventSlug = SLUG.test(raw) ? raw : "demo";
  return NextResponse.json({ eventSlug }, { headers: { "cache-control": "no-store" } });
}
