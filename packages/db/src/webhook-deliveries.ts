import type { ReviewJobMessage, RepoConfig } from '@codraoss/schema';
import { defaultRepoConfig } from '@codraoss/schema';
import { hexToBytes } from '@codraoss/schema/hex';
import type { DbEnv } from './env';
import { newId, parseJsonColumn, queryBatch, queryRows, SQL_NOW } from './client';
import { markSystemActive } from './jobs-activity';
import { getOrCreateRepository } from './repositories';

type DeliveryStatus = 'received' | 'queue_pending' | 'processed' | 'ignored';

export async function recordWebhookDelivery(
  env: DbEnv,
  input: {
    deliveryId: string;
    eventName: string;
    owner: string | null;
    repo: string | null;
    payload: unknown;
  },
) {
  let repositoryId: number | null = null;

  if (input.owner && input.repo) {
    const [repoRow] = await queryRows<{ id: number }>(
      env,
      'SELECT id FROM repositories WHERE owner = $1 AND repo = $2',
      [input.owner, input.repo],
    );
    repositoryId = repoRow?.id ?? null;
  }

  const rows = await queryRows<{ id: string }>(
    env,
    `
      INSERT INTO webhook_deliveries (id, delivery_id, event_name, repository_id, payload)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING id
    `,
    [newId(), input.deliveryId, input.eventName, repositoryId, JSON.stringify(input.payload)],
  );

  const [delivery] = await queryRows<{
    repository_id: number | null;
    processing_status: DeliveryStatus;
    job_id: string | null;
  }>(
    env,
    `SELECT repository_id, processing_status, job_id
     FROM webhook_deliveries WHERE delivery_id = $1 LIMIT 1`,
    [input.deliveryId],
  );

  return {
    inserted: rows.length > 0,
    repositoryId: delivery?.repository_id ?? repositoryId,
    processingStatus: delivery?.processing_status ?? 'received',
    jobId: delivery?.job_id ?? null,
  };
}

export async function persistWebhookReviewJob(
  env: DbEnv,
  input: {
    deliveryId: string;
    installationId: string;
    owner: string;
    repo: string;
    prNumber: number;
    prTitle: string | null;
    prAuthor: string | null;
    commitSha: string;
    baseSha: string;
    trigger: 'auto' | 'mention';
    headRef: string | null;
    baseRef: string | null;
    configSnapshot?: RepoConfig | null;
    requestId?: string;
  },
) {
  const repositoryId = await getOrCreateRepository(env, input);
  const proposedJobId = newId();

  await queryBatch(env, [
    {
      sql: `
        INSERT INTO jobs (
          id, repository_id, pr_number, pr_title, pr_author, commit_sha, base_sha,
          trigger, status, config_snapshot, head_ref, base_ref, webhook_delivery_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10, $11, $12)
        ON CONFLICT DO NOTHING
      `,
      params: [
        proposedJobId,
        repositoryId,
        input.prNumber,
        input.prTitle,
        input.prAuthor,
        hexToBytes(input.commitSha),
        hexToBytes(input.baseSha),
        input.trigger,
        JSON.stringify(input.configSnapshot ?? defaultRepoConfig),
        input.headRef,
        input.baseRef,
        input.deliveryId,
      ],
    },
    {
      sql: `
        UPDATE jobs
        SET status = 'superseded',
            finished_at = ${SQL_NOW},
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_msg = 'Superseded by a newer commit or job.'
        WHERE repository_id = $1
          AND pr_number = $2
          AND id != $3
          AND status IN ('queued', 'running')
          AND EXISTS (SELECT 1 FROM jobs WHERE id = $3)
      `,
      params: [repositoryId, input.prNumber, proposedJobId],
    },
    {
      sql: `
        INSERT INTO webhook_queue_submissions (id, delivery_id, job_id, message_json)
        SELECT $1, $2, j.id,
               CASE WHEN $3 IS NULL
                 THEN json_object('jobId', j.id, 'deliveryId', $2, 'phase', 'prepare')
                 ELSE json_object('jobId', j.id, 'deliveryId', $2, 'phase', 'prepare', 'requestId', $3)
               END
        FROM jobs j
        WHERE j.webhook_delivery_id = $2
        ON CONFLICT (delivery_id) DO NOTHING
      `,
      params: [newId(), input.deliveryId, input.requestId ?? null],
    },
    {
      sql: `
        UPDATE webhook_deliveries
        SET processing_status = 'queue_pending',
            repository_id = $2,
            job_id = (SELECT id FROM jobs WHERE webhook_delivery_id = $1)
        WHERE delivery_id = $1
      `,
      params: [input.deliveryId, repositoryId],
    },
  ]);

  await markSystemActive(env);
  const [delivery] = await queryRows<{ job_id: string }>(
    env,
    'SELECT job_id FROM webhook_deliveries WHERE delivery_id = $1',
    [input.deliveryId],
  );
  if (!delivery?.job_id) throw new Error(`Webhook job was not persisted for delivery ${input.deliveryId}.`);
  return delivery.job_id;
}

export async function persistWebhookEventSubmission(
  env: DbEnv,
  input: { deliveryId: string; eventName: string; requestId?: string },
) {
  await queryBatch(env, [
    {
      sql: `
        INSERT INTO webhook_queue_submissions (id, delivery_id, message_json)
        VALUES ($1, $2,
          CASE WHEN $4 IS NULL
            THEN json_object('deliveryId', $2, 'eventName', $3)
            ELSE json_object('deliveryId', $2, 'eventName', $3, 'requestId', $4)
          END
        )
        ON CONFLICT (delivery_id) DO NOTHING
      `,
      params: [newId(), input.deliveryId, input.eventName, input.requestId ?? null],
    },
    {
      sql: `UPDATE webhook_deliveries SET processing_status = 'queue_pending' WHERE delivery_id = $1`,
      params: [input.deliveryId],
    },
  ]);
  await markSystemActive(env);
}

export async function markWebhookDeliveryProcessed(
  env: DbEnv,
  deliveryId: string,
  status: Extract<DeliveryStatus, 'processed' | 'ignored'>,
) {
  await queryRows(
    env,
    `UPDATE webhook_deliveries
     SET processing_status = $2, processed_at = ${SQL_NOW}
     WHERE delivery_id = $1`,
    [deliveryId, status],
  );
}

export async function linkWebhookDeliveryToJob(env: DbEnv, deliveryId: string, jobId: string) {
  await queryRows(
    env,
    `UPDATE webhook_deliveries
     SET processing_status = 'processed', processed_at = ${SQL_NOW}, job_id = $2
     WHERE delivery_id = $1`,
    [deliveryId, jobId],
  );
}

export async function claimWebhookQueueSubmission(env: DbEnv, deliveryId?: string) {
  const params: unknown[] = deliveryId ? [deliveryId] : [];
  const deliveryFilter = deliveryId ? 'AND delivery_id = $1' : '';
  const [row] = await queryRows<{
    id: string;
    delivery_id: string;
    message_json: unknown;
  }>(
    env,
    `
      UPDATE webhook_queue_submissions
      SET status = 'sending',
          locked_at = ${SQL_NOW},
          attempt_count = attempt_count + 1,
          updated_at = ${SQL_NOW}
      WHERE id = (
        SELECT id FROM webhook_queue_submissions
        WHERE (status = 'pending'
          OR (status = 'sending' AND locked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')))
          ${deliveryFilter}
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING id, delivery_id, message_json
    `,
    params,
  );

  return row ? {
    id: row.id,
    deliveryId: row.delivery_id,
    message: parseJsonColumn<ReviewJobMessage>(row.message_json as string, {} as ReviewJobMessage),
  } : null;
}

export async function markWebhookQueueSubmissionSent(env: DbEnv, submissionId: string) {
  await queryBatch(env, [
    {
      sql: `
        UPDATE webhook_queue_submissions
        SET status = 'sent', sent_at = ${SQL_NOW}, locked_at = NULL,
            last_error = NULL, updated_at = ${SQL_NOW}
        WHERE id = $1
      `,
      params: [submissionId],
    },
    {
      sql: `
        UPDATE webhook_deliveries
        SET processing_status = 'processed', processed_at = ${SQL_NOW}
        WHERE delivery_id = (
          SELECT delivery_id FROM webhook_queue_submissions WHERE id = $1
        )
      `,
      params: [submissionId],
    },
  ]);
}

export async function releaseWebhookQueueSubmission(env: DbEnv, submissionId: string, error: string) {
  await queryRows(
    env,
    `
      UPDATE webhook_queue_submissions
      SET status = 'pending', locked_at = NULL, last_error = $2, updated_at = ${SQL_NOW}
      WHERE id = $1
    `,
    [submissionId, error.slice(0, 1000)],
  );
  await markSystemActive(env);
}

export async function hasPendingWebhookQueueSubmissions(env: DbEnv) {
  const [row] = await queryRows<{ has_work: boolean }>(
    env,
    `SELECT EXISTS (SELECT 1 FROM webhook_queue_submissions WHERE status != 'sent') AS has_work`,
  );
  return Boolean(row?.has_work);
}

export async function getWebhookDelivery(env: DbEnv, deliveryId: string) {
  const [row] = await queryRows<{
    delivery_id: string;
    event_name: string;
    payload: unknown;
  }>(
    env,
    `
      SELECT delivery_id, event_name, payload
      FROM webhook_deliveries
      WHERE delivery_id = $1
      LIMIT 1
    `,
    [deliveryId],
  );

  return row ? { ...row, payload: parseJsonColumn(row.payload, null) } : null;
}
