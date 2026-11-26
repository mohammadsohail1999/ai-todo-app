import type Anthropic from "@anthropic-ai/sdk";
import type { LoopStatus } from "@/agent/loop";
import type { PendingTodo } from "@/agent/pending";

// Shared by the chat route and the chat panel, so it must not import anything server-only.

// One line of the chat route's newline-delimited JSON stream.
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "todos_changed" }
  // The turn paused on deletes. Titles come from the database. The stream ends after this.
  | { type: "confirm_required"; todos: PendingTodo[] }
  | { type: "done"; status: LoopStatus }
  | { type: "error"; message: string };

// What the chat panel shows. Thinking blocks, signatures and raw tool results stay on the server.
export type ChatItem =
  | { role: "user" | "assistant"; text: string }
  | { role: "tool"; name: string };

// Turns the saved API history into display items, in order.
export function toChatItems(messages: Anthropic.MessageParam[]): ChatItem[] {
  const items: ChatItem[] = [];

  for (const message of messages) {
    const { role } = message;
    // The app never saves system messages, so only these two roles are shown.
    if (role !== "user" && role !== "assistant") continue;

    if (typeof message.content === "string") {
      items.push({ role, text: message.content });
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) {
        items.push({ role, text: block.text });
      } else if (block.type === "tool_use") {
        items.push({ role: "tool", name: block.name });
      }
    }
  }

  return items;
}
