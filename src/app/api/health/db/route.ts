import { connection } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Phase 1 test route: proves the app can reach Supabase and the todos table exists.
// It uses the secret-key client because there are no logins yet. Phase 2 replaces it
// with a session check, so the read runs as the logged-in user under Row Level Security.
export async function GET() {
  // Run at request time only. Without this, `next build` runs the query and can freeze the response.
  await connection();

  try {
    const { error } = await createAdminClient()
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
