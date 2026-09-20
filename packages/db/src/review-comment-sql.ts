import type { ParsedReviewComment } from '@codraoss/schema';

// Shared review_comments field list. Update bulkInheritFileReviews if changed.
export const REVIEW_COMMENT_INSERT_COLUMNS = [
  'path', 'line', 'position', 'severity', 'category', 'title', 'body', 'code_suggestion',
  'confidence_score', 'evidence', 'fingerprint', 'anchor_hash', 'claim_type', 'context_snippet',
  'disposition', 'fingerprint_v2', 'source', 'rule_id', 'reviewer_model',
] as const;

export const REVIEW_COMMENT_INSERT_PLACEHOLDERS = REVIEW_COMMENT_INSERT_COLUMNS
  .map((_, index) => `$${index + 2}`)
  .join(', ');

export function reviewCommentInsertValues(comment: ParsedReviewComment) {
  return [
    comment.path,
    comment.line ?? null,
    comment.position ?? null,
    comment.severity,
    comment.category,
    comment.title,
    comment.body,
    comment.codeSuggestion ?? null,
    comment.confidenceScore ?? null,
    comment.evidence ?? null,
    comment.fingerprint ?? null,
    comment.anchorHash ?? null,
    comment.claimType ?? null,
    comment.contextSnippet ?? null,
    comment.disposition ?? null,
    comment.fingerprintV2 ?? null,
    comment.source ?? 'llm',
    comment.ruleId ?? null,
    comment.reviewerModel ?? null,
  ];
}

// The json_object body used to project comments back out, keyed to the `rc` alias.
export function reviewCommentJsonObject(extraFields = '') {
  const fields = [
    `'path', rc.path`,
    `'line', rc.line`,
    `'position', rc.position`,
    `'severity', rc.severity`,
    `'category', rc.category`,
    `'title', rc.title`,
    `'body', rc.body`,
    `'codeSuggestion', rc.code_suggestion`,
    `'confidenceScore', rc.confidence_score`,
    `'evidence', rc.evidence`,
    `'fingerprint', rc.fingerprint`,
    `'fingerprintV2', rc.fingerprint_v2`,
    `'anchorHash', rc.anchor_hash`,
    `'posted', json(CASE WHEN rc.posted = 1 THEN 'true' ELSE 'false' END)`,
    `'claimType', rc.claim_type`,
    `'contextSnippet', rc.context_snippet`,
    `'disposition', rc.disposition`,
    `'verifyReason', rc.verify_reason`,
    `'source', rc.source`,
    `'ruleId', rc.rule_id`,
    `'reviewerModel', rc.reviewer_model`,
  ].join(',\n        ');

  return `json_object(\n        ${fields}${extraFields ? `,\n        ${extraFields}` : ''}\n      )`;
}

export function reviewCommentsAggregate(extraFields = '') {
  return `COALESCE(
        (
          SELECT json_group_array(json(comment_json))
          FROM (
            SELECT ${reviewCommentJsonObject(extraFields)} AS comment_json
            FROM review_comments rc
            WHERE rc.file_review_id = fr.id
            ORDER BY rc.id ASC
          )
        ),
        '[]'
      )`;
}
