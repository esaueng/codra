/**
 * Session cache for a job's per-file diffs, shared by the Files-changed tab and the Logs page so
 * switching between them doesn't refetch (`diff_input` isn't persisted in D1 - see
 * GET /api/jobs/:id/diffs - so both fetch it lazily).
 */

const cacheKey = (jobId: string) => `codra:job-diffs:${jobId}`;

// Serializing multi-MB diffs janks the main thread and evicts sessionStorage; giant PRs just refetch instead.
const MAX_CACHED_CHARS = 2_000_000;

export function readDiffsCache(jobId: string): Record<string, string> | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(jobId));
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export function writeDiffsCache(jobId: string, diffs: Record<string, string>) {
  try {
    const payload = JSON.stringify(diffs);
    if (payload.length > MAX_CACHED_CHARS) return;
    sessionStorage.setItem(cacheKey(jobId), payload);
  } catch {
    /* quota exceeded / unavailable - skip */
  }
}
