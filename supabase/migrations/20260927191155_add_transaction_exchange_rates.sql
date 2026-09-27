alter table public.transactions
  add column if not exists exchange_rates jsonb,
  add column if not exists exchange_rate_date date;

alter table public.transactions
  add constraint transactions_exchange_rates_object
  check (exchange_rates is null or jsonb_typeof(exchange_rates) = 'object');
