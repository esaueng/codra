import type { DbEnv } from './env';
import { queryRows, SQL_NOW } from './client';
import type { JobRow } from './jobs-mapping';
import { markSystemActive } from './jobs-activity';


// Lives here rather than with the other read queries because claimJobLease is its main caller; keeping it in the barrel would make jobs.ts <-> jobs-leases.ts an import cycle.
export async function getJobForProcessing(env: DbEnv, jobId: string) {
  if (!jobId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    return null;
  }
  const [row] = await queryRows<JobRow>(
    env,
    `
      SELECT j.*, r.owner, r.repo, r.installation_id
      FROM jobs j
      JOIN repositories r ON j.repository_id = r.id
      WHERE j.id = $1
      LIMIT 1
    `,
    [jobId],
  );

  return row ?? null;
}

export type JobLeaseClaim =
  | { status: 'claimed'; row: JobRow }
  | { status: 'busy'; row: JobRow; retryAfterSeconds: number }
  | { status: 'terminal'; row: JobRow }
  | { status: 'missing' };

export async function claimJobLease(
  env: Pick<DbEnv, 'DB' | 'APP_KV'>,
  jobId: string,
  leaseOwner: string,
  leaseSeconds: number,
): Promise<JobLeaseClaim> {
  const [claimedRow] = await queryRows<JobRow>(
    env,
    `
      UPDATE jobs
      SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
          started_at = COALESCE(started_at, ${SQL_NOW}),
          lease_owner = $2,
          lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || $3 || ' seconds'),
          heartbeat_at = ${SQL_NOW},
          last_queue_message_at = ${SQL_NOW}
      WHERE id = $1
        AND status IN ('queued', 'running')
        AND (lease_expires_at IS NULL OR lease_expires_at < ${SQL_NOW} OR lease_owner = $2)
        AND NOT (
          status = 'running' AND lease_owner IS NULL
          AND last_queue_message_at IS NOT NULL AND last_queue_message_at > ${SQL_NOW}
        )
      RETURNING *
    `,
    [jobId, leaseOwner, String(leaseSeconds)],
  );

  if (claimedRow) {
    const claimed = await getJobForProcessing(env as DbEnv, jobId);
    if (!claimed) return { status: 'missing' };
    await markSystemActive(env);
    return { status: 'claimed', row: claimed };
  }

  const row = await getJobForProcessing(env, jobId);
  if (!row) {
    return { status: 'missing' };
  }

  if (!['queued', 'running'].includes(row.status)) {
    return { status: 'terminal', row };
  }

  const leaseExpiresAt = row.lease_expires_at ? new Date(row.lease_expires_at).getTime() : 0;
  const delayedUntil = row.lease_owner === null && row.last_queue_message_at ? new Date(row.last_queue_message_at).getTime() : 0;
  const retryAt = Math.max(leaseExpiresAt, delayedUntil);
  const secondsUntilExpiry = Math.ceil((retryAt - Date.now()) / 1000);
  return {
    status: 'busy',
    row,
    retryAfterSeconds: Math.max(15, Math.min(60, Number.isFinite(secondsUntilExpiry) ? secondsUntilExpiry : 60)),
  };
}

export async function heartbeatJobLease(
  env: Pick<DbEnv, 'DB' | 'APP_KV'>,
  jobId: string,
  leaseOwner: string,
  leaseSeconds: number,
) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET heartbeat_at = ${SQL_NOW},
          lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || $3 || ' seconds')
      WHERE id = $1
        AND lease_owner = $2
        AND status = 'running'
    `,
    [jobId, leaseOwner, String(leaseSeconds)],
  );
  await markSystemActive(env);
}

export async function releaseJobLease(env: DbEnv, jobId: string, leaseOwner: string) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = $1
        AND lease_owner = $2
    `,
    [jobId, leaseOwner],
  );
}

// Bumps continuation counter; cleared on file completion to detect stuck jobs.
export async function markJobContinuationQueued(env: DbEnv, jobId: string, delaySeconds = 0) {
  const rows = await queryRows<{ continuation_count: number }>(
    env,
    `
      UPDATE jobs
      SET heartbeat_at = ${SQL_NOW},
          continuation_count = continuation_count + 1,
          last_queue_message_at = CASE
            WHEN $2 > 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || $2 || ' seconds')
            ELSE ${SQL_NOW}
          END
      WHERE id = $1
        AND status = 'running'
      RETURNING continuation_count
    `,
    [jobId, delaySeconds],
  );
  return rows[0]?.continuation_count ?? 0;
}

// Clears continuation counter on file completion.
export async function resetJobContinuationCount(env: DbEnv, jobId: string) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET continuation_count = 0
      WHERE id = $1
        AND status = 'running'
        AND continuation_count <> 0
    `,
    [jobId],
  );
}

// onlyJobIds isolates tests from stealing stale rows.
export async function recoverExpiredJobLeases(
  env: DbEnv,
  maxRecoveryCount = 3,
  unleasedGraceSeconds = 300,
  onlyJobIds?: readonly string[] | null,
) {
  const jobIdFilter = onlyJobIds ? JSON.stringify([...onlyJobIds]) : null;

  const requeued = await queryRows<{ id: string }>(
    env,
    `
      UPDATE jobs
      SET lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          recovery_count = recovery_count + 1,
          last_queue_message_at = ${SQL_NOW},
          error_msg = NULL
      WHERE id IN (
        SELECT id FROM jobs WHERE status = 'running'
          AND (
            (lease_expires_at IS NOT NULL AND lease_expires_at < ${SQL_NOW})
            OR (
              lease_expires_at IS NULL
              AND COALESCE(last_queue_message_at, heartbeat_at, started_at, created_at)
                < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || $2 || ' seconds')
            )
          )
          AND recovery_count < $1
          AND ($3 IS NULL OR id IN (SELECT value FROM json_each($3)))
        ORDER BY COALESCE(lease_expires_at, last_queue_message_at, heartbeat_at, started_at, created_at) ASC
        LIMIT 25
      )
      RETURNING id
    `,
    [maxRecoveryCount, String(unleasedGraceSeconds), jobIdFilter],
  );

  const failed = await queryRows<JobRow>(
    env,
    `
      UPDATE jobs
      SET status = 'failed',
          finished_at = ${SQL_NOW},
          lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          error_msg = 'Job timed out: worker crashed or was evicted.',
          steps = CASE WHEN steps IS NOT NULL THEN (
            SELECT json_group_array(json(updated)) FROM (
              SELECT CASE WHEN json_extract(value, '$.status') = 'running'
                THEN json_set(value, '$.status', 'failed', '$.finishedAt', ${SQL_NOW}, '$.error', 'Job timed out: worker crashed or was evicted.')
                ELSE value END AS updated
              FROM json_each(steps) ORDER BY key
            )
          ) ELSE steps END
      WHERE id IN (
        SELECT id FROM jobs WHERE status = 'running'
          AND (
            (lease_expires_at IS NOT NULL AND lease_expires_at < ${SQL_NOW})
            OR (
              lease_expires_at IS NULL
              AND COALESCE(last_queue_message_at, heartbeat_at, started_at, created_at)
                < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || $2 || ' seconds')
            )
          )
          AND recovery_count >= $1
          AND ($3 IS NULL OR id IN (SELECT value FROM json_each($3)))
        ORDER BY COALESCE(lease_expires_at, last_queue_message_at, heartbeat_at, started_at, created_at) ASC
        LIMIT 25
      )
      RETURNING *
    `,
    [maxRecoveryCount, String(unleasedGraceSeconds), jobIdFilter],
  );

  const failedJobs = failed.length === 0 ? [] : await queryRows<JobRow>(env, `
    SELECT j.*, r.owner, r.repo, r.installation_id
    FROM jobs j JOIN repositories r ON r.id = j.repository_id
    WHERE j.id IN (SELECT value FROM json_each($1))
  `, [JSON.stringify(failed.map((row) => row.id))]);

  return {
    requeuedJobIds: requeued.map((row) => row.id),
    failedJobs,
  };
}

export async function getOtherRunningJobsCount(env: DbEnv, excludeJobId: string): Promise<number> {
  const [result] = await queryRows<{ count: string }>(
    env,
    `SELECT count(*) as count FROM jobs WHERE status = 'running' AND id != $1`,
    [excludeJobId]
  );
  return parseInt(result?.count ?? '0', 10);
}
