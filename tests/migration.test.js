import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260810143143_porra_live_v1.sql", import.meta.url);
const invitationMigrationName = "20260811102102_add_pool_invitations.sql";
const repairMigrationName = "20260811104810_fix_pool_invitation_listing.sql";
const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);
const invitationMigrationUrl = new URL(invitationMigrationName, migrationsUrl);
const repairMigrationUrl = new URL(repairMigrationName, migrationsUrl);
const repositoryUrl = new URL("../src/repository.js", import.meta.url);
const edgeFunctionUrl = new URL("../supabase/functions/sync-live-score/index.ts", import.meta.url);

const sql = await readFile(migrationUrl, "utf8");
const invitationSql = await readFile(invitationMigrationUrl, "utf8");
const repairSql = await readFile(repairMigrationUrl, "utf8");
const migrationFileNames = (await readdir(migrationsUrl)).filter((name) => name.endsWith(".sql")).sort();
const laterMigrationSql = await Promise.all(
  migrationFileNames
    .filter((name) => name > invitationMigrationName)
    .map(async (name) => ({ name, sql: await readFile(new URL(name, migrationsUrl), "utf8") }))
);
const repositorySource = await readFile(repositoryUrl, "utf8");
const edgeFunctionSource = await readFile(edgeFunctionUrl, "utf8");

function functionBody(name, source = sql) {
  const match = source.match(
    new RegExp(`create(?: or replace)? function ${name.replace(".", "\\.")}\\([^]*?\\n\\$\\$;`, "i")
  );
  assert.ok(match, `No s'ha trobat la funció ${name}`);
  return match[0];
}

function normalizeSql(source) {
  return source
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

test("la migració inicial té blocs SQL complets i target_phase a la funció correcta", () => {
  assert.equal((sql.match(/\$\$/g) || []).length % 2, 0);
  const reservation = functionBody("public.create_public_reservation");
  const capacity = functionBody("private.validate_bet_capacity");
  assert.match(reservation, /declare[\s\S]*target_phase text;/);
  assert.match(reservation, /select phase into target_phase/);
  assert.doesNotMatch(capacity, /target_phase text;/);
});

test("la reserva pública és atòmica, bloqueja concurrència i rebutja partits iniciats", () => {
  const reservation = functionBody("public.create_public_reservation");
  assert.match(reservation, /for update/);
  assert.match(reservation, /pg_advisory_xact_lock\(hashtextextended\(target_pool\.id::text \|\| ':cell:'/);
  assert.match(reservation, /target_phase in \('first', 'half', 'second', 'final'\)/);
  assert.match(reservation, /now\(\) >= target_pool\.closes_at/);
  assert.match(sql, /active_cell_count >= 2/);
  assert.match(sql, /Participant cannot repeat a cell/);
});

test("anon només rep les tres RPC públiques i la lectura mínima de revisions", () => {
  assert.match(sql, /revoke all on all tables in schema public from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.create_public_reservation\(text, text, text\[\]\) to anon, authenticated/);
  assert.match(sql, /grant execute on function public\.get_public_pool_state\(text\) to anon, authenticated/);
  assert.match(sql, /grant execute on function public\.get_tracking_state\(text\) to anon, authenticated/);
  assert.match(sql, /grant select on public\.pool_revisions to anon, authenticated/);
  assert.doesNotMatch(sql, /grant select[^;]*public\.(bets|participants|pools|match_states)[^;]*to anon/i);
});

test("un autenticat no és administrador sense una fila positiva a admin_profiles", () => {
  const check = functionBody("private.is_porra_admin");
  assert.match(check, /public\.admin_profiles/);
  assert.match(check, /user_id = \(select auth\.uid\(\)\)/);
  assert.doesNotMatch(sql, /app_metadata|user_metadata|auth\.role\(\)/);
  assert.match(sql, /using \(private\.is_porra_admin\(\)\)/);
});

test("totes les funcions privilegiades tenen search_path buit i EXECUTE revocat", () => {
  for (const name of [
    "private.is_porra_admin",
    "private.require_porra_admin",
    "private.validate_bet_capacity",
    "private.initialize_pool_children",
    "private.bump_pool_revision",
    "public.create_public_reservation",
    "public.get_public_pool_state",
    "public.get_tracking_state",
    "public.admin_update_reservation",
    "public.admin_update_match",
    "public.admin_finalize_pool"
  ]) {
    const body = functionBody(name);
    assert.match(body, /set search_path = ''/);
  }
  assert.match(sql, /revoke execute on all functions in schema public from public, anon, authenticated/);
  assert.match(sql, /revoke execute on all functions in schema private from public, anon, authenticated/);
});

test("RLS està activat a totes les taules públiques", () => {
  for (const table of [
    "admin_profiles", "pools", "special_bets", "participants", "bets",
    "match_states", "special_results", "prize_results", "prize_awards", "pool_revisions"
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
});

test("les tres operacions administratives són RPC transaccionals protegides", () => {
  for (const name of ["admin_update_reservation", "admin_update_match", "admin_finalize_pool"]) {
    const body = functionBody(`public.${name}`);
    assert.match(body, /security definer/);
    assert.match(body, /private\.require_porra_admin\(\)/);
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}[^;]+to authenticated`));
    assert.doesNotMatch(sql, new RegExp(`grant execute on function public\\.${name}[^;]+to anon`));
  }
  assert.match(functionBody("public.admin_finalize_pool"), /Prize awards do not conserve the pool/);
});

test("Realtime publica només la revisió segura i tots els canvis rellevants l'incrementen", () => {
  assert.match(sql, /alter publication supabase_realtime add table public\.pool_revisions/);
  for (const table of ["bets", "match_states", "pools", "special_results"]) {
    assert.match(sql, new RegExp(`alter publication supabase_realtime drop table public\\.${table}`));
  }
  for (const trigger of ["bets_bump_revision", "match_states_bump_revision", "special_results_bump_revision"]) {
    assert.match(sql, new RegExp(`create trigger ${trigger}`));
  }
  assert.match(sql, /revision = revision \+ 1/);
  assert.doesNotMatch(functionBody("private.bump_pool_revision"), /display_name|payment_status|tracking_token|final_home/);
});

test("l'estat públic evita UUIDs, pendents i instruccions de pagament", () => {
  const publicState = functionBody("public.get_public_pool_state");
  assert.match(publicState, /'id', target_pool\.slug/);
  assert.match(publicState, /payment_status = 'paid'/);
  assert.match(publicState, /'occupancy'/);
  assert.doesNotMatch(publicState, /'paymentStatus'|'participantId'|'paymentInstructions'|'trackingToken'/);
  assert.match(functionBody("public.get_tracking_state"), /paymentInstructions/);
  assert.match(functionBody("public.create_public_reservation"), /paymentInstructions/);
});

test("el frontend refresca per RPC i no se subscriu directament a bets", () => {
  assert.match(repositorySource, /rpc\("get_public_pool_state"/);
  assert.match(repositorySource, /table: "pool_revisions"/);
  assert.match(repositorySource, /filter: `pool_slug=eq\.\$\{poolSlug\}`/);
  assert.doesNotMatch(repositorySource, /table: "bets"/);
  assert.match(repositorySource, /CHANNEL_ERROR.*TIMED_OUT.*CLOSED/s);
  assert.match(repositorySource, /removeChannel/);
});

test("supabase-js està fixat a una versió exacta estable", () => {
  assert.match(repositorySource, /@supabase\/supabase-js@2\.111\.0/);
  assert.match(edgeFunctionSource, /@supabase\/supabase-js@2\.111\.0/);
  assert.doesNotMatch(repositorySource, /@supabase\/supabase-js@2["']/);
  assert.doesNotMatch(edgeFunctionSource, /@supabase\/supabase-js@2["']/);
});

test("la migració d'invitacions crea una taula privada tancada i indexada", () => {
  assert.match(invitationSql, /create table private\.pool_invitations/);
  assert.match(invitationSql, /token_hash text not null unique\s+check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(invitationSql, /pool_id uuid not null references public\.pools\(id\) on delete cascade/);
  assert.match(invitationSql, /consumed_by uuid unique references public\.participants\(id\) on delete set null/);
  assert.match(invitationSql, /created_by uuid not null references auth\.users\(id\)/);
  assert.match(invitationSql, /check \(expires_at > created_at\)/);
  assert.match(invitationSql, /check \(not \(consumed_at is not null and revoked_at is not null\)\)/);
  assert.match(invitationSql, /check \(consumed_by is null or consumed_at is not null\)/);
  assert.match(invitationSql, /create index pool_invitations_pool_created_idx\s+on private\.pool_invitations\(pool_id, created_at desc\)/);
  assert.match(invitationSql, /create index pool_invitations_created_by_idx\s+on private\.pool_invitations\(created_by\)/);
  assert.match(invitationSql, /revoke all on table private\.pool_invitations from public, anon, authenticated/);
  assert.match(invitationSql, /alter table private\.pool_invitations enable row level security/);
  assert.doesNotMatch(invitationSql, /grant (select|insert|update|delete)[^;]*private\.pool_invitations/i);
});

test("el token d'invitació és hexadecimal lowercase de 256 bits i es desa hashejat com a text", () => {
  const createInvitation = functionBody("public.admin_create_pool_invitation", invitationSql);
  const reservation = functionBody("public.create_public_reservation", invitationSql);
  assert.match(createInvitation, /raw_token := pg_catalog\.encode\(extensions\.gen_random_bytes\(32\), 'hex'\)/);
  assert.match(createInvitation, /pg_catalog\.encode\(extensions\.digest\(raw_token, 'sha256'\), 'hex'\)/);
  assert.match(reservation, /pg_catalog\.octet_length\(invitation_token\) <> 64/);
  assert.match(reservation, /invitation_token !~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(reservation, /extensions\.digest\(invitation_token, 'sha256'\)/);
  assert.ok(
    reservation.indexOf("pg_catalog.octet_length(invitation_token)")
      < reservation.indexOf("invitation_token !~ '^[0-9a-f]{64}$'")
  );
  assert.ok(
    reservation.indexOf("invitation_token !~ '^[0-9a-f]{64}$'")
      < reservation.indexOf("extensions.digest(invitation_token, 'sha256')")
  );
  assert.equal((reservation.match(/raise exception 'Invalid invitation'/g) || []).length, 3);
  assert.doesNotMatch(reservation, /Invitation (expired|revoked|consumed)|Wrong pool/i);
});

test("la reserva reclama la invitació abans de crear el participant i conserva la resposta privada", () => {
  const reservation = functionBody("public.create_public_reservation", invitationSql);
  const tokenFormatAt = reservation.indexOf("pg_catalog.octet_length(invitation_token)");
  const selectionAt = reservation.indexOf("pg_catalog.cardinality(selected_cells)");
  const cellFormatAt = reservation.indexOf("target_cell !~ '^[0-4]-[0-4]$'");
  const poolAt = reservation.indexOf("from public.pools");
  const phaseAt = reservation.indexOf("from public.match_states");
  const claimAt = reservation.indexOf("update private.pool_invitations");
  const participantAt = reservation.indexOf("insert into public.participants");
  const consumerAt = reservation.indexOf("set consumed_by = new_participant_id");
  const participantIdAt = reservation.indexOf("new_participant_id := pg_catalog.gen_random_uuid()");
  const trackingTokenAt = reservation.indexOf("raw_token := pg_catalog.encode(extensions.gen_random_bytes(24)");
  assert.ok(
    tokenFormatAt > 0
      && tokenFormatAt < selectionAt
      && selectionAt < cellFormatAt
      && cellFormatAt < poolAt
      && poolAt < phaseAt
      && phaseAt < claimAt
  );
  assert.ok(claimAt < participantIdAt && claimAt < trackingTokenAt);
  assert.ok(claimAt > 0 && claimAt < participantAt && participantAt < consumerAt);
  assert.match(reservation, /and expires_at > pg_catalog\.now\(\)\s+and consumed_at is null\s+and revoked_at is null/);
  assert.match(reservation, /returning id into claimed_invitation_id/);
  assert.match(reservation, /pg_catalog\.pg_advisory_xact_lock/);
  assert.match(reservation, /cardinality\(selected_cells\) not between 1 and 2/);
  assert.match(reservation, /target_phase in \('first', 'half', 'second', 'final'\)/);
  const publicReturn = reservation.slice(reservation.lastIndexOf("return pg_catalog.jsonb_build_object"));
  assert.match(publicReturn, /'token', raw_token/);
  assert.match(publicReturn, /'paymentInstructions', target_pool\.payment_instructions/);
  assert.doesNotMatch(publicReturn, /invitationId|invitationToken|token_hash|created_by|consumed_by|poolId/);
});

test("la revocació competeix atòmicament amb el consum i només afecta invitacions disponibles", () => {
  const revokeInvitation = functionBody("public.admin_revoke_pool_invitation", invitationSql);
  assert.match(revokeInvitation, /update private\.pool_invitations\s+set revoked_at = pg_catalog\.now\(\)/);
  assert.match(revokeInvitation, /where id = target_invitation_id\s+and consumed_at is null\s+and revoked_at is null/);
  assert.match(revokeInvitation, /private\.require_porra_admin\(\)/);
  assert.doesNotMatch(revokeInvitation, /execute\s+format|execute\s+immediate/i);
});

test("les RPC administratives d'invitacions són mínimes, protegides i no confien en created_by del client", () => {
  for (const name of [
    "admin_create_pool_invitation",
    "admin_list_pool_invitations",
    "admin_revoke_pool_invitation"
  ]) {
    const body = functionBody(`public.${name}`, invitationSql);
    assert.match(body, /security definer/);
    assert.match(body, /set search_path = ''/);
    assert.match(body, /private\.require_porra_admin\(\)/);
    assert.match(invitationSql, new RegExp(`revoke execute on function public\\.${name}[^;]+from public, anon, authenticated`));
    assert.match(invitationSql, new RegExp(`grant execute on function public\\.${name}[^;]+to authenticated`));
    assert.doesNotMatch(invitationSql, new RegExp(`grant execute on function public\\.${name}[^;]+to anon`));
    assert.doesNotMatch(body, /execute\s+format|execute\s+immediate/i);
  }
  const createInvitation = functionBody("public.admin_create_pool_invitation", invitationSql);
  assert.match(createInvitation, /admin_user_id := private\.require_porra_admin\(\)/);
  assert.match(createInvitation, /created_by\s*\)\s*values[\s\S]*admin_user_id/);
  assert.doesNotMatch(createInvitation.match(/create function[^)]*\)/i)[0], /created_by/i);
});

test("la llista administrativa aplica precedència i no retorna secrets ni identificadors del pool", () => {
  const listInvitations = functionBody("public.admin_list_pool_invitations", invitationSql);
  const consumedAt = listInvitations.indexOf("when invitation.consumed_at is not null then 'consumed'");
  const revokedAt = listInvitations.indexOf("when invitation.revoked_at is not null then 'revoked'");
  const expiredAt = listInvitations.indexOf("when invitation.expires_at <= pg_catalog.now() then 'expired'");
  const activeAt = listInvitations.indexOf("else 'active'");
  assert.ok(consumedAt > 0 && consumedAt < revokedAt && revokedAt < expiredAt && expiredAt < activeAt);
  const adminProjection = listInvitations.slice(
    listInvitations.indexOf("pg_catalog.jsonb_build_object"),
    listInvitations.indexOf("order by invitation.created_at")
  );
  assert.doesNotMatch(adminProjection, /invitationToken|token_hash|poolId|pool_id|created_by/);
});

test("la nova signatura substitueix l'antiga sense sobrecàrrega i conserva grants públics mínims", () => {
  assert.match(invitationSql, /drop function public\.create_public_reservation\(text, text, text\[\]\)/);
  assert.match(invitationSql, /create function public\.create_public_reservation\(\s*target_pool_id text,\s*participant_name text,\s*selected_cells text\[\],\s*invitation_token text\s*\)/);
  assert.equal((invitationSql.match(/create function public\.create_public_reservation\(/g) || []).length, 1);
  assert.match(invitationSql, /revoke execute on function public\.create_public_reservation\(text, text, text\[\], text\)\s+from public, anon, authenticated/);
  assert.match(invitationSql, /grant execute on function public\.create_public_reservation\(text, text, text\[\], text\)\s+to anon, authenticated/);
  assert.doesNotMatch(invitationSql, /grant execute on function public\.create_public_reservation\(text, text, text\[\]\) to/);
  assert.doesNotMatch(invitationSql, /alter publication|supabase_realtime/);
});

test("el defecte pg_catalog.coalesce queda documentat només a la migració aplicada", () => {
  assert.equal((invitationSql.match(/pg_catalog\.coalesce/g) || []).length, 1);
  assert.ok(laterMigrationSql.some(({ name }) => name === repairMigrationName));
  for (const migration of laterMigrationSql) {
    assert.doesNotMatch(
      migration.sql,
      /pg_catalog\.coalesce/,
      `${migration.name} no pot reintroduir pg_catalog.coalesce`
    );
  }
  assert.match(repairSql, /select coalesce\(\s*pg_catalog\.jsonb_agg\(/);
  assert.match(repairSql, /'\[\]'::jsonb\s*\)/);
});

test("la reparació substitueix exclusivament admin_list_pool_invitations i preserva el contracte", () => {
  const repairedList = functionBody("public.admin_list_pool_invitations", repairSql);
  assert.match(
    repairedList,
    /^create or replace function public\.admin_list_pool_invitations\(target_pool_id uuid\)\s+returns jsonb/i
  );
  assert.equal((repairSql.match(/create(?: or replace)? function/gi) || []).length, 1);
  assert.match(repairedList, /language plpgsql\s+stable\s+security definer\s+set search_path = ''/);
  assert.match(repairedList, /perform private\.require_porra_admin\(\)/);
  assert.match(repairedList, /from public\.pools where id = target_pool_id/);
  assert.match(repairedList, /from private\.pool_invitations invitation/);
  assert.match(repairedList, /pg_catalog\.jsonb_agg/);
  assert.match(repairedList, /pg_catalog\.jsonb_build_object/);

  const consumedAt = repairedList.indexOf("when invitation.consumed_at is not null then 'consumed'");
  const revokedAt = repairedList.indexOf("when invitation.revoked_at is not null then 'revoked'");
  const expiredAt = repairedList.indexOf("when invitation.expires_at <= pg_catalog.now() then 'expired'");
  const activeAt = repairedList.indexOf("else 'active'");
  assert.ok(consumedAt > 0 && consumedAt < revokedAt && revokedAt < expiredAt && expiredAt < activeAt);

  for (const field of ["invitationId", "createdAt", "expiresAt", "consumedAt", "revokedAt", "status"]) {
    assert.match(repairedList, new RegExp(`'${field}'`));
  }
  const projection = repairedList.slice(
    repairedList.indexOf("pg_catalog.jsonb_build_object"),
    repairedList.indexOf("order by invitation.created_at")
  );
  assert.doesNotMatch(projection, /invitationToken|token_hash|poolId|pool_id|created_by/);
  assert.doesNotMatch(repairSql, /create_public_reservation/);
});

test("la reparació només corregeix coalesce i repeteix exactament els permisos mínims", () => {
  const historicalList = functionBody("public.admin_list_pool_invitations", invitationSql);
  const repairedList = functionBody("public.admin_list_pool_invitations", repairSql);
  const expectedRepair = historicalList
    .replace(/^create function/i, "create or replace function")
    .replace("pg_catalog.coalesce", "coalesce");

  assert.equal(normalizeSql(repairedList), normalizeSql(expectedRepair));

  const permissionSql = repairSql.replace(repairedList, "");
  assert.equal(
    normalizeSql(permissionSql),
    normalizeSql(`
      revoke execute on function public.admin_list_pool_invitations(uuid)
        from public, anon, authenticated;
      grant execute on function public.admin_list_pool_invitations(uuid)
        to authenticated;
    `)
  );
});
