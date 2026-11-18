-- todos: users reach their own rows through the Data API, limited by Row Level Security.
create table public.todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  status text not null default 'open' check (status in ('open', 'done')),
  date date not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index todos_user_date_created_idx on public.todos (user_id, date, created_at);

alter table public.todos enable row level security;

-- Policies don't take back default grants, and not every project sets them, so be explicit.
revoke all on public.todos from anon, authenticated;
grant select, insert, update, delete on public.todos to authenticated;
grant select, insert, update, delete on public.todos to service_role;

create policy "Users can read their own todos"
on public.todos for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can add their own todos"
on public.todos for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own todos"
on public.todos for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own todos"
on public.todos for delete to authenticated
using ((select auth.uid()) = user_id);

-- conversations: server only. The publishable key is public, so any client access would
-- let a user reset message_count or forge pending. RLS is on with deliberately no policies.
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  date date not null,
  messages jsonb not null default '[]'::jsonb,
  pending jsonb,
  version integer not null default 0,
  message_count integer not null default 0,
  unique (user_id, date)
);

alter table public.conversations enable row level security;

revoke all on public.conversations from anon, authenticated;
grant select, insert, update, delete on public.conversations to service_role;
