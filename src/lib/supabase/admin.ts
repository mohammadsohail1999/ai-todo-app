import "server-only";
import { createClient } from "@supabase/supabase-js";

// Bypasses Row Level Security. Only for tables with no client access (conversations),
// always filtering by the user_id from verified claims.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
