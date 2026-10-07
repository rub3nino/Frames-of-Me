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

/**
 * Runs `fn` inside a transaction: `begin` at the top level, `savepoint` when a
 * transaction is already open on this handle.
 *
 * postgres.js puts `begin` on the pool and `savepoint` on a transaction handle, so a
 * method that opens its own transaction (`setUserPassword` retiring the reset tokens, the
 * album writes, the retention sweep) throws `sql.begin is not a function` the moment it is
 * called inside one. Routing every such method through here is what lets
 * `Database.transaction` contain them: the inner scope becomes a savepoint, so it still
 * rolls back on its own and still rolls back with the transaction around it.
 */
export function inTransaction<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  // The casts are the price of postgres.js splitting the two across two types: the
  // callback is handed a `TransactionSql`, whose query surface is the one `fn` uses, and
  // `begin` declares `UnwrapPromiseArray<T>` for the array case.
  const scope = fn as unknown as (tx: postgres.TransactionSql) => Promise<T>;
  const nested = sql as unknown as {
    savepoint?: (callback: (tx: postgres.TransactionSql) => Promise<T>) => Promise<T>;
  };
  if (typeof nested.savepoint === "function") return nested.savepoint(scope);
  return sql.begin(scope) as Promise<T>;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}
