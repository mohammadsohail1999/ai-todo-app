import Anthropic from "@anthropic-ai/sdk";
import type { PendingTurn } from "@/agent/pending";
import { DELETE_TOOL, holdDeletes, runTool, tools, type ToolContext } from "@/agent/tools";

// Hand-written on purpose: this loop is what the project is for. Don't swap in Tool Runner.

export const MAX_ITERATIONS = 8; // guards against a runaway loop; each iteration is one API call
const MAX_TOKENS = 4096;
const MAX_JSON_RETRIES = 2;

export type LoopStatus =
  | "done"
  | "refused"
  | "truncated"
  | "iteration_limit"
  | "confirm_required";

// Everything the loop does, in order. The terminal script prints all of it;
// the chat route (Phase 6) will turn some of it into stream events.
export type LoopEvent =
  | { type: "request"; iteration: number; params: Anthropic.MessageStreamParams }
  | { type: "text"; delta: string }
  | { type: "response"; iteration: number; message: Anthropic.Message }
  | { type: "tool_start"; block: Anthropic.ToolUseBlock }
  | { type: "tool_result"; result: Anthropic.ToolResultBlockParam }
  | { type: "retry"; iteration: number; error: unknown };

export type LoopResult =
  | {
      status: Exclude<LoopStatus, "confirm_required">;
      usage: Anthropic.Usage[]; // one entry per API call
    }
  | {
      // The turn asked for deletes. `messages` ends with that assistant turn, and the caller
      // must save it together with `pending`: neither is valid history without the other.
      status: "confirm_required";
      usage: Anthropic.Usage[];
      pending: PendingTurn;
    };

type RunAgentLoopOptions = {
  client: Anthropic;
  model: string;
  system: string;
  // The conversation so far, ending with the user's new message. The loop appends to it
  // and never edits an earlier entry, so the caller can save it as it is.
  messages: Anthropic.MessageParam[];
  ctx: ToolContext;
  onEvent?: (event: LoopEvent) => void;
  // Called whenever `messages` is a valid history to save: after each round of tool
  // results, and after the final answer. The chat route saves the thread here.
  onCheckpoint?: (messages: Anthropic.MessageParam[]) => Promise<void>;
};

export async function runAgentLoop({
  client,
  model,
  system,
  messages,
  ctx,
  onEvent = () => {},
  onCheckpoint = async () => {},
}: RunAgentLoopOptions): Promise<LoopResult> {
  const usage: Anthropic.Usage[] = [];
  let jsonRetries = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    // The whole history goes with every request: the API keeps no state between calls.
    const params: Anthropic.MessageStreamParams = {
      model,
      max_tokens: MAX_TOKENS,
      system,
      tools,
      messages,
      // Haiku 5.5 thinks by default with empty text; "summarized" makes the reasoning readable.
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low" },
    };
    onEvent({ type: "request", iteration, params });

    let message: Anthropic.Message;
    try {
      const stream = client.messages.stream(params);
      stream.on("text", (delta) => onEvent({ type: "text", delta }));
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (error) {
      // With eager input streaming, a tool input that isn't valid JSON at all rejects here.
      // Only that is retried. API errors (auth, rate limit, overload...) go to the caller.
      if (error instanceof Anthropic.APIError || jsonRetries >= MAX_JSON_RETRIES) {
        throw error;
      }
      jsonRetries++;
      onEvent({ type: "retry", iteration, error });
      continue;
    }

    usage.push(message.usage);
    onEvent({ type: "response", iteration, message });

    // Check the stop reason before running anything: a refused or cut-off turn
    // can hold a tool_use with partial input. Neither is saved, because a tool_use
    // in history would need a tool_result in the very next message.
    if (message.stop_reason === "refusal") return { status: "refused", usage };
    const calls = message.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (
      message.stop_reason === "max_tokens" ||
      message.stop_reason === "model_context_window_exceeded" ||
      (calls.length > 0 && message.stop_reason !== "tool_use")
    ) {
      return { status: "truncated", usage };
    }

    // Saved exactly as received, thinking blocks included. Editing them breaks later requests.
    messages.push({ role: "assistant", content: message.content });

    if (calls.length === 0) {
      await onCheckpoint(messages);
      return { status: "done", usage };
    }

    // Deletes are held for the user's Confirm; everything else runs now, in parallel.
    const deletes = calls.filter((block) => block.name === DELETE_TOOL);
    const others = calls.filter((block) => block.name !== DELETE_TOOL);

    for (const block of deletes) onEvent({ type: "tool_start", block });
    const [otherResults, { held, results: deleteErrors }] = await Promise.all([
      Promise.all(
        others.map(async (block) => {
          onEvent({ type: "tool_start", block });
          const result = await runTool(block, ctx);
          onEvent({ type: "tool_result", result });
          return result;
        }),
      ),
      holdDeletes(deletes, ctx),
    ]);
    for (const result of deleteErrors) onEvent({ type: "tool_result", result });

    // Results stay in call order, so the message reads the same as when nothing is held.
    const byId = new Map(
      [...otherResults, ...deleteErrors].map((result) => [result.tool_use_id, result]),
    );
    const results = calls.flatMap((block) => byId.get(block.id) ?? []);

    if (held.length > 0) {
      // A request can't wait for a person, so the turn stops here. No checkpoint: this
      // history has tool_use blocks without results until the user decides.
      return { status: "confirm_required", usage, pending: { deletes: held, results } };
    }

    // Parallel calls run together, and all their results go back in ONE user message.
    messages.push({ role: "user", content: results });
    // Every tool_use now has its tool_result, so this history is safe to save.
    await onCheckpoint(messages);
  }

  return { status: "iteration_limit", usage };
}
