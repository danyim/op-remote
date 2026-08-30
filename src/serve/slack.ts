import type { ApprovalResult } from "./approval.ts";

/**
 * Slack approval provider for op-remote.
 *
 * Implements the same provider contract as telegram.ts (requestRunApproval /
 * requestResumeApproval) using a Slack app in Socket Mode:
 *  - approval requests are posted to a channel as a Block Kit message with
 *    Approve / Reject / Auto-Approve / Stop buttons
 *  - button presses arrive over the Socket Mode WebSocket connection
 *  - Reject/Stop open a modal to capture an optional reason
 *
 * The Socket Mode connection is lazy: it opens on the first approval request
 * and reconnects with backoff if it drops. Slack allows up to 10 concurrent
 * Socket Mode connections per app (one per app-level token), so a second
 * app-level token for the same app can be used without disturbing other
 * consumers of that app (e.g. a bot gateway on its own token).
 */

export interface SlackConfig {
  botToken: string;
  appToken: string;
  channelId: string;
  timeoutMs: number;
  /** When set, only these Slack user IDs may approve/reject requests. */
  approverIds?: string[];
}

export interface RunApprovalOpts {
  command: string[];
  cwd: string;
  reason: string;
  secretNames: string[];
}

const API_BASE = "https://slack.com/api/";

// ---------------------------------------------------------------------------
// Slack Web API helper
// ---------------------------------------------------------------------------

async function slackApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API_BASE}${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) {
    throw new Error(`Slack API error (${method}): ${data.error}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Block Kit builders
// ---------------------------------------------------------------------------

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export function buildApprovalBlocks(nonce: string, opts: RunApprovalOpts): SlackBlock[] {
  const secretList = opts.secretNames.map((s) => `  - ${s}`).join("\n");
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "*🔑 Secret access request*" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Reason:* ${opts.reason}`,
          `*Command:* \`${opts.command.join(" ")}\``,
          `*Working dir:* \`${opts.cwd}\``,
          "*Secrets:*",
          secretList,
        ].join("\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: `${nonce}:approve`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: `${nonce}:reject`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Auto-Approve" },
          action_id: `${nonce}:auto_approve`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Stop" },
          style: "danger",
          action_id: `${nonce}:stop`,
        },
      ],
    },
  ];
}

export function buildResumeBlocks(nonce: string): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*🔄 Resume request*\nThe agent is requesting to resume the session.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: `${nonce}:approve`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: `${nonce}:reject`,
        },
      ],
    },
  ];
}

/** Splits an action_id of the form `${nonce}:${action}` back into its parts. */
export function parseActionId(actionId: string): { nonce: string; action: string } | undefined {
  const idx = actionId.indexOf(":");
  if (idx === -1) return undefined;
  return { nonce: actionId.slice(0, idx), action: actionId.slice(idx + 1) };
}

/** Extracts the submitted reason text from a view_submission payload. */
export function extractReason(view: unknown): string | undefined {
  const state = (
    view as {
      state?: { values?: Record<string, Record<string, { value?: string }>> };
    }
  )?.state;
  const values = state?.values ?? {};
  for (const block of Object.values(values)) {
    for (const element of Object.values(block)) {
      const value = element?.value;
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pending approval state
// ---------------------------------------------------------------------------

interface PendingApproval {
  nonce: string;
  channelId: string;
  messageTs: string;
  config: SlackConfig;
  timer: ReturnType<typeof setTimeout>;
  rejectionAction: "reject" | "stop";
  viewId: string | undefined;
  finish: (result: ApprovalResult) => void;
}

const pendingApprovals = new Map<string, PendingApproval>();
const viewToNonce = new Map<string, string>();

const APPROVE_ACTIONS = new Set(["approve", "auto_approve"]);

// ---------------------------------------------------------------------------
// Socket Mode connection manager
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null;
let socketPromise: Promise<WebSocket> | null = null;
let reconnectDelayMs = 1000;

async function openSocket(config: SlackConfig): Promise<WebSocket> {
  const { url } = await slackApi<{ url: string }>(config.appToken, "apps.connections.open", {});
  const ws = new WebSocket(url);

  ws.onmessage = (event) => {
    try {
      const envelope = JSON.parse(String(event.data)) as {
        envelope_id?: string;
        type?: string;
        payload?: unknown;
      };
      if (envelope.envelope_id) {
        // Ack every envelope immediately; Slack requires this within 3s.
        ws.send(JSON.stringify({ envelope_id: envelope.envelope_id, payload: {} }));
      }
      if (envelope.type === "interactive") {
        handleInteractive(config, envelope.payload);
      }
      // "disconnect" envelopes are informational; onclose drives the reconnect.
    } catch (err) {
      console.error(
        "[op-remote:slack] error handling envelope:",
        err instanceof Error ? err.message : err,
      );
    }
  };

  ws.onclose = () => {
    socket = null;
    socketPromise = null;
    scheduleReconnect(config);
  };

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket connection to Slack failed"));
  });

  reconnectDelayMs = 1000;
  return ws;
}

function getSocket(config: SlackConfig): Promise<WebSocket> {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return Promise.resolve(socket);
  }
  if (!socketPromise) {
    socketPromise = openSocket(config)
      .then((ws) => {
        socket = ws;
        socketPromise = null;
        return ws;
      })
      .catch((err) => {
        socketPromise = null;
        throw err;
      });
  }
  return socketPromise;
}

function scheduleReconnect(config: SlackConfig): void {
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
  setTimeout(() => {
    void getSocket(config).catch(() => {
      // A failed reconnect closes (and re-schedules) via onclose.
    });
  }, delay);
}

// ---------------------------------------------------------------------------
// Interactive payload handling
// ---------------------------------------------------------------------------

function isAuthorized(config: SlackConfig, userId: string | undefined): boolean {
  if (!config.approverIds || config.approverIds.length === 0) {
    return true;
  }
  return userId !== undefined && config.approverIds.includes(userId);
}

async function updateMessage(ctx: PendingApproval, text: string): Promise<void> {
  await slackApi(ctx.config.botToken, "chat.update", {
    channel: ctx.channelId,
    ts: ctx.messageTs,
    text,
  });
}

function finishApproval(ctx: PendingApproval, result: ApprovalResult): void {
  clearTimeout(ctx.timer);
  pendingApprovals.delete(ctx.nonce);
  if (ctx.viewId) {
    viewToNonce.delete(ctx.viewId);
  }
  ctx.finish(result);
}

function handleInteractive(config: SlackConfig, payload: unknown): void {
  const p = payload as {
    type?: string;
    user?: { id?: string };
    actions?: { action_id?: string }[];
    trigger_id?: string;
    view?: { id?: string; state?: unknown };
  };

  if (p.type === "block_actions") {
    const action = p.actions?.[0];
    const parsed = action?.action_id ? parseActionId(action.action_id) : undefined;
    if (!parsed) {
      return;
    }
    const ctx = pendingApprovals.get(parsed.nonce);
    if (!ctx) {
      return;
    }

    if (!isAuthorized(config, p.user?.id)) {
      void slackApi(config.botToken, "chat.postEphemeral", {
        channel: ctx.channelId,
        user: p.user?.id,
        text: "You are not authorized to respond to this request.",
      }).catch(() => {});
      return;
    }

    if (APPROVE_ACTIONS.has(parsed.action)) {
      const label = parsed.action === "auto_approve" ? "Auto-approved" : "Approved";
      void updateMessage(ctx, `✅ ${label} at ${new Date().toLocaleTimeString()}`)
        .catch((err) => console.error("[op-remote:slack] chat.update failed:", err.message))
        .then(() => finishApproval(ctx, { action: parsed.action as "approve" | "auto_approve" }));
      return;
    }

    if (parsed.action === "reject" || parsed.action === "stop") {
      if (ctx.viewId) {
        return; // modal already open for this request
      }
      ctx.rejectionAction = parsed.action;
      void openReasonModal(ctx, p.trigger_id).catch((err) =>
        console.error("[op-remote:slack] views.open failed:", err.message),
      );
    }
    return;
  }

  if (p.type === "view_submission" || p.type === "view_closed") {
    const nonce = p.view?.id ? viewToNonce.get(p.view.id) : undefined;
    if (!nonce) {
      return;
    }
    const ctx = pendingApprovals.get(nonce);
    if (!ctx) {
      return;
    }

    if (p.type === "view_submission") {
      const reason = extractReason(p.view);
      const label = ctx.rejectionAction === "stop" ? "Stopped" : "Rejected";
      void updateMessage(ctx, `❌ ${label}${reason ? `: ${reason}` : ""}`)
        .catch((err) => console.error("[op-remote:slack] chat.update failed:", err.message))
        .then(() => finishApproval(ctx, { action: ctx.rejectionAction, reason }));
    } else {
      void updateMessage(ctx, "❌ Rejected")
        .catch((err) => console.error("[op-remote:slack] chat.update failed:", err.message))
        .then(() => finishApproval(ctx, { action: ctx.rejectionAction }));
    }
  }
}

async function openReasonModal(ctx: PendingApproval, triggerId: string | undefined): Promise<void> {
  if (!triggerId) {
    // Trigger IDs expire seconds after the interaction; fall back to a plain rejection.
    await updateMessage(ctx, "❌ Rejected");
    finishApproval(ctx, { action: ctx.rejectionAction });
    return;
  }
  const { view } = await slackApi<{ view: { id: string } }>(ctx.config.botToken, "views.open", {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: `op-remote-reason-${ctx.nonce}`,
      title: {
        type: "plain_text",
        text: ctx.rejectionAction === "stop" ? "Stop session" : "Reject request",
      },
      submit: { type: "plain_text", text: "Submit" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "reason_block",
          element: { type: "plain_text_input", action_id: "reason_input", multiline: true },
          label: { type: "plain_text", text: "Reason (optional)" },
          optional: true,
        },
      ],
    },
  });
  ctx.viewId = view.id;
  viewToNonce.set(view.id, ctx.nonce);
}

// ---------------------------------------------------------------------------
// Public API (provider contract)
// ---------------------------------------------------------------------------

function awaitApproval(
  config: SlackConfig,
  nonce: string,
  channelId: string,
  messageTs: string,
): Promise<ApprovalResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const ctx = pendingApprovals.get(nonce);
      if (!ctx) {
        return;
      }
      void updateMessage(ctx, "⏰ Timed out").catch(() => {});
      finishApproval(ctx, { action: "reject", reason: "permission request timed out" });
    }, config.timeoutMs);

    pendingApprovals.set(nonce, {
      nonce,
      channelId,
      messageTs,
      config,
      timer,
      rejectionAction: "reject",
      viewId: undefined,
      finish: (result) => resolve(result),
    });
  });
}

export async function requestRunApproval(
  config: SlackConfig,
  opts: RunApprovalOpts,
): Promise<ApprovalResult> {
  await getSocket(config);
  const nonce = crypto.randomUUID();
  const sent = await slackApi<{ ts: string }>(config.botToken, "chat.postMessage", {
    channel: config.channelId,
    blocks: buildApprovalBlocks(nonce, opts),
    text: "🔑 Secret access request",
  });
  return awaitApproval(config, nonce, config.channelId, sent.ts);
}

export async function requestResumeApproval(config: SlackConfig): Promise<ApprovalResult> {
  await getSocket(config);
  const nonce = crypto.randomUUID();
  const sent = await slackApi<{ ts: string }>(config.botToken, "chat.postMessage", {
    channel: config.channelId,
    blocks: buildResumeBlocks(nonce),
    text: "🔄 Resume request",
  });
  return awaitApproval(config, nonce, config.channelId, sent.ts);
}
