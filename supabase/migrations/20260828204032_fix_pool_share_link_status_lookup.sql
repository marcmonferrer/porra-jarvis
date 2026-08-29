-- Repair the share-link status lookup without rewriting applied migration history.
-- The original function referenced the pool alias without joining public.pools.
create or replace function public.admin_get_pool_share_link(target_pool_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare link_state jsonb;
begin
  perform private.require_porra_admin();
  perform 1 from public.pools where id = target_pool_id;
  if not found then raise exception 'Pool not found'; end if;
  select pg_catalog.jsonb_build_object(
    'createdAt', invitation.created_at, 'expiresAt', pool.closes_at, 'revokedAt', invitation.revoked_at,
    'status', case when invitation.revoked_at is not null then 'revoked'
      when pool.status in ('closed', 'finished') or pool.closes_at <= pg_catalog.now() then 'expired' else 'active' end,
    'usageCount', invitation.usage_count)
  into link_state
  from private.pool_invitations invitation
  join public.pools pool on pool.id = invitation.pool_id
  where invitation.pool_id = target_pool_id and invitation.is_reusable
  order by invitation.created_at desc limit 1;
  return link_state;
end;
$$;

revoke execute on function public.admin_get_pool_share_link(uuid)
  from public, anon, authenticated;
grant execute on function public.admin_get_pool_share_link(uuid)
  to authenticated;