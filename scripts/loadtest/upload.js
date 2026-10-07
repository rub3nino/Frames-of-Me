// k6 load test: 12 photographers uploading ~2 MB JPEGs through init -> presigned PUT -> complete.
//
//   k6 run -e BASE_URL=http://localhost:8787 -e EVENT_SLUG=demo \
//          -e SESSION_COOKIES="tok1,tok2,...,tok12" scripts/loadtest/upload.js
//
// SESSION_COOKIES: comma-separated values of the `rephoto_session` cookie, one per
// photographer (all of them must be members of the event). VUs pick one round-robin.
// Every upload is unique: the fixture JPEG is padded with random bytes after the EOI
// marker, so the sha256 differs and the api does not answer 409 (duplicate).

import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";
import crypto from "k6/crypto";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:8787").replace(/\/$/, "");
const EVENT_SLUG = __ENV.EVENT_SLUG || "demo";
const COOKIES = (__ENV.SESSION_COOKIES || "").split(",").map((s) => s.trim()).filter(Boolean);
const TARGET_BYTES = Number(__ENV.UPLOAD_BYTES || 2 * 1024 * 1024);
const VUS = Number(__ENV.VUS || 12);
const DURATION = __ENV.DURATION || "5m";

const FIXTURE = open("./fixtures/sample.jpg", "b");

export const options = {
  scenarios: {
    photographers: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    upload_init: ["p(95)<500"],
    upload_complete: ["p(95)<1000"],
    upload_errors: ["count<10"],
  },
};

const initTrend = new Trend("upload_init", true);
const putTrend = new Trend("upload_put", true);
const completeTrend = new Trend("upload_complete", true);
const totalTrend = new Trend("upload_total", true);
const errors = new Counter("upload_errors");
const uploaded = new Counter("upload_photos");

function toHex(buf) {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** Fixture JPEG followed by random bytes, so each upload has a new sha256. */
function makePhoto() {
  const fixture = new Uint8Array(FIXTURE);
  const padLength = Math.max(0, TARGET_BYTES - fixture.length);
  const out = new Uint8Array(fixture.length + padLength);
  out.set(fixture, 0);
  if (padLength > 0) out.set(new Uint8Array(crypto.randomBytes(padLength)), fixture.length);
  return out.buffer;
}

export function setup() {
  if (COOKIES.length === 0) fail("SESSION_COOKIES is empty");
  const res = http.get(`${BASE_URL}/v1/events/${EVENT_SLUG}`);
  if (res.status !== 200) fail(`GET /v1/events/${EVENT_SLUG} -> ${res.status}`);
  return { eventId: res.json("id") };
}

export default function (data) {
  const cookie = COOKIES[(__VU - 1) % COOKIES.length];
  const headers = { "Content-Type": "application/json", Cookie: `rephoto_session=${cookie}` };
  const body = makePhoto();
  const bytes = body.byteLength;
  const sha256 = toHex(crypto.sha256(body, "binary"));
  const started = Date.now();

  const init = http.post(
    `${BASE_URL}/v1/uploads/init`,
    JSON.stringify({
      eventId: data.eventId,
      filename: `loadtest-${__VU}-${__ITER}.jpg`,
      contentType: "image/jpeg",
      sha256,
      bytes,
    }),
    { headers, tags: { step: "init" } },
  );
  initTrend.add(init.timings.duration);
  if (!check(init, { "init 201": (r) => r.status === 201 })) {
    errors.add(1);
    console.error(`init ${init.status}: ${init.body}`);
    sleep(1);
    return;
  }
  const session = init.json();
  let parts = [];

  if (session.mode === "single") {
    const put = http.put(session.url, body, {
      headers: { "Content-Type": "image/jpeg" },
      tags: { step: "put" },
    });
    putTrend.add(put.timings.duration);
    if (!check(put, { "put 200": (r) => r.status === 200 })) {
      errors.add(1);
      console.error(`put ${put.status}: ${String(put.body).slice(0, 200)}`);
      return;
    }
  } else {
    const partSize = session.partSize;
    const total = Math.ceil(bytes / partSize);
    for (let n = 1; n <= total; n++) {
      const partRes = http.post(`${BASE_URL}/v1/uploads/${session.id}/parts`, JSON.stringify({ partNumber: n }), {
        headers,
        tags: { step: "part-url" },
      });
      if (partRes.status !== 200) {
        errors.add(1);
        console.error(`part url ${partRes.status}: ${partRes.body}`);
        return;
      }
      const slice = body.slice((n - 1) * partSize, Math.min(n * partSize, bytes));
      const put = http.put(partRes.json("url"), slice, { tags: { step: "put" } });
      putTrend.add(put.timings.duration);
      if (put.status !== 200) {
        errors.add(1);
        console.error(`part ${n} put ${put.status}`);
        return;
      }
      parts.push({ partNumber: n, etag: put.headers.ETag || put.headers.Etag });
    }
  }

  const complete = http.post(`${BASE_URL}/v1/uploads/${session.id}/complete`, JSON.stringify({ parts }), {
    headers,
    tags: { step: "complete" },
  });
  completeTrend.add(complete.timings.duration);
  if (check(complete, { "complete 201": (r) => r.status === 201 })) {
    uploaded.add(1);
    totalTrend.add(Date.now() - started);
  } else {
    errors.add(1);
    console.error(`complete ${complete.status}: ${complete.body}`);
  }
}
