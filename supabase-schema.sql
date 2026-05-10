-- הרץ ב-SQL Editor של Supabase (או כמיגרציה) לפני שימוש בבוט

create table if not exists public.conversations (
  phone text primary key,
  name text not null default '',
  status text not null default 'bot' check (status in ('bot', 'human', 'closed')),
  last_message_at timestamptz not null default now(),
  last_message text not null default ''
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  phone text not null references public.conversations (phone) on delete cascade,
  role text not null check (role in ('user', 'bot', 'human_agent')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_phone_created on public.messages (phone, created_at);
create index if not exists idx_conversations_last_message_at on public.conversations (last_message_at desc);
