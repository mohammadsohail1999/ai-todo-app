# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

Phases 1 (setup), 2 (auth) and 3 (todos without AI) are built: the Next.js project, the Supabase clients in `src/lib/supabase/`, the first migration, login, signup and logout, `src/proxy.ts`, a test route at `/api/health/db` that requires a session, `src/lib/todos.ts`, `src/lib/today.ts`, the routes under `/api/todos`, and today's list in `src/components/today-todos.tsx`. Phase 4 (first agent, in the terminal) is done: the hand-written loop in `src/agent/loop.ts`, the system prompt in `src/agent/prompt.ts`, and the terminal driver `scripts/agent.ts`, which signs in a test user with `signInWithPassword` and prints usage for each API call. Phase 5 (all the tools) is done: `src/agent/tools.ts` has `list_todos`, `add_todo`, `set_todo_status`, `move_todo` and a temporary `delete_todo` that deletes without confirmation until Phase 7, and `src/agent/loop.test.ts` tests the loop with a scripted fake Anthropic client and a mocked `@/lib/todos`. Phase 6 (chat UI) is done: `src/app/api/chat/route.ts` (GET returns today's thread as display items; POST runs the loop and streams `ChatEvent`s from `src/agent/events.ts` as newline-delimited JSON), `src/lib/conversations.ts` (load and save the per-day thread with a `version` check), the loop's `onCheckpoint` option, which saves after each tool round and after the final answer, and `src/components/chat-panel.tsx` with `today-view.tsx`, which reloads the list on `todos_changed`. Phases 4 to 6 landed on `main` together in one PR. Phase 7 (delete confirmation) is next. Don't deploy before Phase 7, because chat can delete without confirmation. Route handlers, Server Actions and pages check the session with `getVerifiedUser()` from `src/lib/auth.ts`, which wraps `supabase.auth.getClaims()`. `docs/PROJECT_PLAN.md` is the source of truth for the decisions, data model, tool specs, phases and verification checklist. Read it before starting work, and update this file as code and commands appear.

This Next.js version differs from older ones: read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code (see `AGENTS.md`).

## Commands

- `npm run dev`: start the dev server
- `npm run build`: production build
- `npm run lint`: ESLint
- `npm run test`: Vitest, configured in `vitest.config.mts` (`.mts` because the package is CommonJS)
- `npm run agent -- "<message>"`: run the agent loop in the terminal and print every request and response in full. It needs `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `AGENT_TEST_EMAIL` and `AGENT_TEST_PASSWORD` in `.env.local`. The package is CommonJS, so scripts run with tsx can't use top-level `await`.

Local settings go in `.env.local`, copied from `.env.example`. Schema changes go in new SQL files in `supabase/migrations/`.

## Working rule

Build one phase at a time. Each phase stops at its "Done when" check for the user's review, and the next phase starts only when the user says so.

## What this is

A todo app whose main screen shows only today's todos, plus a chat assistant that reads and changes todos through custom tools. It's a learning project and a small public portfolio demo. **The agent loop is hand-written on `@anthropic-ai/sdk` on purpose.** Don't replace it with Tool Runner or another framework; that comparison is an optional later stretch goal.

Stack: Next.js 16 App Router, TypeScript, Supabase (Postgres via `@supabase/supabase-js`, Auth via `@supabase/ssr`), Zod, deployed on Vercel. The model is set by the `ANTHROPIC_MODEL` env var.

## Architecture invariants

These span several planned files and are easy to break:

- **`lib/todos.ts` is the key boundary.** The UI routes and the agent tools call the same functions, passing in the logged-in user's Supabase client, so behaviour can't drift apart.
- **`userId` is never a tool input.** Tools use the logged-in user's client, so Row Level Security applies to every query, including lookups by `id`.
- **The app's agent never calls the Supabase MCP server.** It runs with developer permissions and its `execute_sql` tool would have the model write raw SQL, bypassing per-user access and the delete confirmation. It's only a dev tool for use in Claude Code.
- **`conversations` is server-only.** It has Row Level Security with no client policies or grants, because the publishable key is public and a user could otherwise reset `message_count` or forge `pending`. Only `lib/conversations.ts` touches it, using the secret-key client from `lib/supabase/admin.ts` and the `user_id` from verified claims.
- **Every new table sets its grants and policies in its migration.** Policies don't take back default grants, and not every Supabase project grants them automatically.
- **Every route handler verifies the session again** with `supabase.auth.getClaims()`. `src/proxy.ts` (Next 16's name for middleware) is only an optimistic check.
- **"Today" is a `YYYY-MM-DD` string,** derived from the browser's IANA timezone and validated on the server. Don't do timezone math in queries.
- **Agent state lives in the database, not the request.** Deletes pause the loop, save `pending` to the conversation and end the stream; `POST /api/chat/confirm` atomically claims `pending` and resumes the loop.
- **Confirmation cards show titles read from the database,** never the model's wording.

## Anthropic API rules for the loop

- Save `message.content` unchanged, thinking blocks included. History is append-only.
- Every `tool_use` needs its `tool_result` in the very next message, so the chat input stays disabled while a confirmation is pending.
- Parallel tool results go in one user message.
- Check `refusal` and `max_tokens` stop reasons before running any tools from that turn.
- Tools set `eager_input_streaming: true`, so Zod validation of tool inputs is required. Validation failures go back as `tool_result` with `is_error: true`.
