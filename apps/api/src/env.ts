import { envSchema, type Env } from "@rephoto/contracts";

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join(".") || "env")
      .join(", ");
    throw new Error(`Invalid environment: ${fields}`);
  }
  return parsed.data;
}
