alter table public.transactions
  add column if not exists subcategory text;
