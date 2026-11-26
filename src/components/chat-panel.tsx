"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type SubmitEvent } from "react";
import type { ChatEvent, ChatItem } from "@/agent/events";
import type { LoopStatus } from "@/agent/loop";
import type { Decision, PendingTodo } from "@/agent/pending";

const MAX_MESSAGE_LENGTH = 500;

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const TOOL_LABELS: Record<string, string> = {
  list_todos: "Checking your list",
  add_todo: "Adding a todo",
  set_todo_status: "Updating a todo",
  move_todo: "Moving a todo",
  delete_todo: "Asking to delete a todo",
};

// Shown when a turn ends without a normal answer.
const STATUS_NOTICES: Partial<Record<LoopStatus, string>> = {
  refused: "Claude declined to answer that.",
  truncated: "The reply was cut off. Try a shorter request.",
  iteration_limit: "Stopped after too many steps. Try a simpler request.",
};

// Splits a streamed response body into JSON lines, as they arrive.
async function* readEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // A chunk can end mid-line, so keep the unfinished part for the next chunk.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      yield JSON.parse(line) as ChatEvent;
    }
  }
  if (buffer.trim()) {
    yield JSON.parse(buffer) as ChatEvent;
  }
}

type ChatState = { items: ChatItem[]; pending: PendingTodo[] | null };

async function fetchChat(): Promise<ChatState | "unauthorized"> {
  const response = await fetch(`/api/chat?timeZone=${encodeURIComponent(browserTimeZone())}`);
  if (response.status === 401) return "unauthorized";
  if (!response.ok) throw new Error("Request failed");
  return (await response.json()) as ChatState;
}

export function ChatPanel({ onTodosChanged }: { onTodosChanged: () => void }) {
  const router = useRouter();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Todos waiting for Confirm or Cancel. While set, no new message can be sent.
  const [pending, setPending] = useState<PendingTodo[] | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // Set at once, unlike `streaming`, so a fast double click can't send two requests.
  const busy = useRef(false);

  // Loads today's saved thread and any paused delete, so both survive a refresh.
  const load = useCallback(
    (isCancelled: () => boolean = () => false) =>
      fetchChat()
        .then((data) => {
          if (data === "unauthorized") return router.push("/login");
          if (isCancelled()) return;
          setItems(data.items);
          setPending(data.pending);
        })
        .catch(() => {
          if (!isCancelled()) setNotice("Couldn't load the chat.");
        }),
    [router],
  );

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [items, pending]);

  // Text joins the assistant bubble that's still growing; after a tool line, a new one starts.
  function addText(delta: string) {
    setItems((current) => {
      const last = current.at(-1);
      if (last?.role === "assistant") {
        return [...current.slice(0, -1), { role: "assistant", text: last.text + delta }];
      }
      return [...current, { role: "assistant", text: delta }];
    });
  }

  function handle(event: ChatEvent) {
    switch (event.type) {
      case "text":
        addText(event.delta);
        break;
      case "tool_start":
        setItems((current) => [...current, { role: "tool", name: event.name }]);
        break;
      case "todos_changed":
        onTodosChanged();
        break;
      case "confirm_required":
        setPending(event.todos);
        break;
      case "done":
        setNotice(STATUS_NOTICES[event.status] ?? null);
        break;
      case "error":
        setNotice(event.message);
        break;
    }
  }

  // Posts to a chat route and plays its stream. A 409 means the server's state moved on
  // (a delete is pending, or was already settled elsewhere), so reload it.
  async function stream(url: string, body: object) {
    if (busy.current) return;
    busy.current = true;
    setStreaming(true);
    setNotice(null);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, timeZone: browserTimeZone() }),
      });
      if (response.status === 401) {
        router.push("/login");
        return;
      }
      if (response.status === 409) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        await load();
        setNotice(data?.error ?? "The chat changed. It has been reloaded.");
        return;
      }
      if (!response.ok || !response.body) throw new Error("Request failed");

      for await (const chatEvent of readEvents(response.body)) handle(chatEvent);
    } catch {
      // Show what the server saved, so a lost card or half-shown reply doesn't linger.
      await load();
      setNotice("Couldn't reach the assistant. Try again.");
    } finally {
      busy.current = false;
      setStreaming(false);
    }
  }

  async function send(event: SubmitEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || streaming || pending) return;

    setInput("");
    setItems((current) => [...current, { role: "user", text: message }]);
    await stream("/api/chat", { message });
  }

  async function decide(decision: Decision) {
    if (busy.current || !pending) return;
    setPending(null);
    await stream("/api/chat/confirm", { decision });
  }

  return (
    <section className="chat" aria-label="Assistant">
      <h2>Assistant</h2>

      <div className="chat-log" aria-live="polite">
        {items.length === 0 && (
          <p className="chat-empty">Ask me to add, close, move or find todos.</p>
        )}
        {items.map((item, index) =>
          item.role === "tool" ? (
            <p key={index} className="chat-tool">
              {TOOL_LABELS[item.name] ?? item.name}
            </p>
          ) : (
            <p key={index} className={`chat-bubble chat-${item.role}`}>
              {item.text}
            </p>
          ),
        )}
        {pending && (
          <div className="confirm-card" role="group" aria-label="Confirm deletion">
            <p>
              Delete {pending.length === 1 ? "this todo" : `these ${pending.length} todos`}?
              This can&apos;t be undone.
            </p>
            {pending.length > 0 ? (
              <ul>
                {pending.map((todo) => (
                  <li key={todo.id}>
                    {todo.title} <span className="confirm-date">{todo.date}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="confirm-date">These todos no longer exist.</p>
            )}
            <div className="confirm-actions">
              <button type="button" onClick={() => decide("confirm")} disabled={streaming}>
                Delete
              </button>
              <button
                type="button"
                onClick={() => decide("cancel")}
                disabled={streaming}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {streaming && items.at(-1)?.role !== "assistant" && (
          <p className="chat-tool">Thinking…</p>
        )}
        <div ref={endRef} />
      </div>

      {notice && (
        <p role="alert" className="auth-error">
          {notice}
        </p>
      )}

      <form onSubmit={send} className="chat-form">
        <input
          aria-label="Message the assistant"
          placeholder="e.g. move yesterday's unfinished todos to today"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={streaming || pending !== null}
        />
        <button type="submit" disabled={streaming || pending !== null || !input.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
