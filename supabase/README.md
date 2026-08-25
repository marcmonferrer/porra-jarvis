# Backend Supabase de Porra Live

Les migracions versionades defineixen el backend compartit de Porra Live. Les cinc primeres estan aplicades a `porra-live-beta`; la sisena, que afegeix el variant manual de la prèvia, existeix només localment i continua pendent d’autorització remota.

## Estat de migracions

| Migració local | Versió remota | Descripció |
| --- | --- | --- |
| `migrations/20260810143143_porra_live_v1.sql` | `20260810143143` | Model compartit, RPC transaccionals, RLS, permisos, triggers i Realtime segur. |
| `migrations/20260810144836_add_supabase_foreign_key_indexes.sql` | `20260810144836` | Índexs de claus externes per a unions i accions referencials. |
| `migrations/20260811102102_add_pool_invitations.sql` | `20260811102102` | Invitacions privades d’un sol ús, RPC administratives i reserva pública protegida per capacitat secreta. Conserva immutable el defecte històric `pg_catalog.coalesce`. |
| `migrations/20260811104810_fix_pool_invitation_listing.sql` | `20260811104810` | Repara additivament `admin_list_pool_invitations(uuid)` amb `coalesce` SQL vàlid i reasserta els permisos mínims. |
| `migrations/20260824072852_add_match_previews.sql` | `20260824072852` | Afegeix el snapshot nullable, la whitelist pública i conserva RLS, grants i Realtime. |
| `migrations/20260825071626_add_manual_match_previews.sql` | Pendent (només local) | Admet snapshots manuals de fins a 8 KiB i amplia la whitelist pública sense trencar els snapshots automàtics. |

La migració automàtica ja forma part de l’historial beta. Aquesta passada crea només `20260825071626_add_manual_match_previews.sql`: no l’aplica, no modifica migracions anteriors i no toca comptes, dades ni configuració remota.

## Arquitectura demo i Supabase

- `DemoRepository` conserva tota la funcionalitat local a `localStorage` amb la clau `porra-live-demo-v1`.
- `SupabaseRepository` s’activa només amb `mode: "supabase"`, URL i publishable key.
- El frontend continua sent estàtic. Carrega `@supabase/supabase-js@2.111.0` des d’un URL ESM fixat.
- Les reserves i lectures públiques passen exclusivament per RPC. El frontend beta envia la invitació individual únicament al quart argument de la reserva i manté el mode demo desacoblat.
- L’administració utilitza Supabase Auth, RLS i RPC transaccionals per a les operacions compostes.
- La CLI estable de Supabase està fixada com a dependència de desenvolupament local; totes les ordres del repositori s’executen amb `npx supabase`.

## Model d’autorització

Ser autenticat no converteix ningú en administrador. L’única font d’autorització és una fila a `public.admin_profiles` amb `user_id = auth.uid()`.

No s’utilitzen `user_metadata`, `app_metadata` ni `auth.role()`. Les RPC administratives criden `private.require_porra_admin()` abans de llegir o modificar dades. Les funcions privilegiades utilitzen `search_path = ''`, noms qualificats i `EXECUTE` revocat a `PUBLIC`.

## Matriu de permisos

| Rol | Accés directe | RPC |
| --- | --- | --- |
| `anon` | `SELECT` exclusivament sobre `pool_revisions`, protegit per RLS | `create_public_reservation`, `get_public_pool_state`, `get_tracking_state` |
| `authenticated` sense perfil | Mateixa revisió pública; RLS denega les taules administratives | Les tres RPC públiques; totes les RPC administratives rebutgen la petició |
| `authenticated` amb `admin_profiles` | CRUD de les taules operatives, limitat per RLS; cap accés directe a `private.pool_invitations` | RPC públiques, gestió d’invitacions i les RPC administratives existents |
| servidor privilegiat | Només per a configuració operativa controlada | No arriba mai al navegador |

RLS està activat a totes les taules de `public`. `GRANT` controla si el rol pot arribar a l’objecte i RLS controla les files que pot veure o modificar.

## RPC

Públiques:

- `create_public_reservation(target_pool_id, participant_name, selected_cells, invitation_token)`: reserva transaccional amb invitació individual, bloquejos per casella, límits de capacitat, tancament i fase. La resposta conserva el token de tracking i les instruccions de pagament privades.
- `get_public_pool_state`: estat sanejat sense UUID, tracking, correu, telèfon, instruccions de pagament ni reserves pendents identificables.
- `get_tracking_state`: estat individual protegit pel token aleatori; a la base només se’n conserva el hash SHA-256.

Administratives i atòmiques:

- `admin_update_reservation`: actualitza nom i totes les seleccions o reverteix completament.
- `admin_update_match`: actualitza marcador i especials en una sola transacció.
- `admin_finalize_pool`: valida fase, pendents, pot i premis; desa resultats i finalitza la porra en una sola transacció.
- `admin_create_pool_invitation`: genera 32 bytes aleatoris, retorna el token hexadecimal una sola vegada i en desa només el hash SHA-256.
- `admin_list_pool_invitations`: retorna identificador administratiu, dates i estat sanejat sense token, hash, UUID de porra ni `created_by`.
- `admin_revoke_pool_invitation`: revoca atòmicament una invitació encara no consumida.

## Invitacions invite-only

`private.pool_invitations` viu en un esquema no exposat, té RLS activat i no concedeix cap privilegi de taula a `anon` ni `authenticated`. Només les RPC amb grants mínims poden accedir-hi.

Els tokens d’invitació són 32 bytes aleatoris codificats com 64 caràcters hexadecimals lowercase. La base calcula SHA-256 sobre aquest text hexadecimal i només desa el resultat. Els tokens mal formats, inexistents, expirats, revocats, consumits o vinculats a una altra porra produeixen sempre `Invalid invitation`.

La reserva reclama la invitació amb un `UPDATE` condicional abans de crear el participant. El consum, el participant i les apostes formen una única transacció: qualsevol error posterior reverteix també el consum. La revocació administrativa actualitza la mateixa fila amb condicions incompatibles, de manera que consum i revocació competeixen atòmicament.

La signatura anterior de tres arguments s’elimina; no es conserva cap sobrecàrrega. L’estat públic, el tracking privat i la publicació Realtime no canvien. `paymentInstructions` només es retornen després d’una reserva amb invitació vàlida o amb un token secret de tracking vàlid.

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
- UUID, hash i estat intern de les invitacions;
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

## Prèvia manual i experiment API-Football

La UI estàndard desa el variant manual mitjançant una actualització de `public.pools.match_preview` amb el client publishable i la sessió de l’administrador. La política `pools_admin_all` continua imposant l’autorització; no hi ha RPC privilegiada nova ni accés de taula per a anon. El `CHECK` manual limita forma, camps, longituds i mida a 8 KiB, mentre que el contracte automàtic existent de 32 KiB continua sent vàlid.

`private.public_match_preview(jsonb)` separa els dos variants i només projecta els camps aprovats. Realtime continua publicant exclusivament `pool_revisions`; invitacions, tracking i instruccions de pagament no canvien.

`refresh-match-preview` es conserva desplegada a beta com a experiment autenticat, però el frontend estàndard ja no conté cap acció que la invoqui. Activar el flux manual no requereix desplegar la funció, llegir secrets ni consumir peticions d’API-Football. La funció antiga `sync-live-score` també continua fora del flux.

## Control antiabús invite-only

La migració aplicada implementa invitacions individuals d’un sol ús com a control antiabús. No confia en IP, fingerprint, metadades d’usuari ni secrets de servidor al frontend. Turnstile i el rate limit no formen part d’aquesta fase.

La reparació additiva i la matriu remota completa estan validades. La reserva conserva `paymentInstructions`, el tracking les manté dins de `pool.paymentInstructions`, els errors d’invitació són uniformes i les respostes públiques no exposen secrets ni identificadors interns. La neteja posterior va confirmar zero comptes, sessions, perfils administratius, porres, participants, apostes i invitacions sintètiques residuals.

## Validació remota completada

La passada amb dades exclusivament sintètiques confirma:

1. La llista buida retorna exactament `[]` i la llista poblada respecta `consumed`, `revoked`, `expired`, `active` sense secrets.
2. Només l’administrador pot crear, llistar i revocar invitacions; l’usuari autenticat ordinari és rebutjat.
3. Els tokens són hexadecimals lowercase de 64 caràcters, només se’n desa SHA-256 i no es poden reutilitzar.
4. Format incorrecte, uppercase, token desconegut, expirat, revocat, consumit o d’una altra porra retornen `Invalid invitation`.
5. Una reserva fallida per casella plena, tancament o fase no consumeix la invitació i el reintent posterior funciona.
6. Dues peticions amb la mateixa invitació produeixen un sol participant; consum i revocació tenen un sol vencedor; dues peticions per l’última plaça produeixen un èxit i un `Cell is full`.
7. `anon` continua limitat a les tres RPC públiques i `pool_revisions`; Realtime només publica aquesta taula.
8. Els advisors mantenen la línia base coneguda: cap avís de rendiment, cap avís de seguretat nou i només els avisos intencionats de funcions privilegiades i RLS defensiu de la taula privada.

## Properes fases de `porra-live-beta`

1. Amb una aprovació separada, crear l’únic administrador permanent i afegir el seu UUID a `admin_profiles` des d’un entorn privilegiat.
2. Fer les proves manuals de navegador amb un administrador, una porra i invitacions exclusivament sintètiques a `porra-live-beta`.
3. Confirmar còpia i compartició per WhatsApp, consum únic, tracking i instruccions de pagament des de navegadors separats.
4. Repetir la validació completa abans d’un desplegament públic.

El frontend està configurat únicament amb la URL i la clau publishable de `porra-live-beta`; durant aquesta integració de prèvia no s’han creat usuaris ni dades, i el mòdul nou no s’ha desplegat. `finalissima-porra` queda fora d’aquest flux.
