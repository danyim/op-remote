import type { SocketRequest, SocketResponse } from "../protocol.ts";
import type { ApprovalResult } from "./approval.ts";

export interface RunApprovalInput {
  command: string[];
  cwd: string;
  reason: string;
  secretNames: string[];
}

/** Resolves secret names to their current values, or reports missing ones. */
export type EnvResolver = (
  names: string[],
) => { ok: true; env: Record<string, string> } | { ok: false; missing: string[] };

export type RunApprovalFn = (input: RunApprovalInput) => Promise<ApprovalResult>;
export type ResumeApprovalFn = () => Promise<ApprovalResult>;

export interface ResumeResult {
  kind: "resumed" | "not-stopped" | "denied";
  reason?: string;
}

export interface Session {
  isStopped(): boolean;
  isAutoApprove(): boolean;
  disableAutoApprove(): void;
  handleRequest(req: SocketRequest, resolveEnv: EnvResolver): Promise<SocketResponse>;
  tryResume(): Promise<ResumeResult>;
}

/**
 * Creates the session state machine that governs a single op-remote server
 * lifecycle. All approval side-effects are dependency-injected so tests can
 * exercise every state transition without hitting Telegram.
 */
export function createSession(
  runApproval: RunApprovalFn,
  resumeApproval: ResumeApprovalFn,
): Session {
  let stopped = false;
  let autoApprove = false;

  return {
    isStopped: () => stopped,
    isAutoApprove: () => autoApprove,
    disableAutoApprove: () => {
      autoApprove = false;
    },

    async handleRequest(req, resolveEnv) {
      // Fail fast on unknown env vars before bothering the approver with a
      // request that cannot be fulfilled anyway.
      const names = req.envVars.map((v) => v.name);
      const resolved = resolveEnv(names);
      if (!resolved.ok) {
        return {
          status: "rejected",
          reason: `unknown env vars: ${resolved.missing.join(", ")}`,
        };
      }

      if (autoApprove) {
        return { status: "approved", env: resolved.env };
      }

      const result = await runApproval({
        command: req.command,
        cwd: req.cwd,
        reason: req.reason,
        secretNames: names,
      });

      switch (result.action) {
        case "approve":
          return { status: "approved", env: resolved.env };
        case "auto_approve":
          autoApprove = true;
          return { status: "approved", env: resolved.env };
        case "stop":
          stopped = true;
          return { status: "rejected", reason: result.reason ?? "stopped" };
        case "reject":
          return { status: "rejected", reason: result.reason ?? "rejected" };
      }
    },

    async tryResume() {
      if (!stopped) {
        return { kind: "not-stopped" };
      }
      const result = await resumeApproval();
      if (result.action === "approve") {
        stopped = false;
        return { kind: "resumed" };
      }
      return { kind: "denied", reason: result.reason ?? "resume denied" };
    },
  };
}
