import type { JobDetail, JobSummary, RepoConfigRecord, StatsPayload } from './schema';

export type AuthSessionUser = {
  githubUserId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  signedInAt: string;
};

export type JobsResponse = {
  jobs: JobSummary[];
  total: number;
};

export const apiActions = [
  'jobs.read',
  'jobs.retry',
  'jobs.rerun',
  'jobs.stop',
  'jobs.delete',
  'jobs.label',
  'repos.read',
  'repos.install',
  'repos.sync',
  'repos.config.write',
  'models.read',
  'models.sync',
  'models.test',
  'models.provider.create',
  'models.provider.update',
  'models.provider.delete',
  'models.mapping.write',
  'models.global.write',
  'settings.read',
  'settings.write',
  'stats.read',
  'account.write',
  'account.updatesEmail.write',
  'reviews.enqueue',
] as const;

export type KnownApiAction = (typeof apiActions)[number];

// Open union: consumers can add their own action names while the known list keeps autocomplete.
export type ApiAction = KnownApiAction | (string & {});

export type AuthSessionResponse = {
  user: AuthSessionUser;
  // Omitted, or a '*' entry, means "allow everything".
  permissions?: string[];
};

// Durable account record persisted in D1 (account_settings).
export type AccountSettings = {
  // Stable, unique account id (uuid) - distinct from the GitHub user id.
  id: string;
  githubUserId: number;
  githubUsername: string;
  accountName: string | null;
  accountEmail: string | null;
  // Presentation only (timestamps are always stored UTC); `null` means "follow the viewer's browser timezone".
  timezone: string | null;
};

export type AccountResponse = {
  account: AccountSettings;
};

export type UpdatesEmailStatus = 'pending' | 'subscribed';

export type UpdatesEmailResponse = {
  status: UpdatesEmailStatus;
  email: string | null;
  updatedAt: string | null;
};

export type JobDetailResponse = {
  job: JobDetail;
};

/** Per-file reconstructed diff/prompt text, fetched on demand (see GET /api/jobs/:id/diffs) --
    diff_input isn't persisted in D1, so this comes from KV or a fresh GitHub fetch. Files
    with no entry are unavailable (e.g. the underlying commits are gone). */
export type JobDiffsResponse = {
  diffs: Record<string, string>;
};

export type RetryJobResponse = {
  job: JobSummary;
};

export type RepoConfigsResponse = {
  repos: RepoConfigRecord[];
};

export type RepoConfigResponse = {
  repo: RepoConfigRecord;
};

export type StatsResponse = {
  stats: StatsPayload;
};

export type SyncReposResponse = {
  ok: boolean;
  partial: boolean;
  synced: string[];
  failures: Array<{
    installationId: string;
    repository?: string;
    stage: 'inventory' | 'write' | 'cleanup';
    error: string;
  }>;
};


export type ModelConfigsResponse = {
  providers: import('./schema').LlmProvider[];
  configs: import('./schema').ModelConfig[];
  syncErrors?: Array<{ providerId: string; providerName: string; error: string }>;
};
