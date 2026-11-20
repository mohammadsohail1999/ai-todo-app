import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { getVerifiedUser } from "@/lib/auth";
import { isValidTimeZone, todayInTimeZone } from "@/lib/today";
import { addTodo, listTodos, todoTitle } from "@/lib/todos";

const timeZone = z.string().refine(isValidTimeZone);
const newTodo = z.object({ title: todoTitle, timeZone });

// Today's todos. The browser sends its timezone and the server works out the date.
export async function GET(request: NextRequest) {
  // Run at request time only. Without this, `next build` runs the query and can freeze the response.
  await connection();

  try {
    const user = await getVerifiedUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = timeZone.safeParse(
      request.nextUrl.searchParams.get("timeZone"),
    );
    if (!parsed.success) {
      return Response.json({ error: "Invalid timeZone" }, { status: 400 });
    }

    const date = todayInTimeZone(parsed.data);
    const todos = await listTodos(user.supabase, { date });

    return Response.json({ date, todos });
  } catch (error) {
    console.error("Listing todos failed:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getVerifiedUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const parsed = newTodo.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid todo" }, { status: 400 });
    }

    const todo = await addTodo(user.supabase, {
      title: parsed.data.title,
      date: todayInTimeZone(parsed.data.timeZone),
    });

    return Response.json({ todo }, { status: 201 });
  } catch (error) {
    console.error("Adding a todo failed:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}
