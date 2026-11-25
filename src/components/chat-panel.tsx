"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import type { ChatEvent, ChatItem } from "@/agent/events";
import type { LoopStatus } from "@/agent/loop";

const MAX_MESSAGE_LENGTH = 500;

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const TOOL_LABELS: Record<string, string> = {
  list_todos: "Checking your list",
  add_todo: "Adding a todo",
  set_todo_status: "Updating a todo",
  move_todo: "Moving a todo",
  delete_todo: "Deleting a todo",
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

export function ChatPanel({ onTodosChanged }: { onTodosChanged: () => void }) {
  const router = useRouter();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Load today's saved thread, so the chat survives a refresh.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/chat?timeZone=${encodeURIComponent(browserTimeZone())}`)
      .then(async (response) => {
        if (response.status === 401) return router.push("/login");
        if (!response.ok) throw new Error("Request failed");
        const data = (await response.json()) as { items: ChatItem[] };
        if (!cancelled) setItems(data.items);
      })
      .catch(() => {
        if (!cancelled) setNotice("Couldn't load the chat.");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [items]);

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
      case "done":
        setNotice(STATUS_NOTICES[event.status] ?? null);
        break;
      case "error":
        setNotice(event.message);
        break;
    }
  }

  async function send(event: SubmitEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || streaming) return;

    setStreaming(true);
    setNotice(null);
    setInput("");
    setItems((current) => [...current, { role: "user", text: message }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, timeZone: browserTimeZone() }),
      });
      if (response.status === 401) {
        router.push("/login");
        return;
      }
      if (!response.ok || !response.body) throw new Error("Request failed");

      for await (const chatEvent of readEvents(response.body)) handle(chatEvent);
    } catch {
      setNotice("Couldn't reach the assistant. Try again.");
    } finally {
      setStreaming(false);
    }
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
          disabled={streaming}
        />
        <button type="submit" disabled={streaming || !input.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
