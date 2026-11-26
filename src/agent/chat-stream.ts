import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatEvent } from "@/agent/events";
import { runAgentLoop, type LoopEvent } from "@/agent/loop";
import type { PendingTodo, PendingTurn } from "@/agent/pending";
import { buildSystemPrompt } from "@/agent/prompt";
import { ConversationConflictError, saveConversation } from "@/lib/conversations";
import { getTodosByIds } from "@/lib/todos";

// Shared by POST /api/chat and POST /api/chat/confirm: runs the agent loop on a history that
// ends with a user message and streams what happens as newline-delimited JSON.

// Tools that change todos. A successful one tells the list to reload.
const CHANGING_TOOLS = new Set(["add_todo", "set_todo_status", "move_todo", "delete_todo"]);

type StreamAgentTurnOptions = {
  user: { userId: string; supabase: SupabaseClient };
  today: string;
  // The thread so far, ending with a user message. The loop's checkpoints save it.
  messages: Anthropic.MessageParam[];
  // The saved version `messages` builds on.
  version: number;
  apiKey: string;
  model: string;
  // Events to send before the loop starts, such as the results of a confirmed delete.
  before?: ChatEvent[];
};

// The card's rows, read from the database so the user approves real titles.
export async function pendingTodos(
  supabase: SupabaseClient,
  pending: PendingTurn,
): Promise<PendingTodo[]> {
  const todos = await getTodosByIds(
    supabase,
    pending.deletes.map((d) => d.todoId),
  );
  return todos.map(({ id, title, date }) => ({ id, title, date }));
}

export function streamAgentTurn({
  user,
  today,
  messages,
  version: startVersion,
  apiKey,
  model,
  before = [],
}: StreamAgentTurnOptions): Response {
  const encoder = new TextEncoder();
  let version = startVersion;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: ChatEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The browser went away. The loop keeps going so the thread is still saved.
          open = false;
        }
      };

      for (const event of before) send(event);

      // tool_result blocks only carry the call's id, so remember which tool each id was.
      const toolNames = new Map<string, string>();

      const onEvent = (event: LoopEvent) => {
        switch (event.type) {
          case "text":
            send({ type: "text", delta: event.delta });
            break;
          case "tool_start":
            toolNames.set(event.block.id, event.block.name);
            send({ type: "tool_start", name: event.block.name });
            break;
          case "tool_result": {
            const name = toolNames.get(event.result.tool_use_id) ?? "unknown";
            const ok = !event.result.is_error;
            send({ type: "tool_result", name, ok });
            if (ok && CHANGING_TOOLS.has(name)) send({ type: "todos_changed" });
            break;
          }
          case "response":
            console.log(
              `[chat] usage: ${event.message.usage.input_tokens} in, ` +
                `${event.message.usage.output_tokens} out`,
            );
            break;
        }
      };

      try {
        const result = await runAgentLoop({
          client: new Anthropic({ apiKey }),
          model,
          system: buildSystemPrompt(today),
          messages,
          ctx: { supabase: user.supabase, today },
          onEvent,
          onCheckpoint: async (history) => {
            version = await saveConversation(user.userId, today, history, version);
          },
        });

        if (result.status === "confirm_required") {
          // The assistant turn and its held deletes are saved in one write, then the
          // request ends. POST /api/chat/confirm picks it up from the database.
          version = await saveConversation(
            user.userId,
            today,
            messages,
            version,
            result.pending,
          );
          send({
            type: "confirm_required",
            todos: await pendingTodos(user.supabase, result.pending),
          });
        } else {
          send({ type: "done", status: result.status });
        }
      } catch (error) {
        console.error("The chat turn failed:", error);
        send({
          type: "error",
          message:
            error instanceof ConversationConflictError
              ? "This chat changed in another tab. Reload and try again."
              : "Something went wrong. Try again.",
        });
      } finally {
        if (open) controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Both chat routes need these, and neither should start without them.
export function anthropicConfig() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) {
    console.error("ANTHROPIC_API_KEY or ANTHROPIC_MODEL is not set.");
    return null;
  }
  return { apiKey, model };
}
