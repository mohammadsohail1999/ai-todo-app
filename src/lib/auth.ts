import { createClient } from "@/lib/supabase/server";

// Verifies the session for this request. Returns null when there's no valid session.
// Route handlers, Server Actions and pages all call this, because proxy.ts is only an optimistic check.
export async function getVerifiedUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data?.claims) return null;

  return {
    supabase,
    userId: data.claims.sub,
    email: data.claims.email,
  };
}
