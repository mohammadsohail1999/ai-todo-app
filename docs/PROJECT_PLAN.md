# AI Todo App: Project Plan

## Context

A todo app whose main screen shows only today's todos, plus a chat assistant that can read and change todos through custom tools. It's a learning project: the goal is to understand how agents work underneath, so the agent loop is hand-written on purpose. It will be deployed as a small public portfolio demo. The project folder is empty, so everything is new.

## Decisions

| Area | Decision | Why |
|---|---|---|
| Agent loop | Hand-written on `@anthropic-ai/sdk` | Learning the loop is the point. The SDK's Tool Runner is the usual production choice and is a stretch goal to compare against. |
| Stack | Next.js 16 App Router, TypeScript | One codebase, easy deployment |
| Database | Supabase Postgres with `@supabase/supabase-js`, and Zod for tool inputs | Less plumbing that's unrelated to the agent; Row Level Security enforces per-user access in the database |
| Hosting | Vercel + Supabase | Simple; the agent saves its state, so a confirmation can resume in a new request |
| Auth | Supabase Auth with `@supabase/ssr` cookie sessions | Signup, login, password hashing and token refresh aren't the learning goal |
| Supabase MCP server | Dev tool in Claude Code only, never called by the app's agent | It runs with developer permissions (Supabase's docs say not to give it to end users), and its `execute_sql` tool would have the model write raw SQL. That bypasses per-user access and the delete confirmation. |
| Audience | Open signup, portfolio scale, per-user daily message cap | Protects your API credit |
| "Today" | Plain `YYYY-MM-DD` string, derived from the browser's IANA timezone and validated on the server | Correct while travelling, no timezone math in queries |
| Unfinished todos | Stay on their date; the AI can move them | Today starts clean, and moving gives the agent a real multi-step task |
| Past todos | UI shows today only; the AI has full access to any date | Chat adds something the buttons don't |
| Todo fields | Title, status, date, timestamps | Keeps the focus on agents |
| AI permissions | Add, close and move run immediately; delete needs a Confirm click, then is permanent | Teaches human-in-the-loop |
| Chat memory | One saved thread per user per day | Matches the "today" idea and keeps requests short |
| Model | `claude-haiku-5-5` ($0.10 / $0.50 per million tokens), low effort, set by the `ANTHROPIC_MODEL` env var | Cheap to practise on; switching models is a one-line config change |
| Out of scope for v1 | Email verification, password reset, revoking a session before expiry, priority/tags | Unrelated to the learning goal |

## Data model

Defined in `supabase/migrations/`. Users live in Supabase's own `auth.users` table.

```
todos:         id, user_id -> auth.users, title, status: "open" | "done", date: "2026-10-30",
               created_at, completed_at | null
               index: (user_id, date, created_at)
conversations: id, user_id -> auth.users, date, messages: Anthropic.MessageParam[] (jsonb),
               pending: PendingTurn | null (jsonb), version, message_count
               unique: (user_id, date)
```

`PendingTurn` holds the delete calls awaiting a decision and the finished results of the other tools from the same turn.

Access rules:
- **`todos`:** Row Level Security limits every operation to `auth.uid() = user_id`. Accessed with the logged-in user's client. `anon` has no grants.
- **`conversations`:** Row Level Security is on with no client policies and no grants for `anon` or `authenticated`. The publishable key is public, so a user policy would let someone call the Data API directly, reset `message_count` or forge `pending`, and defeat the cost cap. Only `lib/conversations.ts` touches this table, using a server-only secret-key client and the `user_id` from verified claims.

Atomic operations:
- **Claim pending:** `update ... where pending is not null ... returning`.
- **Version check:** `update ... where version = $v`.
- **Message cap:** a small Postgres function, added in Phase 8, because `supabase-js` has no increment.

## Agent tools

| Tool | Input | Runs |
|---|---|---|
| `list_todos` | `date?` or `from?`/`to?`, `status?` | Immediately. Returns todos and counts, which answers "how many are done?" and "show previous todos". |
| `add_todo` | `title`, `date?` (defaults to today) | Immediately |
| `set_todo_status` | `id`, `status` | Immediately. Covers close and reopen. |
| `move_todo` | `id`, `date` | Immediately |
| `delete_todo` | `id` | After Confirm |

Rules for every tool:
- **`userId` is never a tool input.** Tools run with the logged-in user's Supabase client, so Row Level Security applies to every query, including lookups by `id`, and the model can't reach another user's data.
- **Inputs are validated with Zod before running.** A failure goes back as `tool_result` with `is_error: true`, so Claude can correct itself.
- **Descriptions say when to call the tool,** not just what it does. Weak descriptions show up quickly on a smaller model.

## The agent loop

Lives in `src/agent/loop.ts`, and is the heart of the project:

```ts
for (let i = 0; i < MAX_ITERATIONS; i++) {          // guard against runaway loops: 8
  const stream = client.messages.stream({ model, max_tokens: 4096, system, tools, messages,
                                          output_config: { effort: "low" } });
  stream.on("text", (delta) => emit({ type: "text", delta }));
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") return emit({ type: "refused" });  // never run this turn's tools
  if (message.stop_reason === "max_tokens") return emit({ type: "truncated" }); // tool input may be cut off

  messages.push({ role: "assistant", content: message.content });           // save unchanged
  const calls = message.content.filter((b) => b.type === "tool_use");
  if (calls.length === 0) return save();                                    // done

  const results = await runSafeTools(calls);                                // parallel; all deletes held back
  if (hasDelete(calls)) return pauseForConfirmation(calls, results);        // save and end the request

  messages.push({ role: "user", content: results });                        // ALL results in ONE message
  await save();
}
```

API rules this has to respect:
- **Save `message.content` unchanged, thinking blocks included.** History is append-only; editing an earlier turn can make the API reject the request.
- **Every `tool_use` needs its `tool_result` in the very next message.** This drives the confirmation design below.
- **Parallel results go in one user message.** "Close all of them" arrives as several calls in one response.
- **Haiku 5.5 has no server-side refusal fallback,** so a refusal shows a plain message in the chat.
- **Tools set `eager_input_streaming: true`,** so the Zod check above is required, not optional.

The system prompt contains today's date. That's safe for prompt caching because each thread lasts one day.

## Delete confirmation

A delete can't hold a request open while waiting for a person, particularly on Vercel. So:

1. Claude calls `delete_todo`, possibly alongside other tools. The safe tools run and all deletes are held.
2. The assistant message and `pending` are saved atomically, and the stream ends with `confirm_required`.
3. The UI shows a Confirm/Cancel card with **titles read from the database**, not the model's wording, so what you approve is what gets deleted. All deletes in one turn share one decision.
4. `POST /api/chat/confirm` atomically claims `pending`, so a double click can't run it twice. It deletes or records "user declined", combines those with the held results into one user message, and resumes the loop.
5. The chat input is disabled while a confirmation is pending, so no message can land between `tool_use` and `tool_result`. A refresh restores the card from the database.

## Failure handling

- **Two tabs at once:** the `version` field makes the second write fail, and the UI asks the user to retry.
- **Function dies mid-turn:** on the next load, any `tool_use` with no result gets a `tool_result` saying it was interrupted, which keeps history valid. A tool may have already run, so a duplicate `add_todo` is possible; that's acceptable at this scale.
- **Crossing midnight:** the next message starts a new thread for the new date. An unanswered delete in the old thread is never run.
- **API errors:** caught as typed SDK errors, most specific first; rate limits and overloads show a "try again" message.

## Cost protection

- 30 chat messages per user per day, enforced with an atomic counter on `messageCount`.
- 500-character limit on each chat message.
- A spend limit set on the Anthropic Console account, as the final backstop.
- `usage` logged for every API call, so you can see the real token cost of a turn. This is also a useful learning view.

## Auth

- `src/proxy.ts` (Next 16's name for middleware) refreshes the Supabase session and redirects to `/login`.
- **Every route handler verifies the session again** with `supabase.auth.getClaims()`. The Next.js docs treat proxy as an optimistic check, and their example matcher skips `/api`.
- Email confirmation is turned off in the Supabase project, because email verification is out of scope for v1.

## Project layout

```
src/
  proxy.ts
  app/
    page.tsx                  # today's todos + chat panel
    login/, signup/
    api/todos/route.ts, api/todos/[id]/route.ts
    api/chat/route.ts         # streams the agent loop
    api/chat/confirm/route.ts # resumes after a decision
    actions/auth.ts           # login, signup and logout Server Actions
  components/
    auth-form.tsx             # shared login and signup form
  agent/
    loop.ts, tools.ts, prompt.ts, events.ts
  lib/
    auth.ts                   # getVerifiedUser(): getClaims() check for routes, actions and pages
    supabase/server.ts        # per-request client using the user's cookies
    supabase/proxy.ts         # session refresh and redirects, called by proxy.ts
    supabase/admin.ts         # secret-key client, server-only
    today.ts                  # timezone -> YYYY-MM-DD
    todos.ts                  # shared by the UI routes AND the agent tools; takes the user's client
    conversations.ts          # the only code that touches conversations
supabase/migrations/          # SQL schema, grants and policies
docs/PROJECT_PLAN.md          # copy of this document
```

`lib/todos.ts` is the key boundary: the buttons and the AI call the same functions, so behaviour can't drift apart.

The chat route streams newline-delimited JSON through a `ReadableStream`, with events `text`, `tool_start`, `tool_result`, `todos_changed`, `confirm_required`, `done` and `error`. `todos_changed` makes the todo list update live while the AI works.

## Phases

**Working rule:** build one phase at a time. Each phase stops at its "Done when" check, you review it, and the next phase starts only when you say so.

**Right now:** only save this document to `docs/PROJECT_PLAN.md`. No app code until you start Phase 1.

### Phase 1: Setup
- **Build:** Next.js and TypeScript project, Supabase clients (`lib/supabase/`), the first migration, `.env.example`, `.gitignore`.
- **You need:** a Supabase project and its URL, publishable key and secret key. The Anthropic API key isn't needed until Phase 4.
- **Done when:** the app runs locally and a test route reads from Supabase.

### Phase 2: Auth
- **Build:** login and signup pages using Supabase Auth, logout, `proxy.ts` session refresh, a `getClaims()` check in route handlers. Turn off email confirmation in the Supabase project.
- **Learn:** how a Supabase session works in cookies, and how Row Level Security uses it.
- **Done when:** a login survives a browser restart, and logged-out requests get 401 or a redirect.

### Phase 3: Todos without AI
- **Build:** `lib/todos.ts`, `lib/today.ts`, todo API routes, today's list with add, complete and delete buttons.
- **Learn:** the date-string approach to "today".
- **Done when:** todos are per-user, and a todo from another date doesn't appear on today's list.

### Phase 4: Your first agent, in the terminal
- **Build:** `agent/loop.ts` and a script with `list_todos` and `add_todo`, printing every request and response in full. The script signs in a test user with `signInWithPassword`, because it has no cookie.
- **Learn:** the core of the project: `tool_use`, `tool_result`, stop reasons and why the whole history is re-sent. No UI gets in the way.
- **Done when:** "add buy milk, then tell me what's on my list" runs two tools across multiple loop iterations, and you can explain each message in the printed log.

### Phase 5: All the tools
- **Build:** `set_todo_status`, `move_todo`, a temporary unconfirmed `delete_todo`, Zod validation, error results, the iteration limit, usage logging, and tests with a fake client.
- **Learn:** parallel tool calls, how Claude recovers from errors, and how tool descriptions change behaviour.
- **Done when:** "move yesterday's unfinished todos to today" works in the terminal and the loop tests pass.

### Phase 6: Chat UI
- **Build:** streaming chat route, chat panel, per-day thread saved in Supabase, live list updates.
- **Learn:** stream events, and persisting a conversation in the API's exact format.
- **Done when:** replies stream gradually, the todo list updates while the AI works, and the chat survives a refresh.

### Phase 7: Delete confirmation
- **Build:** pause and resume as described in "Delete confirmation", the confirm route and the Confirm/Cancel card. This replaces the temporary delete from Phase 5.
- **Learn:** human-in-the-loop, and why agent state must live outside the request.
- **Done when:** the delete rows in the manual table below all pass, including refresh and double click.

### Phase 8: Hardening and deploy
- **Build:** cost caps, failure handling, then deploy to Vercel + Supabase. Check Supabase's current free-tier inactivity pause rules first, since a portfolio demo can sit idle. Set `maxDuration` on the chat routes after checking Vercel's current limits for your plan.
- **Done when:** the whole Verification section passes on the deployed URL.

### Later, optional
Rewrite the loop with Tool Runner and compare; add prompt caching; try Sonnet 5.5 or Opus 5.5 by env var on vague requests.

## Verification

**Automated (Vitest), with a scripted fake Anthropic client and a test database:**
- The loop handles a plain answer, a single tool call, parallel calls, an invalid input, `refusal`, `max_tokens` and the iteration limit.
- Mixed safe tools and a delete produce one combined result message after confirmation.
- A second user's todo `id` returns "not found" from every tool, which also proves Row Level Security works.
- A double confirm deletes once.
- Date helper: 1 AM in `Asia/Kolkata` gives the local date, not the UTC date.

**Manual, in the real app, with these chat messages:**

| Say | Expected |
|---|---|
| "add buy milk and call mom" | Two todos appear live |
| "how many are done today?" | A correct count from `list_todos` |
| "close the milk one" | Resolved to the right todo and closed |
| "what did I have last Tuesday?" | Correct date resolved, past todos listed |
| "move yesterday's unfinished todos to today" | Lists, then moves each one |
| "delete call mom" → Cancel | Todo remains, and Claude acknowledges the cancellation |
| "delete call mom" → refresh → Confirm | Card survives the refresh and the todo is deleted |
| "delete everything from last week" | One card listing every todo by its real title |

**Also check:**
- Logged-out requests to `/api/*` get 401.
- A logged-in user calling the Supabase Data API directly with the publishable key can't read or write `conversations`.
- Message 31 of the day is refused without calling the API.
- All of the above again on the deployed Vercel URL, including whether streaming arrives gradually rather than all at once.
