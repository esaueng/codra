import { createApiRouter } from '@codraoss/api';
import type { ApiRouterDeps } from '@codraoss/api';
import { getJobForProcessing, insertJob } from '@codraoss/db/jobs';

import { getRepoConfigRecord, syncRepoConfig, updateRepoConfigEnabled } from '@codraoss/db/repo-configs';
import { loadRepoConfig, updateGlobalConfig } from '@server/core/config';
import { GitHubClient } from '@codraoss/provider-github';

import { defaultRepoConfig } from '@codraoss/schema';
import { createTestEnv, responseCookie, uniqueName } from '../helpers';
import { vi } from 'vitest';


describe('Dashboard API: repositories and repo config', () => {
  const app = createApiRouter();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function getAuthCookie(env = createTestEnv(), login = 'devarshishimpi', githubUserId = 42) {
    if (env.IDENTITY_PROVIDER && 'defaultUser' in env.IDENTITY_PROVIDER) {
      (env.IDENTITY_PROVIDER as any).defaultUser = {
        provider: 'github',
        providerUserId: githubUserId.toString(),
        login,
        name: 'Devarshi Shimpi',
        avatarUrl: `https://avatars.githubusercontent.com/u/${githubUserId}`,
        email: null,
        signedInAt: new Date().toISOString(),
        metadata: {
          githubUserId,
          githubUsername: login,
        },
      };
    }

    const authStart = await app.request('/auth/github', {}, env);
    const authLocation = authStart.headers.get('location');
    expect(authStart.status).toBe(302);
    expect(authLocation).toBeTruthy();

    const state = authLocation ? new URL(authLocation).searchParams.get('state') : null;
    expect(state).toBeTruthy();

    const callback = await app.request(`/auth/github/callback?code=test-code&state=${state}`, {
      headers: { Cookie: responseCookie(authStart, 'codra_oauth_state') },
    }, env);
    const cookieHeader = callback.headers.get('set-cookie') || '';
    const match = cookieHeader.match(/codra_session=([^;]+)/);

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/dashboard');

    return match ? match[1] : '';
  }

  it('preserves path separators when fetching nested GitHub contents', async () => {
    const env = createTestEnv();
    await env.APP_KV.put('install:123', JSON.stringify({
      token: 'cached-installation-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));

    let requestedUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requestedUrl = String(input);
      return Response.json({
        content: Buffer.from('hello').toString('base64'),
        encoding: 'base64',
      });
    });

    const client = new GitHubClient(env, '123');
    const content = await client.getRepoFile('owner', 'repo', 'src/path with spaces/app.ts');

    expect(content).toBe('hello');
    expect(requestedUrl).toBe('https://api.github.com/repos/owner/repo/contents/src/path%20with%20spaces/app.ts');
  });

  it('pins repo file reads to the requested ref', async () => {
    const env = createTestEnv();
    await env.APP_KV.put('install:123', JSON.stringify({
      token: 'cached-installation-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));

    let requestedUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requestedUrl = String(input);
      return Response.json({
        content: Buffer.from('const greeting = "café — こんにちは";').toString('base64'),
        encoding: 'base64',
      });
    });

    const client = new GitHubClient(env, '123');
    const content = await client.getRepoFile('owner', 'repo', 'src/app.ts', 'abc123');

    expect(content).toBe('const greeting = "café — こんにちは";');
    expect(requestedUrl).toBe('https://api.github.com/repos/owner/repo/contents/src/app.ts?ref=abc123');
  });

  it('retains repository settings and reports a partial sync when one database write fails', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const installationId = uniqueName('installation');
    const retainedRepo = uniqueName('retained-repo');
    const staleRepo = uniqueName('stale-repo');
    await syncRepoConfig(env, { installationId, owner: 'sync-owner', repo: retainedRepo });
    await updateRepoConfigEnabled(env, { owner: 'sync-owner', repo: retainedRepo, enabled: false });
    await syncRepoConfig(env, { installationId, owner: 'sync-owner', repo: staleRepo });

    const deps = (env as any).deps as ApiRouterDeps;
    deps.gitProvider.listInstallations = async () => [{ id: installationId }];
    deps.gitProvider.createService = () => ({
      listRepositories: async () => [{ owner: { login: 'sync-owner' }, name: retainedRepo }],
    });
    const originalSync = deps.repositories.repoConfigs.syncRepoConfig;
    vi.spyOn(deps.repositories.repoConfigs, 'syncRepoConfig').mockImplementation(async (dbEnv, input) => {
      if (input.repo === retainedRepo) throw new Error('database write failed');
      return originalSync(dbEnv, input);
    });

    const response = await app.request('/api/repos/sync', {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    }, env);
    const result = await response.json() as any;

    expect(response.status).toBe(200);
    expect(result).toMatchObject({ ok: false, partial: true, synced: [] });
    expect(result.failures).toEqual([
      expect.objectContaining({ installationId, repository: `sync-owner/${retainedRepo}`, stage: 'write' }),
    ]);
    expect((await getRepoConfigRecord(env, 'sync-owner', retainedRepo))?.enabled).toBe(false);
    expect(await getRepoConfigRecord(env, 'sync-owner', staleRepo)).toBeNull();
  });

  it('skips destructive cleanup when an installation inventory is incomplete', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const installationId = uniqueName('inventory-installation');
    const retainedRepo = uniqueName('inventory-retained');
    await syncRepoConfig(env, { installationId, owner: 'sync-owner', repo: retainedRepo });

    const deps = (env as any).deps as ApiRouterDeps;
    deps.gitProvider.listInstallations = async () => [{ id: installationId }];
    deps.gitProvider.createService = () => ({
      listRepositories: async () => { throw new Error('GitHub pagination failed'); },
    });

    const response = await app.request('/api/repos/sync', {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    }, env);
    const result = await response.json() as any;

    expect(result).toMatchObject({ ok: false, partial: true });
    expect(result.failures).toEqual([
      expect.objectContaining({ installationId, stage: 'inventory' }),
    ]);
    expect(await getRepoConfigRecord(env, 'sync-owner', retainedRepo)).not.toBeNull();
  });

  it('keeps repo model settings inherited when loading global strategy', async () => {
    const env = createTestEnv();
    const repo = uniqueName('global-inherit');

    await updateGlobalConfig(env, {
      main: '@cf/zai-org/glm-4.7-flash',
      fallbacks: [],
      size_overrides: [],
    });

    const loaded = await loadRepoConfig(env, {
      installationId: '123',
      owner: 'api-test-owner',
      repo,
    });

    expect(loaded.parsedJson.model.main).toBe('@cf/zai-org/glm-4.7-flash');
    expect(loaded.parsedJson.model.fallbacks).toEqual([]);

    const record = await getRepoConfigRecord(env, 'api-test-owner', repo);
    expect(record?.mainModel).toBeNull();
    expect(record?.fallbackModels).toBeNull();
    expect(record?.sizeOverrides).toBeNull();

    await updateGlobalConfig(env, {
      main: 'gemma-4-26b-a4b-it',
      fallbacks: ['@cf/zai-org/glm-4.7-flash'],
      size_overrides: [],
    });

    const reloaded = await loadRepoConfig(env, {
      installationId: '123',
      owner: 'api-test-owner',
      repo,
    });

    expect(reloaded.parsedJson.model.main).toBe('gemma-4-26b-a4b-it');
  });

  it('uses the current global model strategy when retrying an older job', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = uniqueName('retry-current-config');

    const source = await insertJob(env, {
      installationId: '123',
      owner: 'api-test-owner',
      repo,
      prNumber: 12,
      prTitle: 'Retry Current Config',
      prAuthor: 'author',
      commitSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: {
        ...defaultRepoConfig,
        model: {
          main: 'gemma-4-31b-it',
          fallbacks: ['gemma-4-26b-a4b-it', '@cf/zai-org/glm-4.7-flash'],
          size_overrides: [],
        },
      },
    });

    await updateGlobalConfig(env, {
      main: 'gemma-4-31b-it',
      fallbacks: ['gemma-4-26b-a4b-it'],
      size_overrides: [
        {
          max_lines: 300,
          model: 'gemma-4-31b-it',
          fallbacks: ['gemma-4-26b-a4b-it'],
        },
      ],
    });

    const response = await app.request(`/api/jobs/${source.id}/retry`, {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    }, env);

    expect(response.status).toBe(202);
    const body = await response.json() as { job: { id: string } };
    const retry = await getJobForProcessing(env, body.job.id);
    const snapshot = typeof retry?.config_snapshot === 'string'
      ? JSON.parse(retry.config_snapshot)
      : retry?.config_snapshot;

    expect(snapshot.model).toEqual({
      main: 'gemma-4-31b-it',
      fallbacks: ['gemma-4-26b-a4b-it'],
      size_overrides: [
        {
          max_lines: 300,
          model: 'gemma-4-31b-it',
          fallbacks: ['gemma-4-26b-a4b-it'],
        },
      ],
    });
  });
});
