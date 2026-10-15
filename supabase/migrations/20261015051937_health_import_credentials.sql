-- Revocable webhook credentials; no plaintext token and no public/client access.
begin;
set local lock_timeout='5s';
create table health_private.import_tokens (
 token_sha256 text primary key check(token_sha256 ~ '^[0-9a-f]{64}$'),
 user_id uuid not null references auth.users(id),
 label text not null,
 enabled boolean not null default true,
 created_at timestamptz not null default now()
);
create index health_import_tokens_owner on health_private.import_tokens(user_id);
alter table health_private.import_tokens enable row level security;
revoke all on health_private.import_tokens from public,anon,authenticated;
grant select,insert,update,delete on health_private.import_tokens to service_role;
create policy service_token_access on health_private.import_tokens for all to service_role using(true) with check(true);
create function public.health_authenticate_import(p_token_hash text) returns uuid
language sql stable security invoker set search_path='' as $$
 select user_id from health_private.import_tokens where token_sha256=p_token_hash and enabled;
$$;
revoke all on function public.health_authenticate_import(text) from public,anon,authenticated;
grant execute on function public.health_authenticate_import(text) to service_role;
commit;
