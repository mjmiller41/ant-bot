/** Operational limits — mirrors grok-bot-system-outline.md §13. */
export const LIMITS = {
  MAX_BOTS_AND_GROUPS: 50,
  MIN_GROUP_MEMBERS: 2,
  MAX_GROUP_MEMBERS: 6,
  MAX_ROUTINES_PER_BOT: 50,
  ROUTINE_RUNS_RETAINED: 20,
  MAX_ATTACHMENTS_PER_MESSAGE: 6,
  MAX_ATTACHMENT_BYTES: 25 * 1024 * 1024,
  MAX_VIDEO_ATTACHMENT_BYTES: 200 * 1024 * 1024,
  MAX_BOT_TO_BOT_HOPS: 5,
  DEFAULT_MAX_CONCURRENT_SESSIONS: 2,
  APPROVAL_TIMEOUT_MS: 15 * 60 * 1000,
  TEACH_RECORDING_MAX_MS: 10 * 60 * 1000,
} as const;

/** Error codes returned by the service layer when a limit is violated. */
export const LIMIT_ERROR = {
  TOO_MANY_BOTS: 'TOO_MANY_BOTS',
  GROUP_SIZE: 'GROUP_SIZE',
  TOO_MANY_ROUTINES: 'TOO_MANY_ROUTINES',
  TOO_MANY_ATTACHMENTS: 'TOO_MANY_ATTACHMENTS',
  ATTACHMENT_TOO_LARGE: 'ATTACHMENT_TOO_LARGE',
  HOP_LIMIT: 'HOP_LIMIT',
} as const;
export type LimitErrorCode = (typeof LIMIT_ERROR)[keyof typeof LIMIT_ERROR];

export class LimitError extends Error {
  constructor(
    public code: LimitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LimitError';
  }
}
