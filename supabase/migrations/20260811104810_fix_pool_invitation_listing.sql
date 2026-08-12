-- Repair the applied invitation-listing function without rewriting migration history.
-- PostgreSQL exposes COALESCE as SQL syntax, not as a catalog-qualified function.

create or replace function public.admin_list_pool_invitations(target_pool_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  invitation_list jsonb;
begin
  perform private.require_porra_admin();

  perform 1 from public.pools where id = target_pool_id;
  if not found then raise exception 'Pool not found'; end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'invitationId', invitation.id,
        'createdAt', invitation.created_at,
        'expiresAt', invitation.expires_at,
        'consumedAt', invitation.consumed_at,
        'revokedAt', invitation.revoked_at,
        'status', case
          when invitation.consumed_at is not null then 'consumed'
          when invitation.revoked_at is not null then 'revoked'
          when invitation.expires_at <= pg_catalog.now() then 'expired'
          else 'active'
        end
      )
      order by invitation.created_at desc
    ),
    '[]'::jsonb
  )
  into invitation_list
  from private.pool_invitations invitation
  where invitation.pool_id = target_pool_id;

  return invitation_list;
end;
$$;

revoke execute on function public.admin_list_pool_invitations(uuid)
  from public, anon, authenticated;

grant execute on function public.admin_list_pool_invitations(uuid)
  to authenticated;
