create table if not exists public.transactions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('income', 'expense')),
  amount bigint not null check (amount > 0),
  currency text not null check (char_length(currency) = 3),
  category text not null,
  note text not null default '',
  transaction_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists transactions_user_date_idx
  on public.transactions (user_id, transaction_date desc);

alter table public.transactions enable row level security;

create policy "Users can read their own transactions"
on public.transactions for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can insert their own transactions"
on public.transactions for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own transactions"
on public.transactions for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own transactions"
on public.transactions for delete to authenticated
using ((select auth.uid()) = user_id);

grant select, insert, update, delete on table public.transactions to authenticated;
