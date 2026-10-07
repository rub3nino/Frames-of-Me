import postgres from "postgres";

export type CreateSqlOptions = {
  /** Pool size; `DATABASE_POOL_MAX`. */
  max?: number;
};

export function createSql(databaseUrl: string, options: CreateSqlOptions = {}): postgres.Sql {
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
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
