import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// The key boundary: the UI routes and the agent tools both call these functions.
// Each takes the logged-in user's client and no user id, so Row Level Security scopes
// every query. A todo that belongs to someone else looks the same as one that doesn't exist.

export const todoId = z.uuid();
export const todoTitle = z.string().trim().min(1).max(200);
export const todoStatus = z.enum(["open", "done"]);

export type TodoStatus = z.infer<typeof todoStatus>;

export type Todo = {
  id: string;
  title: string;
  status: TodoStatus;
  date: string;
  created_at: string;
  completed_at: string | null;
};

const TODO_COLUMNS = "id, title, status, date, created_at, completed_at";

// One date, optionally limited to one status.
export type TodoFilter = { date: string; status?: TodoStatus };

export async function listTodos(
  supabase: SupabaseClient,
  filter: TodoFilter,
): Promise<Todo[]> {
  let query = supabase.from("todos").select(TODO_COLUMNS).eq("date", filter.date);
  if (filter.status) query = query.eq("status", filter.status);

  const { data, error } = await query.order("date").order("created_at");

  if (error) throw error;
  return data as Todo[];
}

export async function addTodo(
  supabase: SupabaseClient,
  { title, date }: { title: string; date: string },
): Promise<Todo> {
  // user_id is left to the column's default, auth.uid().
  const { data, error } = await supabase
    .from("todos")
    .insert({ title, date })
    .select(TODO_COLUMNS)
    .single();

  if (error) throw error;
  return data as Todo;
}

// Returns null when no todo matched.
export async function setTodoStatus(
  supabase: SupabaseClient,
  id: string,
  status: TodoStatus,
): Promise<Todo | null> {
  const { data, error } = await supabase
    .from("todos")
    .update({
      status,
      completed_at: status === "done" ? new Date().toISOString() : null,
    })
    .eq("id", id)
    .select(TODO_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  return data as Todo | null;
}

// Returns false when no todo matched.
export async function deleteTodo(
  supabase: SupabaseClient,
  id: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("todos")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data !== null;
}
