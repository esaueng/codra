import type { DbEnv } from './env';
import { isSupportedTimeZone } from '@codraoss/schema/timezone';
import { queryRows } from './client';
import { statsSchema, jobStatuses, reviewTriggers, reviewSeverities, reviewCategories } from '@codraoss/schema';
import { getModelUsageStats } from './file-reviews';

const jobStatusSet = new Set<string>(jobStatuses);
const reviewTriggerSet = new Set<string>(reviewTriggers);
const reviewSeveritySet = new Set<string>(reviewSeverities);
const reviewCategorySet = new Set<string>(reviewCategories);

export function trendBucketDays(days: number) {
  if (days <= 14) return 1;
  if (days <= 45) return 3;
  if (days <= 120) return 7;
  return 14;
}

function dateKey(value: Date | string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addCalendarDays(day: string, amount: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export async function getStats(env: DbEnv, days = 30, timeZone = 'UTC') {
  const parsedDays = Number(days);
  const safeDays = Number.isFinite(parsedDays) ? Math.trunc(parsedDays) : 30;
  const clampedDays = Math.min(Math.max(safeDays, 1), 365);
  const zone = isSupportedTimeZone(timeZone) ? timeZone : 'UTC';
  const bucketDays = trendBucketDays(clampedDays);
  const cutoff = new Date(Date.now() - clampedDays * 86_400_000).toISOString();

  const [jobRows, verdictRows, topRepos, modelRows, statusRows, triggerRows, severityRows, categoryRows] = await Promise.all([
    queryRows<{
      created_at: string; started_at: string | null; finished_at: string | null;
      total_input_tokens: number | null; total_output_tokens: number | null;
      comment_count: number | null; overall_confidence_score: number | null;
    }>(env, `
      SELECT created_at, started_at, finished_at, total_input_tokens, total_output_tokens,
             comment_count, overall_confidence_score
      FROM jobs WHERE created_at >= $1 ORDER BY created_at ASC
    `, [cutoff]),
    queryRows<{ verdict: 'approve' | 'comment' | null; count: number }>(env,
      `SELECT verdict, COUNT(*) AS count FROM jobs GROUP BY verdict ORDER BY count DESC`),
    queryRows<{ owner: string; repo: string; jobs: number }>(env, `
      SELECT r.owner, r.repo, COUNT(*) AS jobs
      FROM jobs j JOIN repositories r ON j.repository_id = r.id
      WHERE j.created_at >= $1 GROUP BY r.owner, r.repo
      ORDER BY jobs DESC, r.owner ASC, r.repo ASC LIMIT 10
    `, [cutoff]),
    getModelUsageStats(env, clampedDays),
    queryRows<{ status: string; count: number }>(env,
      `SELECT status, COUNT(*) AS count FROM jobs WHERE created_at >= $1 GROUP BY status ORDER BY count DESC`, [cutoff]),
    queryRows<{ trigger: string; count: number }>(env,
      `SELECT trigger, COUNT(*) AS count FROM jobs WHERE created_at >= $1 GROUP BY trigger ORDER BY count DESC`, [cutoff]),
    queryRows<{ severity: string; count: number }>(env, `
      SELECT rc.severity, COUNT(*) AS count FROM review_comments rc
      JOIN file_reviews fr ON fr.id = rc.file_review_id
      WHERE fr.created_at >= $1 GROUP BY rc.severity ORDER BY count DESC
    `, [cutoff]),
    queryRows<{ category: string; count: number }>(env, `
      SELECT rc.category, COUNT(*) AS count FROM review_comments rc
      JOIN file_reviews fr ON fr.id = rc.file_review_id
      WHERE fr.created_at >= $1 GROUP BY rc.category ORDER BY count DESC
    `, [cutoff]),
  ]);

  const startDay = dateKey(cutoff, zone);
  const endDay = dateKey(new Date(), zone);
  const trend: Array<{ day: string; endDay: string; jobs: number; inputTokens: number; outputTokens: number; comments: number }> = [];
  for (let day = startDay; day <= endDay; day = addCalendarDays(day, bucketDays)) {
    trend.push({ day, endDay: [addCalendarDays(day, bucketDays - 1), endDay].sort()[0], jobs: 0, inputTokens: 0, outputTokens: 0, comments: 0 });
  }
  for (const row of jobRows) {
    const day = dateKey(row.created_at, zone);
    const bucket = trend.find((item) => day >= item.day && day <= item.endDay);
    if (!bucket) continue;
    bucket.jobs += 1;
    bucket.inputTokens += row.total_input_tokens ?? 0;
    bucket.outputTokens += row.total_output_tokens ?? 0;
    bucket.comments += row.comment_count ?? 0;
  }

  const durations = jobRows.flatMap((row) => {
    if (!row.started_at || !row.finished_at) return [];
    const duration = new Date(row.finished_at).getTime() - new Date(row.started_at).getTime();
    return Number.isFinite(duration) && duration >= 0 ? [duration] : [];
  }).sort((a, b) => a - b);
  const confidences = jobRows.flatMap((row) => row.overall_confidence_score == null ? [] : [row.overall_confidence_score]);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

  return statsSchema.parse({
    totals: { jobs: jobRows.length, inputTokens: sum(jobRows.map((row) => row.total_input_tokens ?? 0)), outputTokens: sum(jobRows.map((row) => row.total_output_tokens ?? 0)), comments: sum(jobRows.map((row) => row.comment_count ?? 0)) },
    trend,
    trendBucketDays: bucketDays,
    verdicts: verdictRows.map((row) => ({ verdict: row.verdict, count: row.count })),
    models: modelRows.map((row) => ({ modelUsed: row.model_used, provider: row.model_provider ?? undefined, calls: row.calls, inputTokens: row.input_tokens ?? 0, outputTokens: row.output_tokens ?? 0 })),
    topRepos: topRepos.map((row) => ({ owner: row.owner, repo: row.repo, jobs: row.jobs })),
    statuses: statusRows.flatMap((row) => jobStatusSet.has(row.status) ? [{ status: row.status as (typeof jobStatuses)[number], count: row.count }] : []),
    triggers: triggerRows.flatMap((row) => reviewTriggerSet.has(row.trigger) ? [{ trigger: row.trigger as (typeof reviewTriggers)[number], count: row.count }] : []),
    severities: severityRows.flatMap((row) => reviewSeveritySet.has(row.severity) ? [{ severity: row.severity as (typeof reviewSeverities)[number], count: row.count }] : []),
    categories: categoryRows.flatMap((row) => reviewCategorySet.has(row.category) ? [{ category: row.category as (typeof reviewCategories)[number], count: row.count }] : []),
    performance: {
      avgDurationMs: durations.length ? Math.round(sum(durations) / durations.length) : null,
      p95DurationMs: durations.length ? Math.round(durations[Math.ceil(durations.length * 0.95) - 1]) : null,
      avgConfidence: confidences.length ? sum(confidences) / confidences.length : null,
    },
  });
}
