// k6 load test: 1,000 selfies in 10 minutes, each polling the gallery until status === "ready".
//
//   k6 run -e BASE_URL=http://localhost:8787 -e EVENT_SLUG=demo \
//          -e PARTICIPANT_COOKIES="tok1,tok2,..." scripts/loadtest/selfie.js
//
// PARTICIPANT_COOKIES: comma-separated values of the `rephoto_session` cookie for
// participant users. The api allows 5 selfies per user per hour, so 1,000 selfies need at
// least 200 cookies; with fewer, the extra iterations get 429 and are counted in
// selfie_errors. Consent is granted once per cookie in setup (idempotent).

import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:8787").replace(/\/$/, "");
const EVENT_SLUG = __ENV.EVENT_SLUG || "demo";
const COOKIES = (__ENV.PARTICIPANT_COOKIES || "").split(",").map((s) => s.trim()).filter(Boolean);
const CONSENT_TEXT_VERSION = __ENV.CONSENT_TEXT_VERSION || "2026-10-06";
const TOTAL = Number(__ENV.SELFIES || 1000);
const DURATION_MIN = Number(__ENV.DURATION_MINUTES || 10);
const POLL_SECONDS = Number(__ENV.POLL_SECONDS || 2);
const READY_TIMEOUT_SECONDS = Number(__ENV.READY_TIMEOUT_SECONDS || 300);

const FIXTURE = open("./fixtures/sample.jpg", "b");

export const options = {
  scenarios: {
    selfies: {
      executor: "constant-arrival-rate",
      rate: Math.ceil(TOTAL / DURATION_MIN),
      timeUnit: "1m",
      duration: `${DURATION_MIN}m`,
      preAllocatedVUs: 50,
      maxVUs: 400,
    },
  },
  thresholds: {
    time_to_ready: ["p(95)<60000"],
    selfie_post: ["p(95)<1000"],
    selfie_errors: ["count<20"],
  },
};

const postTrend = new Trend("selfie_post", true);
const readyTrend = new Trend("time_to_ready", true);
const pollTrend = new Trend("gallery_poll", true);
const errors = new Counter("selfie_errors");
const timeouts = new Counter("ready_timeouts");
const ready = new Counter("galleries_ready");

function cookieHeader(cookie) {
  return { Cookie: `rephoto_session=${cookie}` };
}

export function setup() {
  if (COOKIES.length === 0) fail("PARTICIPANT_COOKIES is empty");
  const ev = http.get(`${BASE_URL}/v1/events/${EVENT_SLUG}`);
  if (ev.status !== 200) fail(`GET /v1/events/${EVENT_SLUG} -> ${ev.status}`);
  for (const cookie of COOKIES) {
    const res = http.post(
      `${BASE_URL}/v1/events/${EVENT_SLUG}/consent`,
      JSON.stringify({ textVersion: CONSENT_TEXT_VERSION, accepted: true }),
      { headers: Object.assign({ "Content-Type": "application/json" }, cookieHeader(cookie)) },
    );
    if (res.status !== 201) console.error(`consent for cookie ...${cookie.slice(-6)} -> ${res.status}: ${res.body}`);
  }
  return {};
}

export default function () {
  // Spread iterations over the cookies: __ITER is per VU, so mix in the VU id.
  const cookie = COOKIES[(__VU * 7919 + __ITER) % COOKIES.length];
  const headers = cookieHeader(cookie);
  const started = Date.now();

  const post = http.post(
    `${BASE_URL}/v1/events/${EVENT_SLUG}/selfie`,
    { selfie: http.file(FIXTURE, "selfie.jpg", "image/jpeg") },
    { headers, tags: { step: "selfie" } },
  );
  postTrend.add(post.timings.duration);
  if (!check(post, { "selfie 202": (r) => r.status === 202 })) {
    errors.add(1);
    console.error(`selfie ${post.status}: ${post.body}`);
    return;
  }

  const deadline = started + READY_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    sleep(POLL_SECONDS);
    const res = http.get(`${BASE_URL}/v1/events/${EVENT_SLUG}/gallery?limit=1`, {
      headers,
      tags: { step: "poll" },
    });
    pollTrend.add(res.timings.duration);
    if (res.status !== 200) {
      errors.add(1);
      console.error(`gallery ${res.status}: ${res.body}`);
      return;
    }
    if (res.json("status") === "ready") {
      ready.add(1);
      readyTrend.add(Date.now() - started);
      return;
    }
  }
  timeouts.add(1);
}
