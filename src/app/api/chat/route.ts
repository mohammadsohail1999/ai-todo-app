import Anthropic from "@anthropic-ai/sdk";
import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { toChatItems, type ChatEvent } from "@/agent/events";
import { runAgentLoop, type LoopEvent } from "@/agent/loop";
import { buildSystemPrompt } from "@/agent/prompt";
import { getVerifiedUser } from "@/lib/auth";
import {
  appendUserText,
  ConversationConflictError,
  loadConversation,
  saveConversation,
} from "@/lib/conversations";
import { isValidTimeZone, todayInTimeZone } from "@/lib/today";

const MAX_MESSAGE_LENGTH = 500;

// Tools that change todos. A successful one tells the list to reload.
const CHANGING_TOOLS = new Set(["add_todo", "set_todo_status", "move_todo", "delete_todo"]);

const timeZone = z.string().refine(isValidTimeZone);
const chatRequest = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  timeZone,
});

// Today's thread, as display items, so the chat survives a refresh.
export async function GET(request: NextRequest) {
  // Run at request time only. Without this, `next build` can try to run it ahead of time.
  await connection();

  try {
    const user = await getVerifiedUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = timeZone.safeParse(request.nextUrl.searchParams.get("timeZone"));
    if (!parsed.success) {
      return Response.json({ error: "Invalid timeZone" }, { status: 400 });
    }

    const date = todayInTimeZone(parsed.data);
    const { messages } = await loadConversation(user.userId, date);

    return Response.json({ date, items: toChatItems(messages) });
  } catch (error) {
    console.error("Loading the chat failed:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}

// Runs the agent on one new message and streams what happens as newline-delimited JSON.
export async function POST(request: NextRequest) {
  const user = await getVerifiedUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = chatRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid message" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) {
    console.error("ANTHROPIC_API_KEY or ANTHROPIC_MODEL is not set.");
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }

  const today = todayInTimeZone(parsed.data.timeZone);
  let conversation;
  try {
    conversation = await loadConversation(user.userId, today);
  } catch (error) {
    console.error("Loading the chat failed:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }

  const { messages } = conversation;
  let version = conversation.version;
  appendUserText(messages, parsed.data.message);

  const encoder = new TextEncoder();

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
        send({ type: "done", status: result.status });
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
