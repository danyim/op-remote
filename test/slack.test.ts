import { describe, expect, test } from "bun:test";
import {
  buildApprovalBlocks,
  buildResumeBlocks,
  extractReason,
  formatExpiry,
  parseActionId,
} from "../src/serve/slack.ts";

describe("slack provider helpers", () => {
  test("parseActionId splits nonce and action", () => {
    expect(parseActionId("abc123:approve")).toEqual({ nonce: "abc123", action: "approve" });
    expect(parseActionId("no-colon")).toBeUndefined();
  });

  test("formatExpiry renders human-readable timeouts", () => {
    expect(formatExpiry(300_000)).toBe("in 5m");
    expect(formatExpiry(600_000)).toBe("in 10m");
    expect(formatExpiry(120_000)).toBe("in 2m");
    expect(formatExpiry(45_000)).toBe("in 45s");
  });

  test("approval blocks carry nonce-prefixed action ids and expiry", () => {
    const blocks = buildApprovalBlocks(
      "nonce-1",
      {
        command: ["echo", "hi"],
        cwd: "/tmp",
        reason: "test",
        secretNames: ["API_KEY"],
      },
      300_000,
    );
    const actions = blocks.find((b) => b.type === "actions") as {
      elements: { action_id: string }[];
    };
    expect(actions.elements.map((e) => e.action_id)).toEqual([
      "nonce-1:approve",
      "nonce-1:reject",
      "nonce-1:auto_approve",
      "nonce-1:stop",
    ]);
    const details = blocks.find(
      (b) =>
        b.type === "section" &&
        (b as { text?: { text?: string } }).text?.text?.includes("*Expires:*"),
    ) as { text: { text: string } };
    expect(details.text.text).toContain("*Expires:* in 5m");
  });

  test("resume blocks have approve/reject only and an expiry", () => {
    const actions = buildResumeBlocks("n", 120_000).find((b) => b.type === "actions") as {
      elements: { action_id: string }[];
    };
    expect(actions.elements.map((e) => e.action_id)).toEqual(["n:approve", "n:reject"]);
    const section = buildResumeBlocks("n", 120_000).find((b) => b.type === "section") as {
      text: { text: string };
    };
    expect(section.text.text).toContain("*Expires:* in 2m");
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
