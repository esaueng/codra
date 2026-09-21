import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../../ports';
import { requirePermission, requireQuota } from '../../middleware/authorize';
import { jsonError } from '../../http';
import { repoConfigSchema } from '@codraoss/schema';

const repoConfigPatchSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    review: repoConfigSchema.shape.review.optional(),
    model: repoConfigSchema.shape.model.optional(),
  })
  .refine(
    (patch) => patch.enabled !== undefined || patch.review !== undefined || patch.model !== undefined,
    'Repository config patch cannot be empty.',
  );

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createReposRouter() {
  const app = new Hono<ApiEnv>();

  app.get('/', async (c) => {
    const denied = await requirePermission(c, 'repos.read');
    if (denied) return denied;
    const repos = await c.env.deps.repositories.repoConfigs.listRepoConfigs(c.env as any);
    return c.json({ repos });
  });

  app.get('/install', async (c) => {
    const denied = await requirePermission(c, 'repos.install');
    if (denied) return denied;
    try {
      return c.redirect(await c.env.deps.gitProvider.getAppInstallationUrl(), 302);
    } catch (error) {
      c.env.deps.platform.logger.error('Failed to resolve GitHub App installation URL:', error);
      return jsonError(`Failed to resolve GitHub App installation URL: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  });

  app.post('/sync', async (c) => {
    const denied = await requirePermission(c, 'repos.sync');
    if (denied) return denied;
    const throttled = await requireQuota(c, { action: 'repos.sync' });
    if (throttled) return throttled;
    try {
      const installations = await c.env.deps.gitProvider.listInstallations();
      const synced: string[] = [];
      const failures: Array<{
        installationId: string;
        repository?: string;
        stage: 'inventory' | 'write' | 'cleanup';
        error: string;
      }> = [];
      const repoConfigs = c.env.deps.repositories.repoConfigs;

      for (const inst of installations) {
        const installationId = String(inst.id);
        const github = c.env.deps.gitProvider.createService(String(inst.id));
        let repos: any[];
        try {
          repos = await github.listRepositories();
        } catch (inventoryError) {
          const error = inventoryError instanceof Error ? inventoryError.message : String(inventoryError);
          failures.push({ installationId, stage: 'inventory', error });
          c.env.deps.platform.logger.error(`Failed to retrieve complete repository inventory for installation ${installationId}; stale cleanup skipped`, inventoryError);
          continue;
        }

        // Retention is based only on GitHub's complete inventory. A DB write failure must never make
        // a still-installed repository look stale and erase its settings.
        const activeRepoFullNames = repos.map((repo: any) => `${repo.owner.login}/${repo.name}`);

        const results = await mapWithConcurrency(
          repos,
          5,
          async (repo: any) => {
            const owner = repo.owner.login;
            const name = repo.name;
            const fullName = `${owner}/${name}`;
            try {
              await repoConfigs.syncRepoConfig(c.env as any, {
                installationId,
                owner,
                repo: name,
              });
              return fullName;
            } catch (repoError) {
              c.env.deps.platform.logger.error(`Failed to sync repo: ${fullName}`, repoError);
              failures.push({
                installationId,
                repository: fullName,
                stage: 'write',
                error: repoError instanceof Error ? repoError.message : String(repoError),
              });
              return null;
            }
          },
        );

        for (const res of results) {
          if (res) {
            synced.push(res);
          }
        }

        try {
          await repoConfigs.deleteStaleRepoConfigs(c.env as any, installationId, activeRepoFullNames);
        } catch (cleanupError) {
          failures.push({
            installationId,
            stage: 'cleanup',
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
          c.env.deps.platform.logger.error(`Failed to clean stale repositories for installation ${installationId}`, cleanupError);
        }
      }

      return c.json({ ok: failures.length === 0, partial: failures.length > 0, synced, failures });
    } catch (error) {
      c.env.deps.platform.logger.error('Manual sync failed:', error);
      return jsonError(`Sync failed: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  });

  app.get('/:owner/:repo/config', async (c) => {
    const denied = await requirePermission(c, 'repos.read', { type: 'repo', id: `${c.req.param('owner')}/${c.req.param('repo')}` });
    if (denied) return denied;
    const repo = await c.env.deps.repositories.repoConfigs.getRepoConfigRecord(c.env as any, c.req.param('owner'), c.req.param('repo'));
    if (!repo) {
      return jsonError('Repository config not found.', 404);
    }

    return c.json({ repo });
  });
  
  app.patch('/:owner/:repo/config', async (c) => {
    const denied = await requirePermission(c, 'repos.config.write', { type: 'repo', id: `${c.req.param('owner')}/${c.req.param('repo')}` });
    if (denied) return denied;
    const { owner, repo } = c.req.param();
    const body = await c.req.json();
    const parsedPatch = repoConfigPatchSchema.safeParse(body);
    if (!parsedPatch.success) {
      return jsonError('Invalid repository config patch.', 400);
    }

    const repoConfigs = c.env.deps.repositories.repoConfigs;
    const existing = await repoConfigs.getRepoConfigRecord(c.env as any, owner, repo);
    
    if (!existing) {
      return jsonError('Repository config not found.', 404);
    }

    const patch = parsedPatch.data;
    const hasConfigPatch = patch.review !== undefined || patch.model !== undefined;

    if (!hasConfigPatch && patch.enabled !== undefined) {
      await repoConfigs.updateRepoConfigEnabled(c.env as any, {
        owner,
        repo,
        enabled: patch.enabled,
      });
      await c.env.deps.config.invalidateRepoConfigCache(owner, repo);
      return c.json({ ok: true });
    }

    const configPatch: Partial<z.infer<typeof repoConfigSchema>> = {};
    if (patch.review !== undefined) {
      configPatch.review = patch.review;
    }
    if (patch.model !== undefined) {
      configPatch.model = patch.model;
    }
    
    const updatedParsedJson = {
      ...existing.parsedJson,
      ...configPatch,
    };
    const parsedConfig = repoConfigSchema.safeParse(updatedParsedJson);

    if (!parsedConfig.success) {
      return jsonError('Invalid repository config.', 400);
    }
    
    await repoConfigs.upsertRepoConfig(c.env as any, {
      installationId: existing.installationId,
      owner,
      repo,
      parsedJson: parsedConfig.data,
      enabled: patch.enabled,
    });
    await c.env.deps.config.invalidateRepoConfigCache(owner, repo);
    
    return c.json({ ok: true });
  });

  return app;
}
