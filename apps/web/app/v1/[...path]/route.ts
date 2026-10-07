import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same-origin proxy to the API so the session cookie stays first-party. Request and
 * response bodies are streamed (ZIP downloads are never buffered). All request headers
 * are forwarded as received, `x-forwarded-for` included, so the API sees the proxy chain
 * unchanged; `content-type` and `content-disposition` pass through on the way back.
 */

const SKIP = new Set([
  "set-cookie",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

function apiOrigin(): string {
  const raw =
    process.env.API_PROXY_TARGET ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:8787";
  return raw.replace(/\/$/, "");
}

type Context = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: Context) {
  const { path } = await context.params;
  const target = `${apiOrigin()}/v1/${path.map((segment) => encodeURIComponent(segment)).join("/")}${request.nextUrl.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("keep-alive");
  headers.delete("transfer-encoding");

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;
  if (!hasBody) headers.delete("content-length");

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      cache: "no-store",
      // Required by undici when the body is a stream.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch {
    return NextResponse.json(
      { error: "Il servizio non risponde. Riprova." },
      { status: 502 },
    );
  }

  const response = new NextResponse(upstream.status === 204 || method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
  });

  upstream.headers.forEach((value, key) => {
    if (SKIP.has(key.toLowerCase())) return;
    response.headers.set(key, value);
  });

  const cookies =
    typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
  for (const cookie of cookies) response.headers.append("set-cookie", cookie);

  return response;
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
