import type Anthropic from "@anthropic-ai/sdk";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingTurn } from "@/agent/pending";

// The route's own logic is under test. The session, the database and the model are stubbed.
vi.mock("@/lib/auth", () => ({ getVerifiedUser: vi.fn() }));
vi.mock("@/lib/conversations", () => ({ claimPending: vi.fn(), saveConversation: vi.fn() }));
vi.mock("@/agent/chat-stream", () => ({
  anthropicConfig: () => ({ apiKey: "test-key", model: "test-model" }),
  streamAgentTurn: vi.fn(() => new Response("stream")),
}));
vi.mock("@/lib/todos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/todos")>()),
  deleteTodo: vi.fn(),
}));

const { POST } = await import("@/app/api/chat/confirm/route");
const { getVerifiedUser } = await import("@/lib/auth");
const { claimPending, saveConversation } = await import("@/lib/conversations");
const { streamAgentTurn } = await import("@/agent/chat-stream");
const { deleteTodo } = await import("@/lib/todos");

const TODO_ID = "11111111-1111-4111-8111-111111111111";
const user = { userId: "user-1", supabase: {}, email: "test@example.com" };

const assistant: Anthropic.MessageParam = {
  role: "assistant",
  content: [{ type: "tool_use", id: "toolu_1", name: "delete_todo", input: { id: TODO_ID } }],
};
const pending: PendingTurn = {
  deletes: [{ toolUseId: "toolu_1", todoId: TODO_ID }],
  results: [],
};

function request(body: unknown) {
  return new Request("http://localhost/api/chat/confirm", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVerifiedUser).mockResolvedValue(user as never);
  vi.mocked(saveConversation).mockResolvedValue(3);
  vi.mocked(deleteTodo).mockResolvedValue(true);
});

describe("POST /api/chat/confirm", () => {
  it("rejects a request without a session", async () => {
    vi.mocked(getVerifiedUser).mockResolvedValue(null);

    const response = await POST(request({ decision: "confirm", timeZone: "UTC" }));

    expect(response.status).toBe(401);
    expect(claimPending).not.toHaveBeenCalled();
  });

  it("deletes once when Confirm is sent twice", async () => {
    // The database lets only the first claim through; the second finds pending cleared.
    vi.mocked(claimPending)
      .mockResolvedValueOnce({
        messages: [{ role: "user", content: "delete it" }, assistant],
        pending,
        version: 2,
      })
      .mockResolvedValueOnce(null);

    const [first, second] = await Promise.all([
      POST(request({ decision: "confirm", timeZone: "UTC" })),
      POST(request({ decision: "confirm", timeZone: "UTC" })),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(deleteTodo).toHaveBeenCalledTimes(1);
    expect(streamAgentTurn).toHaveBeenCalledTimes(1);
  });

  it("saves the results before resuming, so the thread is valid if the next turn fails", async () => {
    vi.mocked(claimPending).mockResolvedValue({
      messages: [{ role: "user", content: "delete it" }, assistant],
      pending,
      version: 2,
    });

    await POST(request({ decision: "cancel", timeZone: "UTC" }));

    expect(deleteTodo).not.toHaveBeenCalled();
    const [, , saved, version] = vi.mocked(saveConversation).mock.calls[0];
    expect(version).toBe(2);
    expect(saved.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "The user cancelled this deletion. The todo was not deleted.",
        },
      ],
    });
    expect(vi.mocked(streamAgentTurn).mock.calls[0][0]).toMatchObject({ version: 3 });
  });

  it("rejects an unknown decision", async () => {
    const response = await POST(request({ decision: "maybe", timeZone: "UTC" }));

    expect(response.status).toBe(400);
    expect(claimPending).not.toHaveBeenCalled();
  });
});
