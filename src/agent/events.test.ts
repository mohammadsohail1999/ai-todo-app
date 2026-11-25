import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { toChatItems } from "@/agent/events";

describe("toChatItems", () => {
  it("keeps text and tool names, and drops thinking and tool results", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "add milk" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret", signature: "sig" },
          { type: "tool_use", id: "toolu_1", name: "add_todo", input: { title: "milk" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{\"todo\":{}}" }],
      },
      { role: "assistant", content: [{ type: "text", text: "Added milk." }] },
    ];

    expect(toChatItems(messages)).toEqual([
      { role: "user", text: "add milk" },
      { role: "tool", name: "add_todo" },
      { role: "assistant", text: "Added milk." },
    ]);
  });

  it("shows a user message that was added after tool results", () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
          { type: "text", text: "try again" },
        ],
      },
    ];

    expect(toChatItems(messages)).toEqual([{ role: "user", text: "try again" }]);
  });
});
