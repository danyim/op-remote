import { describe, expect, test } from "bun:test";
import {
  buildApprovalBlocks,
  buildResumeBlocks,
  extractReason,
  parseActionId,
} from "../src/serve/slack.ts";

describe("slack provider helpers", () => {
  test("parseActionId splits nonce and action", () => {
    expect(parseActionId("abc123:approve")).toEqual({ nonce: "abc123", action: "approve" });
    expect(parseActionId("no-colon")).toBeUndefined();
  });

  test("approval blocks carry nonce-prefixed action ids", () => {
    const blocks = buildApprovalBlocks("nonce-1", {
      command: ["echo", "hi"],
      cwd: "/tmp",
      reason: "test",
      secretNames: ["API_KEY"],
    });
    const actions = blocks.find((b) => b.type === "actions") as {
      elements: { action_id: string }[];
    };
    expect(actions.elements.map((e) => e.action_id)).toEqual([
      "nonce-1:approve",
      "nonce-1:reject",
      "nonce-1:auto_approve",
      "nonce-1:stop",
    ]);
  });

  test("resume blocks have approve/reject only", () => {
    const actions = buildResumeBlocks("n").find((b) => b.type === "actions") as {
      elements: { action_id: string }[];
    };
    expect(actions.elements.map((e) => e.action_id)).toEqual(["n:approve", "n:reject"]);
  });

  test("extractReason finds submitted text", () => {
    const view = {
      state: { values: { reason_block: { reason_input: { value: "  because  " } } } },
    };
    expect(extractReason(view)).toBe("because");
    expect(
      extractReason({
        state: { values: { reason_block: { reason_input: { value: "   " } } } },
      }),
    ).toBeUndefined();
  });
});
