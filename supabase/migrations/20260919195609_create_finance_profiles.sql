create table if not exists public.finance_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  monthly_budget bigint not null default 0
    check (monthly_budget >= 0),
  monthly_savings_target bigint not null default 0
    check (monthly_savings_target >= 0),
  recurring_rules jsonb not null default '[]'::jsonb
    check (jsonb_typeof(recurring_rules) = 'array'),
  updated_at timestamptz not null default now()
);

alter table public.finance_profiles enable row level security;

revoke all on table public.finance_profiles from anon;
grant select, insert, update on table public.finance_profiles to authenticated;

create policy "users_select_own_finance_profile"
  on public.finance_profiles
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "users_insert_own_finance_profile"
  on public.finance_profiles
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "users_update_own_finance_profile"
  on public.finance_profiles
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
