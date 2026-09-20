import type { D1Binding, DbEnv } from './env';

export type SqlStatement = {
  sql: string;
  params?: unknown[];
};

function toD1Sql(sqlText: string) {
  return sqlText.replace(/\$(\d+)/g, '?$1');
}

function normalizeParam(param: unknown): unknown {
  if (param === undefined) return null;
  if (typeof param === 'boolean') return param ? 1 : 0;
  if (ArrayBuffer.isView(param)) {
    return param.buffer.slice(param.byteOffset, param.byteOffset + param.byteLength);
  }
  return param;
}

function prepare(db: Pick<D1Binding, 'prepare'>, statement: SqlStatement) {
  const prepared = db.prepare(toD1Sql(statement.sql));
  const params = (statement.params ?? []).map(normalizeParam);
  return params.length > 0 ? prepared.bind(...params) : prepared;
}

export async function queryRows<T>(env: Pick<DbEnv, 'DB'>, sqlText: string, params: unknown[] = []) {
  const result = await prepare(env.DB, { sql: sqlText, params }).all<T>();
  return result.results;
}

// Compatibility shim for callers that need a small query-shaped test seam.
export function getDb(env: Pick<DbEnv, 'DB'>) {
  return { query: <T>(sqlText: string, params: unknown[] = []) => queryRows<T>(env, sqlText, params) };
}

// D1 batches are atomic and execute sequentially. Use this for multi-statement writes instead of
// emulating an interactive transaction, which D1 intentionally does not expose to Workers.
export async function queryBatch<T = Record<string, unknown>>(
  env: Pick<DbEnv, 'DB'>,
  statements: SqlStatement[],
) {
  if (statements.length === 0) return [];
  const results = await env.DB.batch<T>(statements.map((statement) => prepare(env.DB, statement)));
  return results.map((result) => result.results);
}

// Retained as a no-op boundary so callers do not need platform-specific request-context plumbing.
// D1 bindings are safe to pass directly and do not create TCP connections.
export function runWithDb<T>(_env: Pick<DbEnv, 'DB'>, fn: () => T): T {
  return fn();
}

export function parseJsonColumn<T>(value: T | string | null | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value;
}

export function newId() {
  return crypto.randomUUID();
}

export const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
