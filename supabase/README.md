# Backend Supabase de Porra Live

La migració versionada `migrations/202608090001_porra_live_v1.sql` crea el model complet de Porra Live.

## Aplicació

Amb Supabase CLI vinculat al projecte:

```bash
supabase db push
```

Després:

1. Crea manualment l’únic usuari administrador a Supabase Auth.
2. Insereix el seu UUID a `public.admin_profiles` mitjançant el SQL Editor o una operació de servidor.
3. Configura al frontend només la URL del projecte i la clau `publishable`.
4. Comprova les polítiques RLS amb un navegador anònim abans de publicar.

## Model

- `admin_profiles`: autorització de l’administrador.
- `pools`: configuració i estat de cada porra.
- `special_bets`: les quatre especials de cada porra.
- `participants`: nom i hash de l’enllaç privat.
- `bets`: una fila per aposta i plaça.
- `match_states` i `special_results`: control del partit.
- `prize_results` i `prize_awards`: càlcul definitiu i imports per aposta.

Les reserves anònimes no escriuen directament a les taules. L’RPC `create_public_reservation` bloqueja transaccionalment cada casella i participant, valida els límits i retorna una única vegada el token privat. Només se’n desa el hash SHA-256.

## Realtime

La migració incorpora `pools`, `bets`, `match_states` i `special_results` a `supabase_realtime`. Les dades personals de `participants` no es publiquen.

## API-Football

`functions/sync-live-score` és opcional i no té cap cron actiu. Requereix secrets de servidor i un `fixtureId` explícit. Qualsevol error queda registrat a `match_states.provider_error` i no bloqueja els controls manuals.
