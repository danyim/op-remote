/**
 * Shared types for approval providers (Telegram, Slack, ...).
 *
 * Every provider implements the same contract: take a request description,
 * ask a human for a decision out-of-band (chat message with buttons, etc.),
 * and resolve with an ApprovalResult.
 */
export interface ApprovalResult {
  action: "approve" | "reject" | "auto_approve" | "stop";
  reason?: string;
}
