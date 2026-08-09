# Sincronització opcional amb API-Football

Aquesta Edge Function és opcional. El control manual de Porra Live funciona sense proveïdor esportiu i continua disponible si l’API falla.

La funció no busca ni inventa partits. Cal configurar explícitament l’identificador `fixtureId` d’API-Football per a cada porra i invocar-la amb:

- `poolId`: UUID de la porra.
- `fixtureId`: opcional quan ja està guardat a `match_states.provider_fixture_id`.
- Capçalera privada `x-sync-secret`.

Secrets exclusivament del servidor:

- `API_FOOTBALL_KEY`
- `SYNC_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_URL`

No s’inclou ni s’activa cap cron. Si en el futur se’n configura un, ha de limitar-se a la finestra del partit i llegir `SYNC_SECRET` des de Supabase Vault.
