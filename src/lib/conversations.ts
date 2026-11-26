import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { PendingTurn } from "@/agent/pending";
import { createAdminClient } from "@/lib/supabase/admin";

// The only code that touches `conversations`. The table has no client grants, so this uses
// the secret-key client, and every query filters by the user id from verified claims.
// One thread per user per day; `messages` is saved in the API's exact format.

export type Conversation = {
  messages: Anthropic.MessageParam[];
  // 0 means no row yet. Each save bumps it, so two writers can't overwrite each other.
  version: number;
  // Set while a delete waits for Confirm or Cancel. No new message may land until it's settled.
  pending: PendingTurn | null;
};

// Another request saved this thread first, for example from a second tab.
export class ConversationConflictError extends Error {
  constructor() {
    super("The conversation was changed by another request.");
    this.name = "ConversationConflictError";
  }
}

const UNIQUE_VIOLATION = "23505";

export async function loadConversation(userId: string, date: string): Promise<Conversation> {
  const { data, error } = await createAdminClient()
    .from("conversations")
    .select("messages, version, pending")
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();

  if (error) throw error;
  if (!data) return { messages: [], version: 0, pending: null };
  return {
    messages: data.messages as Anthropic.MessageParam[],
    version: data.version,
    pending: data.pending as PendingTurn | null,
  };
}

// Saves only if nobody else saved since `version` was read. Returns the new version.
// `pending` is always written: a paused turn sets it in the same write as its messages,
// and every other save clears it.
export async function saveConversation(
  userId: string,
  date: string,
  messages: Anthropic.MessageParam[],
  version: number,
  pending: PendingTurn | null = null,
): Promise<number> {
  const admin = createAdminClient();

  if (version === 0) {
    const { error } = await admin
      .from("conversations")
      .insert({ user_id: userId, date, messages, pending, version: 1 });
    if (error?.code === UNIQUE_VIOLATION) throw new ConversationConflictError();
    if (error) throw error;
    return 1;
  }

  const { data, error } = await admin
    .from("conversations")
    .update({ messages, pending, version: version + 1 })
    .eq("user_id", userId)
    .eq("date", date)
    .eq("version", version)
    .select("version")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new ConversationConflictError();
  return data.version;
}

// Takes the paused turn so exactly one request can settle it: the update only matches while
// `pending` is set, so a double click or a second tab gets null. The version bump also
// stops an older save from overwriting the thread in between.
export async function claimPending(
  userId: string,
  date: string,
): Promise<(Conversation & { pending: PendingTurn }) | null> {
  const admin = createAdminClient();

  const current = await loadConversation(userId, date);
  if (!current.pending) return null;

  const { data, error } = await admin
    .from("conversations")
    .update({ pending: null, version: current.version + 1 })
    .eq("user_id", userId)
    .eq("date", date)
    .eq("version", current.version)
    .not("pending", "is", null)
    .select("version")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { messages: current.messages, pending: current.pending, version: data.version };
}

// Adds the user's new message. If the history already ends with a user message (tool results
// left by a refused or cut-off turn), the text joins it, so user and assistant keep alternating.
export function appendUserText(messages: Anthropic.MessageParam[], text: string) {
  const last = messages.at(-1);

  if (last?.role === "user") {
    const content: Anthropic.ContentBlockParam[] =
      typeof last.content === "string"
        ? [{ type: "text", text: last.content }]
        : [...last.content];
    content.push({ type: "text", text });
    messages[messages.length - 1] = { role: "user", content };
    return;
  }

  messages.push({ role: "user", content: text });
}
