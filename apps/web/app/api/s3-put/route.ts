import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dev-only fallback for browsers that cannot PUT straight to MinIO (CORS). The body is
 * streamed through, never buffered. Disabled in production: presigned URLs go direct.
 */

function localMinioUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const hostOk = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "http:" || !hostOk || url.port !== "9000") return null;
    return url;
  } catch {
    return null;
  }
}

export async function PUT(request: NextRequest) {
  if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });

  const target = localMinioUrl(request.nextUrl.searchParams.get("url") ?? "");
  if (!target) return new NextResponse(null, { status: 403 });

  const headers = new Headers();
  headers.set("content-type", request.headers.get("content-type") ?? "application/octet-stream");
  // The presigned PUT may be signed with the length: forward it so undici does not switch
  // to chunked transfer, which S3-compatible stores reject.
  const length = request.headers.get("content-length");
  if (length) headers.set("content-length", length);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "PUT",
      body: request.body,
      headers,
      // Required by undici when the body is a stream.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch {
    return new NextResponse(null, { status: 502 });
  }

  const response = new NextResponse(null, { status: upstream.status });
  const etag = upstream.headers.get("etag");
  if (etag) response.headers.set("etag", etag);
  return response;
}
