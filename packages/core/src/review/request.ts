import type {
  WebhookEventName,
  WebhookPayload,
  CommentWebhookPayload,
  ChangeRequestWebhookPayload,
} from '@codraoss/schema/webhook';
import type { RepoConfig } from '@codraoss/schema';

function shouldTriggerFromChangeRequest(action: ChangeRequestWebhookPayload['action'], config: RepoConfig['review']) {
  return (config.on as string[]).includes(action);
}

const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export type ReviewRequest = {
  installationId: string;
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string | null;
  prAuthor: string | null;
  commitSha: string;
  baseSha: string;
  headRef: string | null;
  baseRef: string | null;
  trigger: 'auto' | 'mention';
};

export function extractReviewRequest(input: {
  eventName: WebhookEventName;
  payload: WebhookPayload;
  botUsername: string;
  config: RepoConfig;
}): ReviewRequest | null {
  if (input.eventName === 'change_request') {
    const payload = input.payload as ChangeRequestWebhookPayload;
    if (input.config.review.ignore_drafts && payload.changeRequest.draft) {
      return null;
    }
    if (!shouldTriggerFromChangeRequest(payload.action, input.config.review)) {
      return null;
    }
    // A signed webhook proves that GitHub sent it, not that the person pushing to a fork may spend
    // this installation's model budget. Initial reviews remain available for outside contributors,
    // but repeated automatic reviews require a repository role. Maintainers can still explicitly
    // request another review through the separately-authorized mention/dashboard paths.
    if (payload.action === 'synchronize'
      && !TRUSTED_AUTHOR_ASSOCIATIONS.has(payload.changeRequest.authorAssociation ?? '')) {
      return null;
    }

    return {
      installationId: payload.installationId,
      owner: payload.repository.owner,
      repo: payload.repository.name,
      prNumber: payload.changeRequest.number,
      prTitle: payload.changeRequest.title,
      prAuthor: payload.changeRequest.author,
      commitSha: payload.changeRequest.head.sha,
      baseSha: payload.changeRequest.base.sha,
      headRef: payload.changeRequest.head.ref,
      baseRef: payload.changeRequest.base.ref,
      trigger: 'auto' as const,
    };
  }

  if (input.eventName === 'comment') {
    const payload = input.payload as CommentWebhookPayload;
    const mentionTrigger = input.config.review.mention_trigger;

    if (!payload.issue.isChangeRequest || payload.action !== 'created' || !mentionTrigger) {
      return null;
    }

    if (!payload.comment.body.includes(mentionTrigger)) {
      return null;
    }

    return {
      installationId: payload.installationId,
      owner: payload.repository.owner,
      repo: payload.repository.name,
      prNumber: payload.issue.number,
      prTitle: null,
      prAuthor: null,
      commitSha: '',
      baseSha: '',
      headRef: null,
      baseRef: null,
      trigger: 'mention' as const,
    };
  }

  return null;
}
