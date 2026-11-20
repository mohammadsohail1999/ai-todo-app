import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { logout } from "@/app/actions/auth";
import { TodayTodos } from "@/components/today-todos";
import { getVerifiedUser } from "@/lib/auth";

export default function Home() {
  return (
    <main className="home">
      <h1>AI Todo App</h1>
      {/* Cache Components: reading the session happens at request time, so it needs a boundary. */}
      <Suspense fallback={<p>Loading...</p>}>
        <Today />
      </Suspense>
    </main>
  );
}

async function Today() {
  // Run at request time only: getClaims() reads the clock, which isn't allowed while prerendering.
  await connection();

  const user = await getVerifiedUser();
  if (!user) redirect("/login");

  return (
    <>
      <div className="home-account">
        <p>Logged in as {user.email}</p>
        <form action={logout}>
          <button type="submit">Log out</button>
        </form>
      </div>
      <TodayTodos />
    </>
  );
}
