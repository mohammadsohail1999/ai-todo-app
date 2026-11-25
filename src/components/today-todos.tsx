"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type SubmitEvent } from "react";
import type { Todo, TodoStatus } from "@/lib/todos";

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// Returns null when the session has ended.
async function fetchToday() {
  const response = await fetch(
    `/api/todos?timeZone=${encodeURIComponent(browserTimeZone())}`,
  );
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Request failed");

  return (await response.json()) as { date: string; todos: Todo[] };
}

// refreshSignal: bump it to make the list reload, e.g. when the assistant changes a todo.
export function TodayTodos({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const router = useRouter();
  const [date, setDate] = useState<string | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetchToday().then((today) => {
        if (!today) {
          router.push("/login");
          return;
        }
        setDate(today.date);
        setTodos(today.todos);
      }),
    [router],
  );

  const reload = useCallback(
    () => load().catch(() => setError("Couldn't load your todos.")),
    [load],
  );

  // Reloading when the tab comes back also moves a tab left open past midnight to the new day.
  useEffect(() => {
    reload();

    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  // 0 is the first render, which the effect above already loads.
  useEffect(() => {
    if (refreshSignal > 0) reload();
  }, [refreshSignal, reload]);

  // Runs one change, then reloads from the server instead of patching local state.
  async function change(request: () => Promise<Response>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await request();
      if (response.status === 401) {
        router.push("/login");
        return false;
      }
      if (!response.ok) throw new Error("Request failed");
      await load();
      return true;
    } catch {
      setError(failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addTodo(event: SubmitEvent) {
    event.preventDefault();
    const added = await change(
      () =>
        fetch("/api/todos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, timeZone: browserTimeZone() }),
        }),
      "Couldn't add that todo.",
    );
    if (added) setTitle("");
  }

  function setStatus(todo: Todo, status: TodoStatus) {
    return change(
      () =>
        fetch(`/api/todos/${todo.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }),
      "Couldn't update that todo.",
    );
  }

  function deleteTodo(todo: Todo) {
    return change(
      () => fetch(`/api/todos/${todo.id}`, { method: "DELETE" }),
      "Couldn't delete that todo.",
    );
  }

  return (
    <section className="todos">
      <h2>Today{date && <time dateTime={date}> {date}</time>}</h2>

      <form onSubmit={addTodo} className="todos-add">
        <input
          aria-label="New todo"
          placeholder="Add a todo"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          required
        />
        <button type="submit" disabled={busy || !title.trim()}>
          Add
        </button>
      </form>

      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}

      {date && todos.length === 0 && !error && <p>Nothing for today yet.</p>}

      <ul className="todos-list">
        {todos.map((todo) => (
          <li key={todo.id} className={todo.status}>
            <label>
              <input
                type="checkbox"
                checked={todo.status === "done"}
                disabled={busy}
                onChange={(event) =>
                  setStatus(todo, event.target.checked ? "done" : "open")
                }
              />
              <span>{todo.title}</span>
            </label>
            <button
              type="button"
              disabled={busy}
              aria-label={`Delete ${todo.title}`}
              onClick={() => deleteTodo(todo)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
