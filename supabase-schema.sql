-- הרץ ב-SQL Editor של Supabase (או כמיגרציה) לפני שימוש בבוט

create table if not exists public.conversations (
  phone text primary key,
  name text not null default '',
  status text not null default 'bot' check (status in ('bot', 'human', 'needs_human', 'closed')),
  last_message_at timestamptz not null default now(),
  last_message text not null default '',
  last_user_message text not null default '',
  proactive boolean not null default false
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

-- טבלת לידים
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  business text not null,
  phone text not null,
  business_type text not null,
  notes text,
  source text default 'landing-page',
  status text not null default 'no_contact'
    check (status in ('no_contact', 'message_sent', 'active_conversation', 'relevant', 'not_relevant')),
  message_name text not null default '',
  created_at timestamptz not null default now()
);

-- מיגרציה לפרויקט קיים (הרץ פעם אחת ב-SQL Editor):
-- alter table public.leads add column if not exists status text not null default 'no_contact';
-- alter table public.leads drop constraint if exists leads_status_check;
-- alter table public.leads add constraint leads_status_check
--   check (status in ('no_contact', 'message_sent', 'relevant', 'not_relevant'));
-- alter table public.leads add column if not exists message_name text not null default '';
-- alter table public.conversations add column if not exists last_user_message text not null default '';
-- alter table public.conversations add column if not exists proactive boolean not null default false;
-- alter table public.conversations drop constraint if exists conversations_status_check;
-- alter table public.conversations add constraint conversations_status_check
--   check (status in ('bot', 'human', 'needs_human', 'closed'));
-- alter table public.leads drop constraint if exists leads_status_check;
-- alter table public.leads add constraint leads_status_check
--   check (status in ('no_contact', 'message_sent', 'active_conversation', 'relevant', 'not_relevant'));

-- הפעלת RLS
alter table public.leads enable row level security;

-- מדיניות: לאפשר הכנסה אנונימית (לטופס ציבורי)
create policy "Anyone can insert leads"
  on public.leads
  for insert
  to anon, authenticated
  with check (true);

-- מדיניות קריאה רק למשתמשים מחוברים (אדמין)
create policy "Authenticated can read leads"
  on public.leads
  for select
  to authenticated
  using (true);

-- אינדקס
create index if not exists leads_created_at_idx on public.leads (created_at desc);

-- הגדרות בוט (מתג שליחה שעתית וכו')
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value)
values ('hourly_no_contact_enabled', 'false'::jsonb)
on conflict (key) do nothing;
