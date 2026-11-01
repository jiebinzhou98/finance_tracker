-- Mirrors the migration already applied to finance_tracker (20261101181628).
create table public.savings_goals (
 id uuid primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 name text not null check (char_length(name) between 1 and 60),
 target_amount bigint not null check (target_amount > 0),
 currency text not null check (currency in ('CAD','USD','CNY','EUR','HKD')),
 target_date date,
 icon text not null default '🌱',
 created_at timestamptz not null,
 updated_at timestamptz not null,
 deleted_at timestamptz,
 unique (id, user_id)
);
create table public.savings_deposits (
 id uuid primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 goal_id uuid not null,
 amount bigint not null check (amount > 0),
 deposit_date date not null,
 note text not null default '',
 created_at timestamptz not null,
 updated_at timestamptz not null,
 deleted_at timestamptz,
 foreign key (goal_id,user_id) references public.savings_goals(id,user_id)
);
create index savings_goals_user_idx on public.savings_goals(user_id);
create index savings_deposits_user_goal_idx on public.savings_deposits(user_id,goal_id);
alter table public.savings_goals enable row level security;
alter table public.savings_deposits enable row level security;
revoke all on public.savings_goals, public.savings_deposits from anon, authenticated;
grant select, insert, update on public.savings_goals, public.savings_deposits to authenticated;
create policy savings_goals_select on public.savings_goals for select to authenticated using ((select auth.uid())=user_id);
create policy savings_goals_insert on public.savings_goals for insert to authenticated with check ((select auth.uid())=user_id);
create policy savings_goals_update on public.savings_goals for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy savings_deposits_select on public.savings_deposits for select to authenticated using ((select auth.uid())=user_id);
create policy savings_deposits_insert on public.savings_deposits for insert to authenticated with check ((select auth.uid())=user_id);
create policy savings_deposits_update on public.savings_deposits for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
