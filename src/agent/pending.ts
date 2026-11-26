import type Anthropic from "@anthropic-ai/sdk";

// Shared by the server and the chat panel, so it must not import anything server-only.

// A turn paused for the user's decision. It's saved with the assistant message that asked
// for the deletes, because every tool_use in that message needs its tool_result next.
export type PendingTurn = {
  // The deletes awaiting one Confirm or Cancel. Only ids: titles are read from the
  // database whenever the card is shown, never taken from the model's wording.
  deletes: { toolUseId: string; todoId: string }[];
  // Finished results of the other calls in the same turn, held until the decision.
  results: Anthropic.ToolResultBlockParam[];
};

export type Decision = "confirm" | "cancel";

// One line of the confirmation card.
export type PendingTodo = { id: string; title: string; date: string };
