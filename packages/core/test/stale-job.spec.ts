import { describe, expect, it } from 'vitest';
import { runReview } from '../src/review';
import { createInMemoryRuntime } from './in-memory';

describe('stale review jobs', () => {
  it('cancels a job before GitHub writes or model work when the PR head has moved', async () => {
    const { runtime, recorded } = createInMemoryRuntime();
    const createGitHub = runtime.createGitHub;
    runtime.createGitHub = (...args) => {
      const github = createGitHub(...args);
      return {
        ...github,
        getPullRequest: async (...requestArgs) => ({
          ...await github.getPullRequest(...requestArgs),
          head: { sha: 'f'.repeat(40), ref: 'new-head' },
        }),
      };
    };

    const [job] = recorded.jobs.values();
    const result = await runReview(runtime, { jobId: job.id, phase: 'prepare' });

    expect(result).toEqual({ action: 'ack' });
    expect(recorded.jobs.get(job.id)?.status).toBe('cancelled');
    expect(recorded.calls).toContain('cancelJob');
    expect(recorded.calls).not.toContain('getPullRequestDiff');
    expect(recorded.checkRuns).toHaveLength(0);
  });

  it('revalidates the head again before a later workflow phase', async () => {
    const { runtime, recorded } = createInMemoryRuntime({ job: { status: 'running' } });
    const createGitHub = runtime.createGitHub;
    runtime.createGitHub = (...args) => {
      const github = createGitHub(...args);
      return {
        ...github,
        getPullRequest: async (...requestArgs) => ({
          ...await github.getPullRequest(...requestArgs),
          head: { sha: 'e'.repeat(40), ref: 'new-head' },
        }),
      };
    };

    const [job] = recorded.jobs.values();
    const result = await runReview(runtime, { jobId: job.id, phase: 'review' });

    expect(result).toEqual({ action: 'ack' });
    expect(recorded.jobs.get(job.id)?.status).toBe('cancelled');
    expect(recorded.calls.some((call) => call.startsWith('reviewFile'))).toBe(false);
    expect(recorded.postedReviews).toHaveLength(0);
  });
});
