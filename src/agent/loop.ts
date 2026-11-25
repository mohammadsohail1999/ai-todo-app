import Anthropic from "@anthropic-ai/sdk";
import { runTool, tools, type ToolContext } from "@/agent/tools";

// Hand-written on purpose: this loop is what the project is for. Don't swap in Tool Runner.

export const MAX_ITERATIONS = 8; // guards against a runaway loop; each iteration is one API call
const MAX_TOKENS = 4096;
const MAX_JSON_RETRIES = 2;

export type LoopStatus = "done" | "refused" | "truncated" | "iteration_limit";

// Everything the loop does, in order. The terminal script prints all of it;
// the chat route (Phase 6) will turn some of it into stream events.
export type LoopEvent =
  | { type: "request"; iteration: number; params: Anthropic.MessageStreamParams }
  | { type: "text"; delta: string }
  | { type: "response"; iteration: number; message: Anthropic.Message }
  | { type: "tool_start"; block: Anthropic.ToolUseBlock }
  | { type: "tool_result"; result: Anthropic.ToolResultBlockParam }
  | { type: "retry"; iteration: number; error: unknown };

export type LoopResult = {
  status: LoopStatus;
  usage: Anthropic.Usage[]; // one entry per API call
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
};

export async function runAgentLoop({
  client,
  model,
  system,
  messages,
  ctx,
  onEvent = () => {},
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

    if (calls.length === 0) return { status: "done", usage };

    // Parallel calls run together, and all their results go back in ONE user message.
    const results = await Promise.all(
      calls.map(async (block) => {
        onEvent({ type: "tool_start", block });
        const result = await runTool(block, ctx);
        onEvent({ type: "tool_result", result });
        return result;
      }),
    );
    messages.push({ role: "user", content: results });
  }

  return { status: "iteration_limit", usage };
}
