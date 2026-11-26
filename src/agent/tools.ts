import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Decision, PendingTurn } from "@/agent/pending";
import {
  addTodo,
  deleteTodo,
  getTodosByIds,
  isoDate,
  listTodos,
  moveTodo,
  setTodoStatus,
  todoId,
  todoStatus,
  todoTitle,
  type Todo,
} from "@/lib/todos";

// What every tool runs with. The client is the logged-in user's, so Row Level Security
// scopes every query. There is deliberately no user id here or in any tool input.
export type ToolContext = {
  supabase: SupabaseClient;
  today: string;
};

// Deletes never run straight away: the loop holds them until the user confirms.
export const DELETE_TOOL = "delete_todo";

// Every tool sets eager_input_streaming, so the API doesn't validate inputs for us.
// The Zod schemas below are the real check, and run before any tool does.
export const tools: Anthropic.Tool[] = [
  {
    name: "list_todos",
    description:
      "List the user's todos. Call this before answering any question about what is on their list, " +
      "how many todos are done or open, or what they had on another day, and before changing a todo " +
      "you haven't seen yet. Give `date` for one day, or `from` and `to` for an inclusive range. " +
      "With no dates it lists today. Returns the todos and their counts.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "One day, as YYYY-MM-DD." },
        from: { type: "string", description: "First day of a range, as YYYY-MM-DD." },
        to: { type: "string", description: "Last day of a range, as YYYY-MM-DD." },
        status: {
          type: "string",
          enum: ["open", "done"],
          description: "Only todos with this status. Leave out for both.",
        },
      },
    },
  },
  {
    name: "add_todo",
    description:
      "Add one todo for the user. Call it once per todo when they ask you to add, remember or plan " +
      "something. Leave out `date` for today; give it as YYYY-MM-DD for another day.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, at most 200 characters." },
        date: { type: "string", description: "The day it's for, as YYYY-MM-DD." },
      },
      required: ["title"],
    },
  },
  {
    name: "set_todo_status",
    description:
      "Mark one todo as done, or open it again. Call it when the user finishes, closes, ticks off or " +
      "reopens something, once per todo; for several todos, make all the calls in the same turn. " +
      "It needs the todo's `id`, so call list_todos first if you haven't seen the todo yet.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The todo's id, from list_todos." },
        status: {
          type: "string",
          enum: ["open", "done"],
          description: "`done` to close it, `open` to reopen it.",
        },
      },
      required: ["id", "status"],
    },
  },
  {
    name: "move_todo",
    description:
      "Move one todo to another day, keeping its status. Call it when the user wants to reschedule, " +
      "postpone or carry todos over, for example unfinished todos from yesterday to today. Call it " +
      "once per todo; for several todos, make all the calls in the same turn. It needs the todo's " +
      "`id`, so call list_todos first if you haven't seen the todo yet.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The todo's id, from list_todos." },
        date: { type: "string", description: "The day to move it to, as YYYY-MM-DD." },
      },
      required: ["id", "date"],
    },
  },
  {
    name: DELETE_TOOL,
    description:
      "Permanently delete one todo. Only call it when the user clearly asks to delete or remove a " +
      "todo; to close a finished todo, use set_todo_status instead. Call it once per todo; for " +
      "several todos, make all the calls in the same turn. The app then shows the user one " +
      "Confirm/Cancel card for all of them, and the result tells you what they chose. It needs " +
      "the todo's `id`, so call list_todos first if you haven't seen the todo yet.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The todo's id, from list_todos." },
      },
      required: ["id"],
    },
  },
];

const MAX_RANGE_DAYS = 366;

const listTodosInput = z
  .object({
    date: isoDate.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    status: todoStatus.optional(),
  })
  .refine((input) => !(input.date && (input.from || input.to)), {
    message: "Give either `date` or `from` and `to`, not both.",
  })
  .refine((input) => Boolean(input.from) === Boolean(input.to), {
    message: "A range needs both `from` and `to`.",
  })
  .refine((input) => !input.from || !input.to || input.from <= input.to, {
    message: "`from` must not be after `to`.",
  })
  .refine(
    (input) =>
      !input.from || !input.to || daysBetween(input.from, input.to) < MAX_RANGE_DAYS,
    { message: `A range can be at most ${MAX_RANGE_DAYS} days.` },
  );

const addTodoInput = z.object({
  title: todoTitle,
  date: isoDate.optional(),
});

const setTodoStatusInput = z.object({ id: todoId, status: todoStatus });

const moveTodoInput = z.object({ id: todoId, date: isoDate });

const deleteTodoInput = z.object({ id: todoId });

// Row Level Security makes another user's todo look exactly like a missing one.
const NOT_FOUND = "No todo with that id. Call list_todos to find it.";

function daysBetween(from: string, to: string) {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

function countTodos(todos: Todo[]) {
  const done = todos.filter((todo) => todo.status === "done").length;
  return { open: todos.length - done, done, total: todos.length };
}

// Runs one tool_use block and always returns its tool_result, so every call gets an answer.
export async function runTool(
  block: Anthropic.ToolUseBlock,
  ctx: ToolContext,
): Promise<Anthropic.ToolResultBlockParam> {
  const result = (content: unknown, isError = false) => ({
    type: "tool_result" as const,
    tool_use_id: block.id,
    content: typeof content === "string" ? content : JSON.stringify(content),
    ...(isError && { is_error: true }),
  });

  try {
    switch (block.name) {
      case "list_todos": {
        const input = listTodosInput.safeParse(block.input);
        if (!input.success) return result(invalidInput(block, input.error), true);

        const { date, from, to, status } = input.data;
        const todos = await listTodos(
          ctx.supabase,
          from && to ? { from, to, status } : { date: date ?? ctx.today, status },
        );
        return result({ todos, counts: countTodos(todos) });
      }

      case "add_todo": {
        const input = addTodoInput.safeParse(block.input);
        if (!input.success) return result(invalidInput(block, input.error), true);

        const todo = await addTodo(ctx.supabase, {
          title: input.data.title,
          date: input.data.date ?? ctx.today,
        });
        return result({ todo });
      }

      case "set_todo_status": {
        const input = setTodoStatusInput.safeParse(block.input);
        if (!input.success) return result(invalidInput(block, input.error), true);

        const todo = await setTodoStatus(ctx.supabase, input.data.id, input.data.status);
        if (!todo) return result(NOT_FOUND, true);
        return result({ todo });
      }

      case "move_todo": {
        const input = moveTodoInput.safeParse(block.input);
        if (!input.success) return result(invalidInput(block, input.error), true);

        const todo = await moveTodo(ctx.supabase, input.data.id, input.data.date);
        if (!todo) return result(NOT_FOUND, true);
        return result({ todo });
      }

      // The loop sends deletes to holdDeletes instead. This guard keeps any other caller
      // from deleting without the user's Confirm.
      case DELETE_TOOL:
        return result("delete_todo only runs after the user confirms.", true);

      default:
        return result(`Unknown tool: ${block.name}`, true);
    }
  } catch (error) {
    // The database error stays in the server log; Claude only needs to know the call failed.
    console.error(`Tool ${block.name} failed:`, error);
    return result("The tool failed. Tell the user it didn't work.", true);
  }
}

// Splits a turn's delete calls into ones to hold for the user's decision and ones that fail now.
// An invalid input or an id the user can't see gets its error result at once, so the card
// only ever lists todos that exist.
export async function holdDeletes(
  blocks: Anthropic.ToolUseBlock[],
  ctx: ToolContext,
): Promise<{ held: PendingTurn["deletes"]; results: Anthropic.ToolResultBlockParam[] }> {
  const held: PendingTurn["deletes"] = [];
  const results: Anthropic.ToolResultBlockParam[] = [];
  const valid: { block: Anthropic.ToolUseBlock; todoId: string }[] = [];

  for (const block of blocks) {
    const input = deleteTodoInput.safeParse(block.input);
    if (input.success) {
      valid.push({ block, todoId: input.data.id });
    } else {
      results.push(errorResult(block.id, invalidInput(block, input.error)));
    }
  }

  let found: Set<string>;
  try {
    const todos = await getTodosByIds(ctx.supabase, valid.map((v) => v.todoId));
    found = new Set(todos.map((todo) => todo.id));
  } catch (error) {
    console.error(`Tool ${DELETE_TOOL} failed:`, error);
    for (const { block } of valid) {
      results.push(errorResult(block.id, "The tool failed. Tell the user it didn't work."));
    }
    return { held, results };
  }

  for (const { block, todoId } of valid) {
    if (found.has(todoId)) {
      held.push({ toolUseId: block.id, todoId });
    } else {
      results.push(errorResult(block.id, NOT_FOUND));
    }
  }

  return { held, results };
}

const CANCELLED = "The user cancelled this deletion. The todo was not deleted.";

// Settles a paused turn: deletes on confirm, records the refusal on cancel, and returns the one
// user message holding a tool_result for every tool_use in the paused assistant message.
export async function resolvePending(
  pending: PendingTurn,
  decision: Decision,
  assistantContent: Anthropic.MessageParam["content"],
  ctx: ToolContext,
): Promise<Anthropic.MessageParam> {
  const deleteResults = await Promise.all(
    pending.deletes.map(async ({ toolUseId, todoId }) => {
      if (decision === "cancel") {
        return { type: "tool_result" as const, tool_use_id: toolUseId, content: CANCELLED };
      }
      try {
        const deleted = await deleteTodo(ctx.supabase, todoId);
        if (!deleted) return errorResult(toolUseId, NOT_FOUND);
        return {
          type: "tool_result" as const,
          tool_use_id: toolUseId,
          content: JSON.stringify({ deleted: true, id: todoId }),
        };
      } catch (error) {
        console.error(`Tool ${DELETE_TOOL} failed:`, error);
        return errorResult(toolUseId, "The tool failed. Tell the user it didn't work.");
      }
    }),
  );

  // Results keep the order of the calls, so the message reads like an unpaused turn.
  const byId = new Map(
    [...pending.results, ...deleteResults].map((result) => [result.tool_use_id, result]),
  );
  const order =
    typeof assistantContent === "string"
      ? []
      : assistantContent.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
  const content = order.flatMap((id) => {
    const result = byId.get(id);
    return result ? [result] : [];
  });

  return { role: "user", content };
}

function errorResult(toolUseId: string, content: unknown): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: typeof content === "string" ? content : JSON.stringify(content),
    is_error: true,
  };
}

// Sends back what was received and why it was rejected, so Claude can correct the call.
function invalidInput(block: Anthropic.ToolUseBlock, error: z.ZodError) {
  return { invalid_input: block.input, problems: z.prettifyError(error) };
}
