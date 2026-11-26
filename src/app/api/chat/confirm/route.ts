import type { NextRequest } from "next/server";
import { z } from "zod";
import { anthropicConfig, streamAgentTurn } from "@/agent/chat-stream";
import type { ChatEvent } from "@/agent/events";
import { resolvePending } from "@/agent/tools";
import { getVerifiedUser } from "@/lib/auth";
import { claimPending, saveConversation } from "@/lib/conversations";
import { isValidTimeZone, todayInTimeZone } from "@/lib/today";

const confirmRequest = z.object({
  decision: z.enum(["confirm", "cancel"]),
  timeZone: z.string().refine(isValidTimeZone),
});

// Settles today's paused delete with the user's decision, then lets Claude carry on,
// streamed the same way as POST /api/chat.
export async function POST(request: NextRequest) {
  const user = await getVerifiedUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = confirmRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const config = anthropicConfig();
  if (!config) {
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }

  // Today's thread only: after midnight a delete left in yesterday's thread never runs.
  const today = todayInTimeZone(parsed.data.timeZone);

  try {
    // Only one request can claim it, so a double click or a second tab deletes once.
    const claimed = await claimPending(user.userId, today);
    if (!claimed) {
      return Response.json({ error: "There's nothing to confirm." }, { status: 409 });
    }

    const { messages, pending } = claimed;
    const ctx = { supabase: user.supabase, today };
    const results = await resolvePending(
      pending,
      parsed.data.decision,
      messages.at(-1)?.content ?? [],
      ctx,
    );
    messages.push(results);

    // Saved before calling the API, so the thread stays valid even if the next turn
    // is refused or fails: every tool_use now has its tool_result.
    const version = await saveConversation(user.userId, today, messages, claimed.version);

    const before: ChatEvent[] = [];
    const heldIds = new Set(pending.deletes.map((d) => d.toolUseId));
    let changed = false;
    for (const block of Array.isArray(results.content) ? results.content : []) {
      if (block.type !== "tool_result" || !heldIds.has(block.tool_use_id)) continue;
      const ok = !block.is_error;
      before.push({ type: "tool_result", name: "delete_todo", ok });
      if (ok && parsed.data.decision === "confirm") changed = true;
    }
    if (changed) before.push({ type: "todos_changed" });

    return streamAgentTurn({ user, today, messages, version, before, ...config });
  } catch (error) {
    console.error("Settling the delete failed:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}
