import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ITERATIONS, runAgentLoop } from "@/agent/loop";
import type { ToolContext } from "@/agent/tools";
import * as todos from "@/lib/todos";
import type { Todo } from "@/lib/todos";

// The real Zod schemas stay; only the functions that touch the database are stubbed.
vi.mock("@/lib/todos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/todos")>()),
  listTodos: vi.fn(),
  addTodo: vi.fn(),
  setTodoStatus: vi.fn(),
  moveTodo: vi.fn(),
  deleteTodo: vi.fn(),
}));

const TODAY = "2026-11-09";
const ID_1 = "11111111-1111-4111-8111-111111111111";
const ID_2 = "22222222-2222-4222-8222-222222222222";

const ctx: ToolContext = { supabase: {} as SupabaseClient, today: TODAY };

function todo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: ID_1,
    title: "buy milk",
    status: "open",
    date: TODAY,
    created_at: "2026-11-09T08:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

// Builds a response the way the API would return it. Only the fields the loop reads matter.
function message(
  content: Anthropic.ContentBlock[],
  stop_reason: Anthropic.StopReason,
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Message;
}

const text = (value: string) =>
  ({ type: "text", text: value, citations: null }) as Anthropic.TextBlock;

let toolUseCount = 0;
const toolUse = (name: string, input: unknown) =>
  ({ type: "tool_use", id: `toolu_${++toolUseCount}`, name, input }) as Anthropic.ToolUseBlock;

// A scripted stand-in for the Anthropic client. Each stream() call plays the next step:
// a Message to return, or an Error for finalMessage() to reject with.
function fakeClient(script: Array<Anthropic.Message | Error | (() => Anthropic.Message)>) {
  const requests: Anthropic.MessageStreamParams[] = [];
  const client = {
    messages: {
      stream(params: Anthropic.MessageStreamParams) {
        // A copy, because the loop keeps appending to the same messages array.
        requests.push(structuredClone(params));
        const step = script.shift();
        if (!step) throw new Error("The fake client ran out of scripted responses.");
        const stream = {
          on: () => stream,
          finalMessage: async () => {
            if (step instanceof Error) throw step;
            return typeof step === "function" ? step() : step;
          },
        };
        return stream;
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

function run(client: Anthropic, prompt = "hi") {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const promise = runAgentLoop({ client, model: "test-model", system: "test", messages, ctx });
  return { promise, messages };
}

function toolResults(entry: Anthropic.MessageParam) {
  expect(entry.role).toBe("user");
  return entry.content as Anthropic.ToolResultBlockParam[];
}

beforeEach(() => {
  vi.clearAllMocks();
  toolUseCount = 0;
});

describe("runAgentLoop", () => {
  it("returns a plain answer and saves it unchanged", async () => {
    const content = [
      { type: "thinking", thinking: "short", signature: "sig" } as Anthropic.ThinkingBlock,
      text("Hello!"),
    ];
    const { client, requests } = fakeClient([message(content, "end_turn")]);
    const { promise, messages } = run(client);

    const result = await promise;

    expect(result.status).toBe("done");
    expect(result.usage).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: "assistant", content });
  });

  it("runs one tool and sends its result in the next message", async () => {
    vi.mocked(todos.addTodo).mockResolvedValue(todo());
    const call = toolUse("add_todo", { title: "buy milk" });
    const { client, requests } = fakeClient([
      message([call], "tool_use"),
      message([text("Added.")], "end_turn"),
    ]);
    const { promise, messages } = run(client, "add buy milk");

    const result = await promise;

    expect(result.status).toBe("done");
    expect(todos.addTodo).toHaveBeenCalledWith(ctx.supabase, { title: "buy milk", date: TODAY });

    const [toolResult] = toolResults(messages[2]);
    expect(toolResult.tool_use_id).toBe(call.id);
    expect(toolResult.is_error).toBeUndefined();

    // The API keeps no state, so the second request re-sends the whole history.
    expect(requests[1].messages).toEqual(messages.slice(0, 3));
  });

  it("puts the results of parallel calls in one user message", async () => {
    vi.mocked(todos.setTodoStatus).mockImplementation(async (_s, id, status) =>
      todo({ id, status }),
    );
    const first = toolUse("set_todo_status", { id: ID_1, status: "done" });
    const second = toolUse("set_todo_status", { id: ID_2, status: "done" });
    const { client } = fakeClient([
      message([first, second], "tool_use"),
      message([text("Both closed.")], "end_turn"),
    ]);
    const { promise, messages } = run(client, "close both");

    await promise;

    expect(messages).toHaveLength(4);
    const results = toolResults(messages[2]);
    expect(results.map((r) => r.tool_use_id)).toEqual([first.id, second.id]);
    expect(todos.setTodoStatus).toHaveBeenCalledTimes(2);
  });

  it("sends an invalid input back as an error without running the tool", async () => {
    const call = toolUse("move_todo", { id: "not-a-uuid", date: "2026-02-30" });
    const { client } = fakeClient([
      message([call], "tool_use"),
      message([text("Sorry, let me check.")], "end_turn"),
    ]);
    const { promise, messages } = run(client);

    const result = await promise;

    expect(result.status).toBe("done");
    expect(todos.moveTodo).not.toHaveBeenCalled();
    const [toolResult] = toolResults(messages[2]);
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain("invalid_input");
  });

  it("reports a missing todo as an error", async () => {
    vi.mocked(todos.deleteTodo).mockResolvedValue(false);
    const { client } = fakeClient([
      message([toolUse("delete_todo", { id: ID_1 })], "tool_use"),
      message([text("I couldn't find it.")], "end_turn"),
    ]);
    const { promise, messages } = run(client);

    await promise;

    const [toolResult] = toolResults(messages[2]);
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain("No todo with that id");
  });

  it("stops on a refusal without running tools or saving the turn", async () => {
    const { client } = fakeClient([
      message([toolUse("delete_todo", { id: ID_1 })], "refusal"),
    ]);
    const { promise, messages } = run(client);

    const result = await promise;

    expect(result.status).toBe("refused");
    expect(todos.deleteTodo).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
  });

  it("stops on max_tokens without running a possibly cut-off tool call", async () => {
    const { client } = fakeClient([
      message([toolUse("add_todo", { title: "buy" })], "max_tokens"),
    ]);
    const { promise, messages } = run(client);

    const result = await promise;

    expect(result.status).toBe("truncated");
    expect(todos.addTodo).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
  });

  it("stops at the iteration limit", async () => {
    vi.mocked(todos.listTodos).mockResolvedValue([]);
    const script = Array.from(
      { length: MAX_ITERATIONS + 1 },
      () => () => message([toolUse("list_todos", {})], "tool_use"),
    );
    const { client, requests } = fakeClient(script);
    const { promise, messages } = run(client);

    const result = await promise;

    expect(result.status).toBe("iteration_limit");
    expect(requests).toHaveLength(MAX_ITERATIONS);
    // Every tool_use still got its tool_result, so the history stays valid.
    expect(messages.at(-1)?.role).toBe("user");
  });

  it("retries a stream that fails on malformed tool input JSON", async () => {
    const { client, requests } = fakeClient([
      new Error("Unexpected token in JSON"),
      message([text("Done.")], "end_turn"),
    ]);
    const { promise } = run(client);

    const result = await promise;

    expect(result.status).toBe("done");
    expect(requests).toHaveLength(2);
  });

  it("checkpoints after each tool round and after the final answer", async () => {
    vi.mocked(todos.addTodo).mockResolvedValue(todo());
    const { client } = fakeClient([
      message([toolUse("add_todo", { title: "buy milk" })], "tool_use"),
      message([text("Added.")], "end_turn"),
    ]);
    const saved: Anthropic.MessageParam[][] = [];
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "add milk" }];

    await runAgentLoop({
      client,
      model: "test-model",
      system: "test",
      messages,
      ctx,
      onCheckpoint: async (history) => {
        saved.push(structuredClone(history));
      },
    });

    expect(saved).toHaveLength(2);
    // First save ends with the tool results, so every tool_use already has its answer.
    expect(saved[0]).toHaveLength(3);
    expect(saved[0].at(-1)?.role).toBe("user");
    // Second save is the whole thread, ending with the answer.
    expect(saved[1]).toEqual(messages);
    expect(saved[1].at(-1)?.role).toBe("assistant");
  });

  it("doesn't checkpoint a refused turn", async () => {
    const { client } = fakeClient([message([text("No.")], "refusal")]);
    const onCheckpoint = vi.fn(async () => {});
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "hi" }];

    await runAgentLoop({ client, model: "test-model", system: "test", messages, ctx, onCheckpoint });

    expect(onCheckpoint).not.toHaveBeenCalled();
  });

  it("throws API errors to the caller instead of retrying", async () => {
    const apiError = new Anthropic.InternalServerError(500, undefined, "boom", new Headers());
    const { client, requests } = fakeClient([apiError]);
    const { promise } = run(client);

    await expect(promise).rejects.toBe(apiError);
    expect(requests).toHaveLength(1);
  });
});
