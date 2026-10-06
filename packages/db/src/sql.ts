import postgres from "postgres";

export function createSql(databaseUrl: string): postgres.Sql {
  return postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    onnotice: () => undefined,
  });
}

export type Sql = ReturnType<typeof createSql>;

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}
