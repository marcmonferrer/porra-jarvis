# Sincronització desactivada amb API-Football

Aquesta Edge Function es conserva únicament com a referència local. Per a la beta de Porra Live està completament desactivada: no es desplega, no s’invoca, no té cron i no se’n configuren secrets.

La funció no busca ni inventa partits. Cal configurar explícitament l’identificador `fixtureId` d’API-Football per a cada porra i invocar-la amb:

- `poolId`: UUID de la porra.
- `fixtureId`: opcional quan ja està guardat a `match_states.provider_fixture_id`.
- Capçalera privada `x-sync-secret`.

Secrets exclusivament del servidor:

- `API_FOOTBALL_KEY`
- `SYNC_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_URL`

Qualsevol activació futura requerirà una decisió i una revisió de seguretat separades. En aquest cas haurà de limitar-se a la finestra del partit i llegir `SYNC_SECRET` des de Supabase Vault.
