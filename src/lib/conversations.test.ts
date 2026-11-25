import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

// conversations.ts is server-only and creates the secret-key client; neither is needed here.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { appendUserText } = await import("@/lib/conversations");

describe("appendUserText", () => {
  it("starts a new user message after an assistant turn", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
    ];

    appendUserText(messages, "add milk");

    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({ role: "user", content: "add milk" });
  });

  it("starts the thread when history is empty", () => {
    const messages: Anthropic.MessageParam[] = [];

    appendUserText(messages, "add milk");

    expect(messages).toEqual([{ role: "user", content: "add milk" }]);
  });

  it("joins a trailing user message so turns keep alternating", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ];

    appendUserText(messages, "try again");

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
      { type: "text", text: "try again" },
    ]);
  });
});
