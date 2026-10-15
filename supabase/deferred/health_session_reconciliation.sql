-- Deferred: affects completed-session sync. Not applied with the Health tables.
begin;
grant select on public.sessions to service_role;
-- Trigger executes as owner because authenticated Ledger writers cannot mutate health tables.
-- NEW.user_id is constrained by existing sessions RLS. No client parameters or dynamic SQL.
create function health_private.reconcile_session() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (select auth.uid()) is not null and (select auth.uid())<>new.user_id then raise exception 'owner mismatch'; end if;
 perform public.health_reconcile(new.user_id);return new;
end $$;
revoke all on function health_private.reconcile_session() from public,anon,authenticated;
create trigger health_session_reconcile after insert or update on public.sessions for each row execute function health_private.reconcile_session();
commit;
