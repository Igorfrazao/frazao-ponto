-- Execute este script no Supabase: Menu "SQL Editor" > "New query" > colar e clicar em "Run"

create table if not exists kv_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

alter table kv_store enable row level security;

-- Libera leitura e escrita para a chave pública (anon).
-- Suficiente para uso interno da empresa (v1, sem login individual).
-- Pode ser restringido futuramente quando o sistema tiver autenticação real.
create policy "kv_store_select" on kv_store for select using (true);
create policy "kv_store_insert" on kv_store for insert with check (true);
create policy "kv_store_update" on kv_store for update using (true);
