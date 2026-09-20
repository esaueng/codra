declare interface Ai {
  run(model: string, input: Record<string, unknown>): Promise<any>;
}

declare interface Env {
  AI: Ai;
  APP_KV: KVNamespace;
  REVIEW_QUEUE: Queue<any>;
  REVIEW_WORKFLOW: Workflow;
  ASSETS: Fetcher;
  DB: D1Database;
  APP_PRIVATE_KEY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_WEBHOOK_SECRET: string;
  LLM_CONFIG_ENCRYPTION_KEY: string;
  GEMINI_MODEL: string;
  BOT_USERNAME: string;
  ENVIRONMENT: string;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
}
