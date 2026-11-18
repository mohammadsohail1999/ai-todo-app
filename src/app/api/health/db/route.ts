import { connection } from "next/server";
import { getVerifiedUser } from "@/lib/auth";

// Test route: proves a logged-in user's session reaches Supabase, under Row Level Security.
export async function GET() {
  // Run at request time only. Without this, `next build` runs the query and can freeze the response.
  await connection();

  try {
    const user = await getVerifiedUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { error } = await user.supabase
      .from("todos")
      .select("id", { head: true, count: "exact" });

    if (error) throw error;

    // checkedAt shows the response is fresh, not a cached copy.
    return Response.json({ ok: true, checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Supabase read failed:", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
