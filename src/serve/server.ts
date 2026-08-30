import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { SocketRequest, SocketResponse } from "../protocol.ts";
import { readEnvFile } from "../run/envfile.ts";
import { createSession, type RunApprovalInput } from "./session.ts";
import { type SocketHandler, createSocketServer } from "./socket.ts";
import {
  requestResumeApproval as telegramResume,
  requestRunApproval as telegramRun,
} from "./telegram.ts";
import { requestResumeApproval as slackResume, requestRunApproval as slackRun } from "./slack.ts";
import { TokenStore } from "./tokens.ts";

type ApprovalProvider = "telegram" | "slack";

interface ServerConfig {
  provider: ApprovalProvider;
  timeoutMs: number;
  telegramBotToken: string;
  telegramChatId: string;
  telegramApproverIds: number[];
  slackBotToken: string;
  slackAppToken: string;
  slackChannelId: string;
  slackApproverIds: string[];
}

function readConfig(): ServerConfig {
  const provider = (
    process.env.REMOTE_OP_APPROVAL_PROVIDER ?? "telegram"
  ).toLowerCase() as ApprovalProvider;
  if (provider !== "telegram" && provider !== "slack") {
    throw new Error(`REMOTE_OP_APPROVAL_PROVIDER must be "telegram" or "slack", got "${provider}"`);
  }

  const timeoutMs = Number.parseInt(process.env.REMOTE_OP_TIMEOUT ?? "120", 10) * 1000;

  const telegramBotToken = process.env.REMOTE_OP_TELEGRAM_BOT_TOKEN ?? "";
  const telegramChatId = process.env.REMOTE_OP_TELEGRAM_CHAT_ID ?? "";
  if (provider === "telegram" && !telegramBotToken) {
    throw new Error(
      "REMOTE_OP_TELEGRAM_BOT_TOKEN is required when REMOTE_OP_APPROVAL_PROVIDER=telegram",
    );
  }
  if (provider === "telegram" && !telegramChatId) {
    throw new Error(
      "REMOTE_OP_TELEGRAM_CHAT_ID is required when REMOTE_OP_APPROVAL_PROVIDER=telegram",
    );
  }

  const approverIdsRaw = process.env.REMOTE_OP_TELEGRAM_APPROVER_IDS ?? "";
  const telegramApproverIds = approverIdsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => !Number.isNaN(n));

  const slackBotToken = process.env.SLACK_BOT_TOKEN ?? "";
  const slackAppToken = process.env.SLACK_APP_TOKEN ?? "";
  const slackChannelId = process.env.SLACK_CHANNEL_ID ?? "";
  if (provider === "slack" && !slackBotToken) {
    throw new Error("SLACK_BOT_TOKEN is required when REMOTE_OP_APPROVAL_PROVIDER=slack");
  }
  if (provider === "slack" && !slackAppToken) {
    throw new Error("SLACK_APP_TOKEN is required when REMOTE_OP_APPROVAL_PROVIDER=slack");
  }
  if (provider === "slack" && !slackChannelId) {
    throw new Error("SLACK_CHANNEL_ID is required when REMOTE_OP_APPROVAL_PROVIDER=slack");
  }

  const slackApproverIds = (process.env.SLACK_APPROVER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    provider,
    timeoutMs,
    telegramBotToken,
    telegramChatId,
    telegramApproverIds,
    slackBotToken,
    slackAppToken,
    slackChannelId,
    slackApproverIds,
  };
}

/**
 * Reads an env file and resolves all op:// references into process.env in a
 * single `op run` invocation at startup, while the user is present and can
 * authenticate with 1Password. Missing file is silently ignored so the plugin
 * works for projects without a .env.tpl.
 */
async function loadEnvFile(envFile: string): Promise<void> {
  if (!(await Bun.file(envFile).exists())) return;

  const { secretVars } = await readEnvFile(envFile);
  if (secretVars.length === 0) return;

  const names = new Set(secretVars.map((v) => v.name));

  // Resolve all op:// references in one shot via `op run -- env`.
  const proc = Bun.spawn(["op", "run", `--env-file=${envFile}`, "--", "env"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`op run failed (exit code ${exitCode})`);
  }

  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    if (names.has(key)) {
      process.env[key] = line.slice(idx + 1);
    }
  }
}

export async function startServer(opts: { envFile?: string } = {}): Promise<void> {
  // A provider hiccup or malformed update must never take the server down.
  // Log and keep running so the in-flight socket handler can still respond.
  process.on("unhandledRejection", (reason) => {
    console.error("[op-remote] unhandled rejection:", reason);
  });

  if (opts.envFile) {
    await loadEnvFile(opts.envFile);
  }

  const config = readConfig();
  const tokens = new TokenStore(config.timeoutMs);

  const runApproval = (input: RunApprovalInput) =>
    config.provider === "slack"
      ? slackRun(
          {
            botToken: config.slackBotToken,
            appToken: config.slackAppToken,
            channelId: config.slackChannelId,
            timeoutMs: config.timeoutMs,
            approverIds: config.slackApproverIds,
          },
          input,
        )
      : telegramRun(
          {
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            timeoutMs: config.timeoutMs,
            approverIds: config.telegramApproverIds,
          },
          input,
        );

  const resumeApproval = () =>
    config.provider === "slack"
      ? slackResume({
          botToken: config.slackBotToken,
          appToken: config.slackAppToken,
          channelId: config.slackChannelId,
          timeoutMs: config.timeoutMs,
          approverIds: config.slackApproverIds,
        })
      : telegramResume({
          botToken: config.telegramBotToken,
          chatId: config.telegramChatId,
          timeoutMs: config.timeoutMs,
          approverIds: config.telegramApproverIds,
        });

  const session = createSession(runApproval, resumeApproval);

  // Socket handler that resolves secrets from process.env via the session.
  const socketHandler: SocketHandler = {
    handleRequest(req: SocketRequest): Promise<SocketResponse> {
      return session.handleRequest(req, (names) => {
        const missing: string[] = [];
        const env: Record<string, string> = {};
        for (const name of names) {
          const value = process.env[name];
          if (value === undefined) {
            missing.push(name);
          } else {
            env[name] = value;
          }
        }
        return missing.length > 0 ? { ok: false, missing } : { ok: true, env };
      });
    },
  };

  const { sockPath } = createSocketServer(tokens, socketHandler);

  // MCP server.
  const mcp = new McpServer(
    { name: "op-remote", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );

  function textResponse(text: string, isError?: boolean) {
    const content = [{ type: "text" as const, text }];
    return isError ? { isError: true, content } : { content };
  }

  // Tool: request_token
  mcp.registerTool(
    "request_token",
    {
      title: "Request Token",
      description:
        "Request a one-time token for authenticating with the op-remote CLI. Returns a token and socket path. If the session has been stopped by the user, this will return an error instructing you to stop what you are doing and wait for further instructions from the user.",
      inputSchema: z.object({}),
    },
    async () => {
      if (session.isStopped()) {
        return textResponse(
          "Session has been stopped by the user. Stop what you are doing and wait for further instructions from the user.",
          true,
        );
      }

      const token = tokens.create();
      return textResponse(JSON.stringify({ token, sock: sockPath }));
    },
  );

  // Tool: resume
  mcp.registerTool(
    "resume",
    {
      title: "Resume Session",
      description:
        "Request to resume a stopped session. Requires approval via the configured approval provider (Telegram or Slack). Only use when the user explicitly asks you to resume.",
      inputSchema: z.object({}),
    },
    async () => {
      const result = await session.tryResume();
      switch (result.kind) {
        case "not-stopped":
          return textResponse("Session is not stopped.");
        case "resumed":
          return textResponse("Session resumed.");
        default:
          return textResponse(`Resume denied: ${result.reason}`, true);
      }
    },
  );

  // Tool: disable_auto_approve
  mcp.registerTool(
    "disable_auto_approve",
    {
      title: "Disable Auto-Approve",
      description:
        "Disable auto-approval so future secret access requests require approval via the configured approval provider (Telegram or Slack) again. Only use when the user explicitly asks.",
      inputSchema: z.object({}),
    },
    async () => {
      session.disableAutoApprove();
      return textResponse("Auto-approve disabled. Future requests will require approval again.");
    },
  );

  // Start MCP server on stdio.
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}
