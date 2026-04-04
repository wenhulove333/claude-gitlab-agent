import { logInfo, logDebug, logWarn } from '../utils/logger.js';
import type { WebhookPayload, IssueWebhookPayload, MRWebhookPayload, NoteWebhookPayload } from './types.js';
import { isIssuePayload, isMRPayload, isNotePayload } from './types.js';

export interface WebhookHandler {
  onIssue?: (payload: IssueWebhookPayload) => Promise<void>;
  onMergeRequest?: (payload: MRWebhookPayload) => Promise<void>;
  onNote?: (payload: NoteWebhookPayload) => Promise<void>;
}

export class WebhookRouter {
  private handlers: WebhookHandler;

  constructor(handlers: WebhookHandler) {
    this.handlers = handlers;
  }

  async route(payload: WebhookPayload): Promise<void> {
    const objectKind = payload.object_kind;
    logDebug({ event: 'webhook_route', object_kind: objectKind }, `Routing webhook: ${objectKind}`);

    if (isIssuePayload(payload)) {
      await this.handleIssue(payload);
    } else if (isMRPayload(payload)) {
      await this.handleMergeRequest(payload);
    } else if (isNotePayload(payload)) {
      await this.handleNote(payload);
    } else {
      logWarn({ event: 'webhook_unknown_type', object_kind: objectKind }, 'Unknown webhook type');
    }
  }

  private async handleIssue(payload: IssueWebhookPayload): Promise<void> {
    const { action } = payload.object_attributes;
    logInfo(
      {
        event: 'issue_webhook',
        action,
        project_id: payload.project.id,
        issue_iid: payload.object_attributes.iid,
      },
      `Issue webhook: ${action}`
    );

    if (this.handlers.onIssue) {
      await this.handlers.onIssue(payload);
    }
  }

  private async handleMergeRequest(payload: MRWebhookPayload): Promise<void> {
    const { action } = payload.object_attributes;
    logInfo(
      {
        event: 'mr_webhook',
        action,
        project_id: payload.project.id,
        mr_iid: payload.object_attributes.iid,
      },
      `Merge Request webhook: ${action}`
    );

    if (this.handlers.onMergeRequest) {
      await this.handlers.onMergeRequest(payload);
    }
  }

  private async handleNote(payload: NoteWebhookPayload): Promise<void> {
    const { noteable_type, action } = payload.object_attributes;
    logInfo(
      {
        event: 'note_webhook',
        action,
        noteable_type,
        project_id: payload.project.id,
      },
      `Note webhook: ${noteable_type} ${action}`
    );

    if (this.handlers.onNote) {
      await this.handlers.onNote(payload);
    }
  }
}
