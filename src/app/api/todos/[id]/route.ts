import type { NextRequest } from "next/server";
import { z } from "zod";
import { getVerifiedUser } from "@/lib/auth";
import { deleteTodo, setTodoStatus, todoId, todoStatus } from "@/lib/todos";

const statusUpdate = z.object({ status: todoStatus });

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/todos/[id]">,
) {
  try {
    const user = await getVerifiedUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const id = todoId.safeParse((await ctx.params).id);
    if (!id.success) {
      return Response.json({ error: "Invalid id" }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    const parsed = statusUpdate.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid status" }, { status: 400 });
    }

    const todo = await setTodoStatus(user.supabase, id.data, parsed.data.status);
    if (!todo) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return Response.json({ todo });
  } catch (error) {
    console.error("Updating a todo failed:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext<"/api/todos/[id]">,
) {
  try {
    const user = await getVerifiedUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const id = todoId.safeParse((await ctx.params).id);
    if (!id.success) {
      return Response.json({ error: "Invalid id" }, { status: 400 });
    }

    const deleted = await deleteTodo(user.supabase, id.data);
    if (!deleted) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Deleting a todo failed:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}
