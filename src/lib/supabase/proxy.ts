import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const AUTH_PAGES = ["/login", "/signup"];

// Refreshes the session cookie on every request and redirects page loads.
// This is only an optimistic check: route handlers, Server Actions and pages verify again.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          // Write to the request too, so the page or route handler sees the refreshed session.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          Object.entries(headers).forEach(([key, value]) =>
            response.headers.set(key, value),
          );
        },
      },
    },
  );

  // Keep this straight after creating the client. It triggers the token refresh,
  // and removing it or running code before it can log users out at random.
  const { data } = await supabase.auth.getClaims();
  const isLoggedIn = Boolean(data?.claims);

  const { pathname } = request.nextUrl;
  const isApi = pathname === "/api" || pathname.startsWith("/api/");
  const isPageLoad = request.method === "GET" || request.method === "HEAD";

  // API routes answer 401 themselves. Other methods pass through so a Server Action
  // posted from a stale tab reaches its own check instead of being redirected mid-POST.
  if (isApi || !isPageLoad) return response;

  const isAuthPage = AUTH_PAGES.includes(pathname);
  if (!isLoggedIn && !isAuthPage) return redirectTo("/login", request, response);
  if (isLoggedIn && isAuthPage) return redirectTo("/", request, response);

  return response;
}

function redirectTo(
  pathname: string,
  request: NextRequest,
  response: NextResponse,
) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";

  const redirect = NextResponse.redirect(url);
  // Carry over any refreshed or cleared session cookies, or the browser loses them.
  response.cookies
    .getAll()
    .forEach((cookie) => redirect.cookies.set(cookie));
  redirect.headers.set("Cache-Control", "private, no-store");
  return redirect;
}
