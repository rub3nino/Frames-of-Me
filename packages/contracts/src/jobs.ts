import { z } from "zod";

export const jobTypeSchema = z.enum(["derive", "index", "match", "email"]);
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
export const matchPayloadSchema = z
  .object({
    userId: z.string().uuid(),
    eventId: z.string().uuid(),
    selfieKey: z.string().min(1),
  })
  .strict();
export const emailPayloadSchema = z
  .object({
    userId: z.string().uuid(),
    eventId: z.string().uuid(),
    galleryPath: z.string().min(1),
  })
  .strict();

export type DerivePayload = z.infer<typeof derivePayloadSchema>;
export type IndexPayload = z.infer<typeof indexPayloadSchema>;
export type MatchPayload = z.infer<typeof matchPayloadSchema>;
export type EmailPayload = z.infer<typeof emailPayloadSchema>;

export const JOB_MAX_ATTEMPTS = 5;
