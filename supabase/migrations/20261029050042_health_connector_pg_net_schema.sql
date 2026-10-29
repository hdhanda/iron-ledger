-- pg_net is not relocatable. Reinstall before any bridge jobs are dispatched.
-- Keeping its extension namespace outside public avoids the Supabase advisory.
begin;
do $$begin
 if exists(select 1 from net.http_request_queue) then raise exception 'network_queue_not_empty'; end if;
end $$;
drop extension pg_net;
create extension pg_net schema extensions;
revoke all on all tables in schema net from public,anon,authenticated;
revoke execute on all functions in schema net from public,anon,authenticated;
grant usage on schema net to service_role;
grant select on net._http_response to service_role;
grant execute on function net.http_post(text,jsonb,jsonb,jsonb,integer) to service_role;
commit;
