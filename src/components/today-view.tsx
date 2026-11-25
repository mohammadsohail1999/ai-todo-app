"use client";

import { useCallback, useState } from "react";
import { ChatPanel } from "@/components/chat-panel";
import { TodayTodos } from "@/components/today-todos";

// Connects the chat to the list: each todos_changed event bumps the counter, and the list reloads.
export function TodayView() {
  const [refresh, setRefresh] = useState(0);
  const onTodosChanged = useCallback(() => setRefresh((n) => n + 1), []);

  return (
    <div className="today-view">
      <TodayTodos refreshSignal={refresh} />
      <ChatPanel onTodosChanged={onTodosChanged} />
    </div>
  );
}
