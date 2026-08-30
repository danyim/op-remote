import type { ApprovalResult } from "./approval.ts";
export type { ApprovalResult };

const API_BASE = "https://api.telegram.org/bot";

interface TelegramConfig {
  botToken: string;
  chatId: string;
  timeoutMs: number;
  /** When set, only these Telegram user IDs may approve/reject requests. */
  approverIds?: number[];
}

interface InlineButton {
  text: string;
  callbackData: string;
}

async function apiCall<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as {
    ok: boolean;
    result: T;
    description?: string;
  };
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
  return data.result;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number };
    message?: TelegramMessage;
    data?: string;
  };
  message?: {
    message_id: number;
    from?: { id: number };
    chat: { id: number };
    text?: string;
    reply_to_message?: TelegramMessage;
  };
}

function isAuthorizedUser(config: TelegramConfig, userId: number | undefined): boolean {
  if (!config.approverIds || config.approverIds.length === 0) {
    return true;
  }
  if (userId === undefined) {
    return false;
  }
  return config.approverIds.includes(userId);
}

// ---------------------------------------------------------------------------
// Shared poller: one getUpdates loop per bot token, dispatching to listeners.
// ---------------------------------------------------------------------------

type UpdateListener = (update: TelegramUpdate) => boolean;

interface PollerState {
  offset: number;
  listeners: Set<UpdateListener>;
  running: boolean;
}

const pollers = new Map<string, PollerState>();

function getPoller(botToken: string): PollerState {
  let state = pollers.get(botToken);
  if (state) {
    return state;
  }

  state = { offset: 0, listeners: new Set(), running: false };
  pollers.set(botToken, state);
  return state;
}

function registerListener(botToken: string, listener: UpdateListener): () => void {
  const state = getPoller(botToken);
  state.listeners.add(listener);

  // Start the poll loop if not already running.
  if (!state.running) {
    state.running = true;
    void runPollLoop(botToken, state);
  }

  return () => {
    state.listeners.delete(listener);
  };
}

async function runPollLoop(botToken: string, state: PollerState): Promise<void> {
  while (true) {
    // Check for listeners before and after each poll cycle to avoid the race
    // where a new listener registers while getUpdates is in-flight and the
    // loop exits before seeing it.
    if (state.listeners.size === 0) {
      // Yield to allow any in-flight registerListener calls to complete.
      await new Promise((r) => setTimeout(r, 0));
      if (state.listeners.size === 0) {
        break;
      }
    }

    try {
      const updates = await apiCall<TelegramUpdate[]>(botToken, "getUpdates", {
        offset: state.offset,
        timeout: 30,
      });

      for (const update of updates) {
        state.offset = update.update_id + 1;

        // Dispatch to all listeners. A listener returns true if it consumed the update.
        for (const listener of state.listeners) {
          if (listener(update)) {
            break;
          }
        }
      }
    } catch {
      // Transient API error; back off briefly and retry.
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  state.running = false;
}

// ---------------------------------------------------------------------------
// Keyboard builder
// ---------------------------------------------------------------------------

function buildKeyboard(
  nonce: string,
  buttons: InlineButton[][],
): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((btn) => ({
        text: btn.text,
        callback_data: `${nonce}:${btn.callbackData}`,
      })),
    ),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function requestRunApproval(
  config: TelegramConfig,
  opts: {
    command: string[];
    cwd: string;
    reason: string;
    secretNames: string[];
  },
): Promise<ApprovalResult> {
  const nonce = crypto.randomUUID();
  const secretList = opts.secretNames.map((s) => `  - ${s}`).join("\n");
  const text = [
    "\u{1F511} Secret access request",
    "",
    `Reason: ${opts.reason}`,
    "",
    `Command: ${opts.command.join(" ")}`,
    `Working dir: ${opts.cwd}`,
    "Secrets:",
    secretList,
  ].join("\n");

  const keyboard = buildKeyboard(nonce, [
    [
      { text: "Approve", callbackData: "approve" },
      { text: "Reject", callbackData: "reject" },
    ],
    [
      { text: "Auto-Approve", callbackData: "auto_approve" },
      { text: "Stop", callbackData: "stop" },
    ],
  ]);

  const sent = await apiCall<TelegramMessage>(config.botToken, "sendMessage", {
    chat_id: config.chatId,
    text,
    reply_markup: keyboard,
  });

  return awaitApproval(config, sent.message_id, nonce);
}

export async function requestResumeApproval(config: TelegramConfig): Promise<ApprovalResult> {
  const nonce = crypto.randomUUID();
  const text = ["\u{1F504} Resume request", "", "Agent is requesting to resume the session."].join(
    "\n",
  );

  const keyboard = buildKeyboard(nonce, [
    [
      { text: "Approve", callbackData: "approve" },
      { text: "Reject", callbackData: "reject" },
    ],
  ]);

  const sent = await apiCall<TelegramMessage>(config.botToken, "sendMessage", {
    chat_id: config.chatId,
    text,
    reply_markup: keyboard,
  });

  return awaitApproval(config, sent.message_id, nonce);
}

// ---------------------------------------------------------------------------
// Approval state machine driven by shared poller
// ---------------------------------------------------------------------------

function fireAndForget(promise: Promise<unknown>, context: string): void {
  promise.catch((err) => {
    console.error(`[telegram] ${context} failed:`, err instanceof Error ? err.message : err);
  });
}

function editMessage(config: TelegramConfig, messageId: number, text: string, context: string) {
  fireAndForget(
    apiCall(config.botToken, "editMessageText", {
      chat_id: config.chatId,
      message_id: messageId,
      text,
    }),
    context,
  );
}

function answerCallback(config: TelegramConfig, queryId: string, text?: string) {
  fireAndForget(
    apiCall(config.botToken, "answerCallbackQuery", {
      callback_query_id: queryId,
      ...(text ? { text } : {}),
    }),
    text ? "answerCallbackQuery(unauthorized)" : "answerCallbackQuery(ack)",
  );
}

interface ApprovalContext {
  config: TelegramConfig;
  messageId: number;
  nonce: string;
  finish: (result: ApprovalResult) => void;
}

type CallbackAction = "approve" | "auto_approve" | "reject" | "stop";

/**
 * Handles a button press on the original approval message. Returns the next
 * phase: "done" if we resolved the promise, "await-reason" if we now need a
 * text reply, or "ignore" if the update didn't belong to us.
 */
type CallbackOutcome =
  | { phase: "ignore" }
  | { phase: "done" }
  | { phase: "await-reason"; action: "reject" | "stop" };

function handleCallbackQuery(ctx: ApprovalContext, update: TelegramUpdate): CallbackOutcome {
  const query = update.callback_query;
  if (!query?.data?.startsWith(`${ctx.nonce}:`)) {
    return { phase: "ignore" };
  }

  if (!isAuthorizedUser(ctx.config, query.from?.id)) {
    answerCallback(ctx.config, query.id, "You are not authorized to respond to this request.");
    return { phase: "done" };
  }

  const action = query.data.slice(ctx.nonce.length + 1) as CallbackAction;
  answerCallback(ctx.config, query.id);

  if (action === "approve" || action === "auto_approve") {
    const label = action === "auto_approve" ? "Auto-approved" : "Approved";
    editMessage(
      ctx.config,
      ctx.messageId,
      `\u2705 ${label} at ${new Date().toLocaleTimeString()}`,
      "editMessageText(approved)",
    );
    ctx.finish({ action });
    return { phase: "done" };
  }

  // Reject or Stop: update the original message, then post a separate
  // force_reply prompt. editMessageText cannot carry a force_reply markup
  // (Telegram only allows inline keyboards there).
  const rejection = action === "stop" ? "stop" : "reject";
  const label = rejection === "stop" ? "Stopped" : "Rejected";
  editMessage(
    ctx.config,
    ctx.messageId,
    `\u274C ${label}. Reply with a reason.`,
    "editMessageText(awaiting-reason)",
  );
  return { phase: "await-reason", action: rejection };
}

/**
 * Handles a text reply to the force-reply prompt. Returns true if the update
 * was the user's reason reply and the approval is now complete.
 */
function handleReasonReply(
  ctx: ApprovalContext,
  update: TelegramUpdate,
  rejection: "reject" | "stop",
  reasonPromptMessageId: number | undefined,
): boolean {
  const replyTo = update.message?.reply_to_message?.message_id;
  const matchesPrompt =
    replyTo !== undefined && (replyTo === ctx.messageId || replyTo === reasonPromptMessageId);
  if (!matchesPrompt || !update.message?.text) {
    return false;
  }
  if (!isAuthorizedUser(ctx.config, update.message.from?.id)) {
    return false;
  }

  const reason = update.message.text;
  const label = rejection === "stop" ? "Stopped" : "Rejected";
  editMessage(
    ctx.config,
    ctx.messageId,
    `\u274C ${label}: ${reason}`,
    "editMessageText(reason-accepted)",
  );
  ctx.finish({ action: rejection, reason });
  return true;
}

function awaitApproval(
  config: TelegramConfig,
  messageId: number,
  nonce: string,
): Promise<ApprovalResult> {
  return new Promise((resolve) => {
    const deadline = Date.now() + config.timeoutMs;
    let waitingForReason = false;
    let rejectionAction: "reject" | "stop" = "reject";
    // Set once the bot posts a force-reply prompt; the user's reason text will
    // come back as a reply to this message rather than the original request.
    let reasonPromptMessageId: number | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      unregister();
    };

    const ctx: ApprovalContext = {
      config,
      messageId,
      nonce,
      finish: (result) => {
        cleanup();
        resolve(result);
      },
    };

    const timer = setTimeout(() => {
      cleanup();
      editMessage(config, messageId, "\u23F0 Timed out", "editMessageText(timeout)");
      resolve({ action: "reject", reason: "permission request timed out" });
    }, config.timeoutMs);

    const unregister = registerListener(config.botToken, (update) => {
      if (Date.now() > deadline) {
        return false;
      }

      if (waitingForReason) {
        return handleReasonReply(ctx, update, rejectionAction, reasonPromptMessageId);
      }

      const result = handleCallbackQuery(ctx, update);
      if (result.phase === "ignore") {
        return false;
      }
      if (result.phase === "done") {
        return true;
      }

      // result.phase === "await-reason": transition to phase 2 and post the
      // force-reply prompt as a new message.
      waitingForReason = true;
      rejectionAction = result.action;
      fireAndForget(
        apiCall<TelegramMessage>(config.botToken, "sendMessage", {
          chat_id: config.chatId,
          text: "Reply to this message with the reason:",
          reply_to_message_id: messageId,
          reply_markup: { force_reply: true, selective: true },
        }).then((sent) => {
          reasonPromptMessageId = sent.message_id;
        }),
        "sendMessage(force-reply-prompt)",
      );
      return true;
    });
  });
}
