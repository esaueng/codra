import { createApiRouter } from '@codraoss/api';
import { createMockPRWebhook, createTestEnv, uniqueName } from '../helpers';

import { signPayload } from '../mocks/fixtures';
import { queryRows } from '@codraoss/db/client';
import { retryPendingWebhookSubmissions } from '@server/core/job-recovery';
import { vi } from 'vitest';

describe('Webhook Handling Suite', () => {
  const env = createTestEnv();
  const app = createApiRouter();

  // Invariant: handling a webhook must never call GitHub -- that's what keeps it inside GitHub's
  // 10s delivery timeout (review work happens later, in the Workflow). Spy rather than stub so a
  // future GitHub call surfaces the URL instead of hanging on a real fetch.
  const githubRequests: string[] = [];
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    // Records and passes through: the DB driver is free to use fetch, only github.com is the concern.
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('github.com')) githubRequests.push(url);
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    expect(githubRequests).toEqual([]);
  });

  beforeEach(() => {
    (env.REVIEW_QUEUE as any).sent.length = 0;
  });

  it('rejects webhooks with invalid signatures', async () => {
    const payload = JSON.stringify(createMockPRWebhook());
    const response = await app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': 'delivery-inv',
          'x-hub-signature-256': 'sha256=invalid',
        },
        body: payload,
      },
      env,
    );

    expect(response.status).toBe(401);
  });

  it('rejects signed malformed webhook JSON with a 400', async () => {
    const body = '{"not": "valid"';
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': uniqueName('malformed'),
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );

    expect(response.status).toBe(400);
  });

  it('accepts valid pull_request.opened and queues a job', async () => {
    const repoName = uniqueName('repo');
    const rawPayload = createMockPRWebhook({
        action: 'opened',
        repository: { name: repoName, owner: { login: 'test-owner' } }
    });
    rawPayload.pull_request.head.sha = 'a'.repeat(40);
    rawPayload.pull_request.base.sha = 'b'.repeat(40);
    const body = JSON.stringify(rawPayload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': uniqueName('delivery'),
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );

    const json = await response.json() as any;
    expect(response.status).toBe(202);
    expect(json.ok).toBe(true);
    expect(json.message).toBe('queued');
    expect(json.job.status).toBe('queued');

    const queue = env.REVIEW_QUEUE as any;
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0].jobId).toBe(json.job.id);
    expect(queue.sent[0].deliveryId).toBeDefined();
    expect(queue.sent[0].phase).toBe('prepare');
    expect(queue.sent[0].eventName).toBeUndefined();
    expect(queue.sent[0].payload).toBeUndefined();
  });

  it('does not queue synchronize reviews for contributors without a repository role', async () => {
    const rawPayload = createMockPRWebhook({
      action: 'synchronize',
      repository: { name: uniqueName('external-sync'), owner: { login: 'test-owner' } },
    });
    rawPayload.pull_request.author_association = 'NONE';
    rawPayload.pull_request.head.sha = 'c'.repeat(40);
    rawPayload.pull_request.base.sha = 'd'.repeat(40);
    const body = JSON.stringify(rawPayload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request('http://codra.test/webhook', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': uniqueName('external-sync-delivery'),
        'x-hub-signature-256': signature,
      },
      body,
    }, env);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, ignored: true });
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
  });

  it('continues to queue synchronize reviews for repository collaborators', async () => {
    const rawPayload = createMockPRWebhook({
      action: 'synchronize',
      repository: { name: uniqueName('trusted-sync'), owner: { login: 'test-owner' } },
    });
    rawPayload.pull_request.author_association = 'COLLABORATOR';
    rawPayload.pull_request.head.sha = 'e'.repeat(40);
    rawPayload.pull_request.base.sha = 'f'.repeat(40);
    const body = JSON.stringify(rawPayload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request('http://codra.test/webhook', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': uniqueName('trusted-sync-delivery'),
        'x-hub-signature-256': signature,
      },
      body,
    }, env);

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, message: 'queued' });
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(1);
  });

  it('resumes an unsent queue submission when GitHub redelivers the webhook', async () => {
    const recoveryEnv = createTestEnv();
    const repoName = uniqueName('redelivery-recovery');
    const deliveryId = uniqueName('delivery-recovery');
    const payload = createMockPRWebhook({
      action: 'opened',
      repository: { name: repoName, owner: { login: 'test-owner' } },
    });
    payload.pull_request.head.sha = '1'.repeat(40);
    payload.pull_request.base.sha = '2'.repeat(40);
    const body = JSON.stringify(payload);
    const signature = await signPayload(recoveryEnv.GITHUB_APP_WEBHOOK_SECRET, body);
    const queue = recoveryEnv.REVIEW_QUEUE as any;
    const originalSend = queue.send.bind(queue);
    vi.spyOn(queue, 'send').mockRejectedValueOnce(new Error('queue unavailable')).mockImplementation(originalSend);
    const request = () => app.request('http://codra.test/webhook', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      body,
    }, recoveryEnv);

    const first = await request();
    expect(await first.json()).toMatchObject({ ok: true, message: 'queue_pending' });
    expect(queue.sent).toHaveLength(0);

    const redelivery = await request();
    const redeliveryBody = await redelivery.json() as any;
    expect(redeliveryBody).toMatchObject({ ok: true, duplicate: true, message: 'queued' });
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0].jobId).toBe(redeliveryBody.job.id);

    const jobs = await queryRows<{ count: number }>(
      recoveryEnv,
      'SELECT COUNT(*) AS count FROM jobs WHERE webhook_delivery_id = $1',
      [deliveryId],
    );
    expect(Number(jobs[0].count)).toBe(1);
  });

  it('retries unsent webhook queue submissions through maintenance', async () => {
    const recoveryEnv = createTestEnv();
    const deliveryId = uniqueName('maintenance-recovery');
    const payload = createMockPRWebhook({
      action: 'opened',
      repository: { name: uniqueName('maintenance-repo'), owner: { login: 'test-owner' } },
    });
    payload.pull_request.head.sha = '3'.repeat(40);
    payload.pull_request.base.sha = '4'.repeat(40);
    const body = JSON.stringify(payload);
    const signature = await signPayload(recoveryEnv.GITHUB_APP_WEBHOOK_SECRET, body);
    const queue = recoveryEnv.REVIEW_QUEUE as any;
    const originalSend = queue.send.bind(queue);
    vi.spyOn(queue, 'send').mockRejectedValueOnce(new Error('queue unavailable')).mockImplementation(originalSend);

    await app.request('http://codra.test/webhook', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature,
      },
      body,
    }, recoveryEnv);

    expect(queue.sent).toHaveLength(0);
    await retryPendingWebhookSubmissions(recoveryEnv);
    expect(queue.sent).toHaveLength(1);
    const [submission] = await queryRows<{ status: string }>(
      recoveryEnv,
      'SELECT status FROM webhook_queue_submissions WHERE delivery_id = $1',
      [deliveryId],
    );
    expect(submission.status).toBe('sent');
  });

  it('creates one job for concurrent copies of the same delivery', async () => {
    const concurrentEnv = createTestEnv();
    const deliveryId = uniqueName('concurrent-delivery');
    const payload = createMockPRWebhook({
      action: 'opened',
      repository: { name: uniqueName('concurrent-repo'), owner: { login: 'test-owner' } },
    });
    payload.pull_request.head.sha = '5'.repeat(40);
    payload.pull_request.base.sha = '6'.repeat(40);
    const body = JSON.stringify(payload);
    const signature = await signPayload(concurrentEnv.GITHUB_APP_WEBHOOK_SECRET, body);
    const request = () => app.request('http://codra.test/webhook', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature,
      },
      body,
    }, concurrentEnv);

    const responses = await Promise.all([request(), request()]);
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const jobs = await queryRows<{ count: number }>(
      concurrentEnv,
      'SELECT COUNT(*) AS count FROM jobs WHERE webhook_delivery_id = $1',
      [deliveryId],
    );
    expect(Number(jobs[0].count)).toBe(1);
    expect((concurrentEnv.REVIEW_QUEUE as any).sent).toHaveLength(1);
  });

  it('rejects GitHub webhooks posted to the site root', async () => {
    const repoName = uniqueName('root-repo');
    const rawPayload = createMockPRWebhook({
      action: 'opened',
      repository: { name: repoName, owner: { login: 'test-owner' } }
    });
    rawPayload.pull_request.head.sha = 'c'.repeat(40);
    rawPayload.pull_request.base.sha = 'd'.repeat(40);
    const body = JSON.stringify(rawPayload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request(
      'http://codra.test/',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': uniqueName('root-delivery'),
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );

    expect(response.status).toBe(404);

    const queue = env.REVIEW_QUEUE as any;
    expect(queue.sent).toHaveLength(0);
  });

  it('acknowledges unsupported GitHub events without queueing review work', async () => {
    const rawPayload = createMockPRWebhook({
      action: 'opened',
      repository: { name: uniqueName('repo-check-suite'), owner: { login: 'test-owner' } },
    });
    const body = JSON.stringify(rawPayload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'check_suite',
          'x-github-delivery': uniqueName('check-suite'),
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );

    const json = await response.json() as any;
    expect(response.status).toBe(202);
    expect(json.ok).toBe(true);
    expect(json.ignored).toBe(true);
    expect(json.eventName).toBe('check_suite');

    const queue = env.REVIEW_QUEUE as any;
    expect(queue.sent).toHaveLength(0);
  });

  it('ignores webhooks for draft PRs', async () => {
      const draftPayload = createMockPRWebhook({ 
          action: 'opened',
          pull_request: { draft: true, number: 99, head: { sha: 'abc' }, base: { sha: 'def' }, user: { login: 'a' } }
      });
      const body = JSON.stringify(draftPayload);
      const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

      const response = await app.request(
        'http://codra.test/webhook',
        {
          method: 'POST',
          headers: {
            'x-github-event': 'pull_request',
            'x-github-delivery': uniqueName('draft'),
            'x-hub-signature-256': signature,
          },
          body,
        },
        env,
      );

      const json = await response.json() as any;
      expect(response.status).toBe(202);
      expect(json.message).toBe('queued');

      const queue = env.REVIEW_QUEUE as any;
      expect(queue.sent).toHaveLength(1);
      expect(queue.sent[0].payload).toBeUndefined();
      expect(queue.sent[0].eventName).toBe('pull_request');
  });
});
