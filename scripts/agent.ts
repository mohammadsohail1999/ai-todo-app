// Phase 4: runs the agent loop in the terminal and prints every request and response in full.
// Usage: npm run agent -- "add buy milk, then tell me what's on my list"
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { MAX_ITERATIONS, runAgentLoop, type LoopEvent } from "@/agent/loop";
import { buildSystemPrompt } from "@/agent/prompt";
import { todayInTimeZone } from "@/lib/today";

const DEFAULT_PROMPT = "add buy milk, then tell me what's on my list";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Add it to .env.local (see .env.example).`);
    process.exit(1);
  }
  return value;
}

const show = (value: unknown) => JSON.stringify(value, null, 2);

function heading(text: string) {
  console.log(`\n${"=".repeat(20)} ${text} ${"=".repeat(20)}`);
}

// One line per API call, so you can see what each turn costs as the history grows.
function usageLine(usage: Anthropic.Usage) {
  return (
    `Usage: ${usage.input_tokens} in, ${usage.output_tokens} out, ` +
    `${usage.cache_read_input_tokens ?? 0} cache read`
  );
}

function printEvent(event: LoopEvent) {
  switch (event.type) {
    case "request":
      // The full body, every time: watch `messages` grow by an assistant turn and a
      // tool_result turn per iteration. The API keeps nothing between calls.
      heading(`Iteration ${event.iteration}: request`);
      console.log(show(event.params));
      heading(`Iteration ${event.iteration}: streamed text`);
      break;
    case "text":
      process.stdout.write(event.delta);
      break;
    case "response":
      heading(`Iteration ${event.iteration}: response`);
      console.log(show(event.message));
      console.log(`\n${usageLine(event.message.usage)}`);
      break;
    case "tool_start":
      heading(`Run tool ${event.block.name} (${event.block.id})`);
      console.log(show(event.block.input));
      break;
    case "tool_result":
      heading(`Tool result for ${event.result.tool_use_id}`);
      console.log(show(event.result));
      break;
    case "retry":
      heading(`Iteration ${event.iteration}: tool input wasn't valid JSON, retrying`);
      console.log(event.error);
      break;
  }
}

async function main() {
  const anthropic = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  const model = requireEnv("ANTHROPIC_MODEL");

  // A script has no cookie, so it signs in as the test user. The client then carries
  // that user's session, and Row Level Security applies exactly as in the app.
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: requireEnv("AGENT_TEST_EMAIL"),
    password: requireEnv("AGENT_TEST_PASSWORD"),
  });
  if (signInError) {
    console.error("Signing in the test user failed:", signInError.message);
    process.exit(1);
  }

  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = todayInTimeZone(timeZone);
    const prompt = process.argv.slice(2).join(" ").trim() || DEFAULT_PROMPT;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

    console.log(`Model ${model}, today ${today} (${timeZone})`);

    const result = await runAgentLoop({
      client: anthropic,
      model,
      system: buildSystemPrompt(today),
      messages,
      ctx: { supabase, today },
      onEvent: printEvent,
    });

    heading("Finished");
    const total = result.usage.reduce(
      (sum, u) => ({
        input_tokens: sum.input_tokens + u.input_tokens,
        output_tokens: sum.output_tokens + u.output_tokens,
      }),
      { input_tokens: 0, output_tokens: 0 },
    );
    console.log(`Status: ${result.status}`);
    if (result.status === "confirm_required") {
      // The terminal has no Confirm card, so the held deletes are only shown, never run.
      console.log("Held for confirmation (not deleted):");
      console.log(show(result.pending));
    }
    if (result.status === "iteration_limit") {
      console.log(`Stopped after ${MAX_ITERATIONS} API calls without a final answer.`);
    }
    console.log(`API calls: ${result.usage.length}`);
    console.log(`Tokens: ${total.input_tokens} in, ${total.output_tokens} out`);
  } finally {
    // "local" revokes only this script's session, so the browser stays logged in.
    await supabase.auth.signOut({ scope: "local" });
  }
}

main().catch((error) => {
  if (error instanceof Anthropic.AuthenticationError) {
    console.error("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.");
  } else if (error instanceof Anthropic.RateLimitError) {
    console.error("Rate limited by the Anthropic API. Try again in a moment.");
  } else if (error instanceof Anthropic.APIError) {
    console.error(`Anthropic API error ${error.status}:`, error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
