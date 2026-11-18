export default function Home() {
  return (
    <main>
      <h1>AI Todo App</h1>
      <p>
        Setup check: <a href="/api/health/db">/api/health/db</a> should return{" "}
        <code>{`{"ok":true}`}</code>.
      </p>
    </main>
  );
}
