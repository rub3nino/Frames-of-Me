import { z } from "zod";

export const jobTypeSchema = z.enum([
  "derive",
  "index",
  "attach",
  "match",
  "email",
  "retention",
  "verify",
  "reset",
]);
export type JobType = z.infer<typeof jobTypeSchema>;

export const jobStatusSchema = z.enum(["queued", "running", "done", "error"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const photoStatusSchema = z.enum([
  "uploaded",
  "processing",
  "indexed",
  "error",
]);
export type PhotoStatus = z.infer<typeof photoStatusSchema>;

const photoId = z.string().uuid();

export const derivePayloadSchema = z
  .object({ photoId })
  .strict();
export const indexPayloadSchema = z
  .object({ photoId })
  .strict();
export const attachPayloadSchema = z
  .object({ photoId })
  .strict();
/** Checks the original of a web-first photo against `photos.sha256` / `photos.bytes`. */
export const verifyPayloadSchema = z
  .object({ photoId })
  .strict();
export const matchPayloadSchema = z
  .object({
    userId: z.string().uuid(),
    eventId: z.string().uuid(),
    selfieKey: z.string().min(1),
  })
  .strict();
/** `tagged` is v6 E (agent E): someone tagged the recipient in a photo. */
export const emailKindSchema = z.enum(["ready", "new", "tagged"]);
export type EmailKind = z.infer<typeof emailKindSchema>;
export const emailPayloadSchema = z
  .object({
    userId: z.string().uuid(),
    eventId: z.string().uuid(),
    galleryPath: z.string().min(1),
    kind: emailKindSchema,
  })
  .strict();

export type DerivePayload = z.infer<typeof derivePayloadSchema>;
export type IndexPayload = z.infer<typeof indexPayloadSchema>;
export type AttachPayload = z.infer<typeof attachPayloadSchema>;
export type VerifyPayload = z.infer<typeof verifyPayloadSchema>;
export type MatchPayload = z.infer<typeof matchPayloadSchema>;
export type EmailPayload = z.infer<typeof emailPayloadSchema>;

export const retentionPayloadSchema = z
  .object({
    eventId: z.string().uuid(),
    /**
     * The admin who asked, or null when the scheduler enqueued it (v6 G). It is not a free
     * identifier: `audit_log.actor_id` references `users (id)`, so an invented uuid would
     * break every audit row the job writes.
     */
    actorId: z.string().uuid().nullable().default(null),
  })
  .strict();

export type RetentionPayload = z.infer<typeof retentionPayloadSchema>;

/**
 * Deletes every photo of the event (retention with cutoff `now`), its galleries, its
 * match log and the engine collection. Enqueued by `POST /v1/admin/events/:id/reset`.
 */
export const resetPayloadSchema = z
  .object({
    eventId: z.string().uuid(),
    actorId: z.string().uuid(),
  })
  .strict();

export type ResetPayload = z.infer<typeof resetPayloadSchema>;

export const JOB_MAX_ATTEMPTS = 5;

/** A `running` job older than this returns to `queued` without counting as a failure. */
export const STALE_RUNNING_MS = 10 * 60 * 1000;

/** Wait before claiming a throttled job again. Attempts are not incremented. */
export const THROTTLE_REQUEUE_SECONDS = 5;

/**
 * Lower runs first. `index` runs before `derive` so the face service is fed as soon as a
 * derivative exists instead of idling behind a backlog of derives (v5, B).
 */
export const JOB_PRIORITY: Record<JobType, number> = {
  match: 0,
  email: 10,
  attach: 30,
  index: 40,
  derive: 50,
  verify: 70,
  retention: 90,
  reset: 90,
};

/**
 * Key that collapses duplicate active jobs. `null` when the type is never deduped.
 * Payload fields are read loosely so a malformed payload still yields a stable key.
 */
export function jobDedupeKey(type: JobType, payload: unknown): string | null {
  const record = (payload ?? {}) as Record<string, unknown>;
  const field = (name: string): string => String(record[name] ?? "");
  switch (type) {
    case "derive":
    case "index":
    case "attach":
    case "verify":
      return `${type}:${field("photoId")}`;
    case "email":
      return `email:${field("kind")}:${field("userId")}:${field("eventId")}`;
    case "retention":
      return `retention:${field("eventId")}`;
    case "reset":
      return `reset:${field("eventId")}`;
    case "match":
      return null;
  }
}
