import type { DbEnv } from './env';
import type { BulkFileReviewInput } from '@codraoss/core/ports';
import { newId, queryBatch, queryRows } from './client';
import {
  REVIEW_COMMENT_INSERT_COLUMNS,
  REVIEW_COMMENT_INSERT_PLACEHOLDERS,
  reviewCommentInsertValues,
} from './review-comment-sql';

// `filePaths` must already be filtered to inheritable files with no row yet in the target job.
export async function bulkInheritFileReviews(
  env: DbEnv,
  input: { jobId: string; parentJobId: string; filePaths: string[] },
): Promise<string[]> {
  if (input.filePaths.length === 0) return [];
  const pathsJson = JSON.stringify(input.filePaths);

  await queryBatch(env, [
    {
      sql: `
        INSERT INTO file_reviews (
          id, job_id, file_path, file_status, model_used, diff_line_count, diff_input,
          raw_ai_output, input_tokens, output_tokens, duration_ms, verdict,
          file_summary, overall_correctness, confidence_score, error_msg, model_provider,
          withheld_counts, batch_size, degraded
        )
        SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
               substr(lower(hex(randomblob(2))), 2) || '-' ||
               substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
               lower(hex(randomblob(6))),
          $1, file_path, file_status, model_used, diff_line_count, diff_input,
          raw_ai_output, input_tokens, output_tokens, duration_ms, verdict,
          file_summary, overall_correctness, confidence_score, error_msg, model_provider,
          withheld_counts, batch_size, degraded
        FROM file_reviews
        WHERE job_id = $2 AND file_status = 'done'
          AND file_path IN (SELECT value FROM json_each($3))
        ON CONFLICT (job_id, file_path) DO NOTHING
      `,
      params: [input.jobId, input.parentJobId, pathsJson],
    },
    {
      sql: `
        INSERT INTO review_comments (
          file_review_id, path, line, position, severity, category, title, body, code_suggestion,
          confidence_score, evidence, fingerprint, anchor_hash, posted, claim_type, context_snippet,
          disposition, fingerprint_v2, source, rule_id, reviewer_model
        )
        SELECT target.id, rc.path, rc.line, rc.position, rc.severity, rc.category, rc.title, rc.body,
               rc.code_suggestion, rc.confidence_score, rc.evidence, rc.fingerprint, rc.anchor_hash,
               0, rc.claim_type, rc.context_snippet, NULL, rc.fingerprint_v2,
               rc.source, rc.rule_id, rc.reviewer_model
        FROM file_reviews AS target
        JOIN file_reviews AS parent
          ON parent.job_id = $2 AND parent.file_path = target.file_path
        JOIN review_comments AS rc ON rc.file_review_id = parent.id
        WHERE target.job_id = $1
          AND target.file_path IN (SELECT value FROM json_each($3))
      `,
      params: [input.jobId, input.parentJobId, pathsJson],
    },
  ]);

  const rows = await queryRows<{ file_path: string }>(
    env,
    `SELECT file_path FROM file_reviews
     WHERE job_id = $1 AND file_path IN (SELECT value FROM json_each($2))`,
    [input.jobId, pathsJson],
  );
  return rows.map((row) => row.file_path);
}

export type { BulkFileReviewInput } from '@codraoss/core/ports';

export async function bulkUpsertFileReviews(
  env: DbEnv,
  jobId: string,
  inputs: BulkFileReviewInput[],
): Promise<void> {
  if (inputs.length === 0) return;

  const statements = inputs.flatMap((input) => [
    {
      sql: `
        INSERT INTO file_reviews (
          id, job_id, file_path, file_status, model_used, diff_line_count, diff_input,
          raw_ai_output, input_tokens, output_tokens, duration_ms, verdict,
          file_summary, overall_correctness, confidence_score, error_msg, model_provider,
          withheld_counts, degraded, batch_size
        ) VALUES (
          $1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18, $19
        )
        ON CONFLICT (job_id, file_path) DO UPDATE SET
          file_status = excluded.file_status,
          model_used = excluded.model_used,
          diff_line_count = excluded.diff_line_count,
          diff_input = excluded.diff_input,
          raw_ai_output = excluded.raw_ai_output,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          duration_ms = excluded.duration_ms,
          verdict = excluded.verdict,
          file_summary = excluded.file_summary,
          overall_correctness = excluded.overall_correctness,
          confidence_score = excluded.confidence_score,
          error_msg = excluded.error_msg,
          model_provider = excluded.model_provider,
          withheld_counts = excluded.withheld_counts,
          degraded = excluded.degraded,
          batch_size = excluded.batch_size,
          async_request_id = NULL,
          async_model = NULL,
          transient_error_count = 0
      `,
      params: [
        newId(), jobId, input.filePath, input.fileStatus, input.modelUsed, input.diffLineCount,
        input.rawAiOutput, input.inputTokens, input.outputTokens, input.durationMs, input.verdict,
        input.fileSummary, input.overallCorrectness ?? null, input.confidenceScore ?? null,
        input.errorMessage, input.modelProvider ?? null,
        input.withheldCounts ? JSON.stringify(input.withheldCounts) : null,
        input.degraded ?? null, input.batchSize,
      ],
    },
    {
      sql: `DELETE FROM review_comments
            WHERE file_review_id = (SELECT id FROM file_reviews WHERE job_id = $1 AND file_path = $2)`,
      params: [jobId, input.filePath],
    },
    ...input.parsedComments.map((comment) => ({
      sql: `INSERT INTO review_comments (file_review_id, ${REVIEW_COMMENT_INSERT_COLUMNS.join(', ')})
            SELECT id, ${REVIEW_COMMENT_INSERT_PLACEHOLDERS}
            FROM file_reviews WHERE job_id = $1 AND file_path = $21`,
      params: [jobId, ...reviewCommentInsertValues(comment), input.filePath],
    })),
  ]);

  await queryBatch(env, statements);
}

export async function bulkRecordRetryableFileReviewFailures(
  env: DbEnv,
  jobId: string,
  inputs: Array<{ filePath: string; modelUsed: string; diffLineCount: number; errorMessage: string }>,
  opts: { countsAsAttempt?: boolean } = {},
): Promise<Array<{ filePath: string; transientErrorCount: number }>> {
  if (inputs.length === 0) return [];
  const increment = opts.countsAsAttempt === false ? 0 : 1;

  await queryBatch(env, inputs.flatMap((input) => [
    {
      sql: `
        INSERT INTO file_reviews (
          id, job_id, file_path, file_status, model_used, diff_line_count, diff_input,
          error_msg, duration_ms, transient_error_count
        ) VALUES ($1, $2, $3, 'failed', $4, $5, NULL, $6, 0, $7)
        ON CONFLICT (job_id, file_path) DO UPDATE SET
          file_status = 'failed',
          model_used = excluded.model_used,
          diff_line_count = excluded.diff_line_count,
          raw_ai_output = NULL,
          input_tokens = NULL,
          output_tokens = NULL,
          verdict = NULL,
          file_summary = NULL,
          overall_correctness = NULL,
          confidence_score = NULL,
          withheld_counts = NULL,
          degraded = NULL,
          error_msg = excluded.error_msg,
          transient_error_count = file_reviews.transient_error_count + $7
      `,
      params: [newId(), jobId, input.filePath, input.modelUsed, input.diffLineCount, input.errorMessage, increment],
    },
    {
      sql: `DELETE FROM review_comments
            WHERE file_review_id = (SELECT id FROM file_reviews WHERE job_id = $1 AND file_path = $2)`,
      params: [jobId, input.filePath],
    },
  ]));

  const rows = await queryRows<{ file_path: string; transient_error_count: number }>(
    env,
    `SELECT file_path, transient_error_count FROM file_reviews
     WHERE job_id = $1 AND file_path IN (SELECT value FROM json_each($2))`,
    [jobId, JSON.stringify(inputs.map((input) => input.filePath))],
  );
  return rows.map((row) => ({ filePath: row.file_path, transientErrorCount: Number(row.transient_error_count) }));
}

export async function bulkMarkFilesFailed(
  env: DbEnv,
  jobId: string,
  files: Array<{ filePath: string; diffLineCount: number }>,
  opts: { modelUsed: string; errorMessage: string },
): Promise<void> {
  if (files.length === 0) return;
  await queryBatch(env, files.map((file) => ({
    sql: `INSERT INTO file_reviews
            (id, job_id, file_path, file_status, model_used, diff_line_count, diff_input, error_msg, duration_ms)
          VALUES ($1, $2, $3, 'failed', $4, $5, NULL, $6, 0)
          ON CONFLICT (job_id, file_path) DO NOTHING`,
    params: [newId(), jobId, file.filePath, opts.modelUsed, file.diffLineCount, opts.errorMessage],
  })));
}
