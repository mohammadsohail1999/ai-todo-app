import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Per-request client that acts as the logged-in user, so Row Level Security applies.
// Create a new one for each request; never share it between requests.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Components can't set cookies. proxy.ts refreshes sessions (Phase 2).
          }
        },
      },
    },
  );
}
