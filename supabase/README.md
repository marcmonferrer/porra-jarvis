# Backend Supabase de Porra Live

Les migracions versionades defineixen el backend compartit de Porra Live i ja estan desplegades a `porra-live-beta`, l’entorn de validació aïllat.

## Estat de migracions desplegades

| Migració local | Versió remota | Descripció |
| --- | --- | --- |
| `migrations/20260810143143_porra_live_v1.sql` | `20260810143143` | Model compartit, RPC transaccionals, RLS, permisos, triggers i Realtime segur. |
| `migrations/20260810144836_add_supabase_foreign_key_indexes.sql` | `20260810144836` | Índexs de claus externes per a unions i accions referencials. |

`porra-live-beta` no és encara un entorn públic: no té administrador, dades, credencials configurades al frontend ni desplegament compartit.

## Arquitectura demo i Supabase

- `DemoRepository` conserva tota la funcionalitat local a `localStorage` amb la clau `porra-live-demo-v1`.
- `SupabaseRepository` s’activa només amb `mode: "supabase"`, URL i publishable key.
- El frontend continua sent estàtic. Carrega `@supabase/supabase-js@2.111.0` des d’un URL ESM fixat.
- Les reserves i lectures públiques passen exclusivament per RPC.
- L’administració utilitza Supabase Auth, RLS i RPC transaccionals per a les operacions compostes.

## Model d’autorització

Ser autenticat no converteix ningú en administrador. L’única font d’autorització és una fila a `public.admin_profiles` amb `user_id = auth.uid()`.

No s’utilitzen `user_metadata`, `app_metadata` ni `auth.role()`. Les RPC administratives criden `private.require_porra_admin()` abans de llegir o modificar dades. Les funcions privilegiades utilitzen `search_path = ''`, noms qualificats i `EXECUTE` revocat a `PUBLIC`.

## Matriu de permisos

| Rol | Accés directe | RPC |
| --- | --- | --- |
| `anon` | `SELECT` exclusivament sobre `pool_revisions`, protegit per RLS | `create_public_reservation`, `get_public_pool_state`, `get_tracking_state` |
| `authenticated` sense perfil | Mateixa revisió pública; RLS denega les taules administratives | Les tres RPC públiques; les RPC administratives rebutgen la petició |
| `authenticated` amb `admin_profiles` | CRUD de les taules operatives, limitat per RLS | RPC públiques i `admin_update_reservation`, `admin_update_match`, `admin_finalize_pool` |
| servidor privilegiat | Només per a configuració operativa controlada | No arriba mai al navegador |

RLS està activat a totes les taules de `public`. `GRANT` controla si el rol pot arribar a l’objecte i RLS controla les files que pot veure o modificar.

## RPC

Públiques:

- `create_public_reservation`: reserva transaccional amb bloquejos per casella, límits de capacitat, tancament i fase.
- `get_public_pool_state`: estat sanejat sense UUID, tracking, correu, telèfon, instruccions de pagament ni reserves pendents identificables.
- `get_tracking_state`: estat individual protegit pel token aleatori; a la base només se’n conserva el hash SHA-256.

Administratives i atòmiques:

- `admin_update_reservation`: actualitza nom i totes les seleccions o reverteix completament.
- `admin_update_match`: actualitza marcador i especials en una sola transacció.
- `admin_finalize_pool`: valida fase, pendents, pot i premis; desa resultats i finalitza la porra en una sola transacció.

## Realtime segur

`pool_revisions` és l’única taula publicada a `supabase_realtime`. El payload conté només:

- `pool_slug` públic;
- `revision`;
- `is_public`;
- `updated_at`.

No publica apostes, participants, UUID, pagaments, tokens, marcadors ni premis. Triggers incrementen atòmicament la revisió quan canvien porra, especials, participants, apostes, partit o premis. El navegador escolta la revisió de l’slug actiu i torna a carregar l’estat mitjançant `get_public_pool_state`. El repositori elimina el canal en canviar de porra i reconnecta després d’errors o timeouts.

## Dades públiques i privades

Públiques:

- configuració visible de la porra, equips, horaris i especials;
- ocupació agregada per casella;
- mètriques agregades;
- resultats i noms o àlies introduïts voluntàriament pels guanyadors pagats.

Privades:

- UUID de participants i apostes;
- hash i token de tracking;
- estat individual pendent de pagament;
- instruccions de pagament, excepte després de crear una reserva o dins del tracking privat;
- perfils administratius i dades internes de premis.

No s’han d’introduir telèfons, comptes personals ni altra informació sensible a les instruccions de pagament de la beta.

## Variables d’entorn

Frontend públic:

- `mode`;
- `supabaseUrl`;
- `supabasePublishableKey`.

No s’ha d’enviar mai al navegador cap secret, contrasenya, `service_role` o secret key.

## API-Football

API-Football queda completament desactivada per a la beta. No hi ha cap cron actiu i no s’ha de desplegar `functions/sync-live-score` ni configurar `API_FOOTBALL_KEY`, `SYNC_SECRET` o `SUPABASE_SERVICE_ROLE_KEY`.

## Requisit antiabús pendent

La base garanteix integritat i concurrència, però encara no limita quantes reserves pot intentar crear una mateixa persona o IP. Una mesura antiabús —invitació, CAPTCHA o rate limit— és un requisit bloquejant abans del desplegament compartit de la beta.

## Properes fases de `porra-live-beta`

1. Disposar de Supabase CLI i Docker locals per validar les migracions en una base descartable.
2. Amb aprovació explícita, crear comptes Auth de prova i validar rols, concurrència, RLS, Realtime i privacitat amb dades sintètiques.
3. Amb una aprovació separada, crear l’únic administrador i afegir el seu UUID a `admin_profiles` des d’un entorn privilegiat.
4. Configurar al frontend únicament la URL i la publishable key del projecte de validació.
5. Implementar una mesura antiabús abans de qualsevol beta compartida.
6. Repetir la validació completa abans d’un desplegament públic.

No s’ha de connectar el frontend, crear usuaris o dades, ni desplegar públicament sense una aprovació posterior expressa. `finalissima-porra` queda fora d’aquest flux.
