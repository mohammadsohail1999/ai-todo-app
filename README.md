# AI Todo App

A todo app whose main screen shows only today's todos, plus a chat assistant that reads and changes them through custom tools.

It's a learning project. The agent loop is hand-written on `@anthropic-ai/sdk` on purpose, so every `tool_use`, `tool_result` and stop reason is visible in the code.

**Stack:** Next.js 16 (App Router), TypeScript, Supabase (Postgres and Auth), Zod, Vitest.

## How this repo is organised

The app is built in phases, described in [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md). Each phase is its own branch and pull request, and each branch builds on the one before:

1. `phase-1-setup`: Next.js project, Supabase clients, first migration
2. `phase-2-auth`: login, signup, logout and session refresh
3. `phase-3-todos`: today's list, without AI
4. `phase-4-agent`: the first agent loop, run in the terminal
5. `phase-5-tools`: all the todo tools, with tests
6. `phase-6-chat-ui`: streaming chat panel

## Local setup

1. Copy `.env.example` to `.env.local` and fill in your Supabase and Anthropic keys.
2. Apply the SQL files in `supabase/migrations/` to your Supabase project.
3. Run `npm install`, then `npm run dev`.
