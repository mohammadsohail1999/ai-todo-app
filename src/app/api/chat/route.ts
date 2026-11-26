import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { anthropicConfig, pendingTodos, streamAgentTurn } from "@/agent/chat-stream";
import { toChatItems } from "@/agent/events";
import { getVerifiedUser } from "@/lib/auth";
import { appendUserText, loadConversation } from "@/lib/conversations";
import { isValidTimeZone, todayInTimeZone } from "@/lib/today";

const MAX_MESSAGE_LENGTH = 500;

const timeZone = z.string().refine(isValidTimeZone);
const chatRequest = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  timeZone,
});

// Today's thread, as display items, so the chat survives a refresh. A paused delete comes back
// too, with titles read from the database, so the Confirm/Cancel card survives it as well.
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
    const { messages, pending } = await loadConversation(user.userId, date);

    return Response.json({
      date,
      items: toChatItems(messages),
      pending: pending ? await pendingTodos(user.supabase, pending) : null,
    });
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

  const config = anthropicConfig();
  if (!config) {
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

  // Every tool_use needs its tool_result in the very next message, so nothing may land
  // between a paused delete and the user's decision. The disabled input is only the UI side.
  if (conversation.pending) {
    return Response.json(
      { error: "Confirm or cancel the pending delete first." },
      { status: 409 },
    );
  }

  const { messages, version } = conversation;
  appendUserText(messages, parsed.data.message);

  return streamAgentTurn({ user, today, messages, version, ...config });
}
