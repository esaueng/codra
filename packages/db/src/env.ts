export type DbEnv = {
  DB: D1Database;
  APP_KV: {
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    get(key: string): Promise<string | null>;
    delete(key: string): Promise<void>;
  };
};
