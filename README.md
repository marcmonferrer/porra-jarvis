# Porra JARVIS

Porra JARVIS és una aplicació reutilitzable per crear, publicar i gestionar porres de diferents partits. L’administrador configura cada edició i els participants hi juguen sense registrar-se.

La versió actual inclou un mode demo local complet i un backend compartit amb Supabase. La prèvia estàndard és manual; la integració API-Football es conserva només com a experiment de backend i la UI normal no la invoca.

## Funcionalitats

### Administració

- Crear i editar múltiples porres.
- Crear un únic enllaç reutilitzable per porra, consultar-ne l’estat agregat i revocar-lo o rotar-lo; les invitacions individuals antigues continuen compatibles.
- Configurar equips, imatges, horaris, preus, instruccions de pagament i quatre apostes especials.
- Publicar, tancar i reobrir participacions.
- Confirmar pagaments, alliberar reserves i corregir noms o apostes.
- Actualitzar manualment el marcador, la fase, el minut, el descans, el resultat final i els especials.
- Carregar manualment una prèvia automàtica opcional i reutilitzar-ne la darrera instantània segura.
- Revisar i publicar premis definitius.
- Consultar l’historial de porres.

### Participants

- Participació sense compte.
- Accés mitjançant l’enllaç privat reutilitzable de la porra en mode Supabase.
- Una o dues apostes diferents per participant.
- Dues places independents per casella.
- Resum del cost i de l’import destinat al pot abans de confirmar.
- Reserva indefinida pendent de verificar pagament.
- Enllaç privat per recuperar i seguir la participació des d’un altre dispositiu en mode Supabase.
- Premi provisional i definitiu per aposta.

## Arquitectura

Porra JARVIS continua sent un frontend estàtic i responsive, sense procés de compilació obligatori:

- `index.html`: shell i perfil públic.
- `styles.css`: sistema visual responsive.
- `social-card-porra-live.png`: previsualització social; el nom de fitxer es conserva per compatibilitat amb la URL publicada.
- `src/core.js`: regles de negoci, capacitat i motor de premis.
- `src/repository.js`: adaptadors demo i Supabase, amb `supabase-js` fixat a `2.111.0`.
- `src/match-preview.js`: presentació pública accessible dels snapshots automàtics i manuals.
- `src/manual-match-preview.js`: parser, validació i estat de l’editor de prèvia assistida.
- `src/app.js`: fluxos i interfície.
- `supabase/migrations/`: esquema versionat, funcions transaccionals i RLS.
- `supabase/functions/refresh-match-preview/`: prèvia sota demanda amb JWT, autorització administrativa i API-Football.
- `supabase/functions/sync-live-score/`: referència antiga desactivada; no forma part del flux de prèvia.
- `tests/`: proves del motor i de les proteccions de dades.

`app.js`, `demo.js` i `supabase/live-match.sql` es conserven només com a referència del prototip anterior i ja no són carregats per `index.html`.

## Executar localment

Requereix Node.js 20 o posterior. Instal·la les dependències fixades del projecte amb:

```bash
npm install
```

La CLI estable de Supabase és una dependència de desenvolupament local fixada. Utilitza sempre `npx supabase`; no cal ni s’ha d’instal·lar globalment.

```bash
npm start
```

Obre:

```text
http://127.0.0.1:4173/
```

Per executar les proves:

```bash
npm test
npm run check
```

## Mode demo

El mode demo continua disponible injectant `mode: "demo"` en lloc de la configuració beta de `config.public.js`.

- Les dades es desen a `localStorage` amb la clau `porra-live-demo-v1`.
- El mode queda identificat amb una franja groga permanent.
- No comparteix dades entre navegadors o dispositius.
- No processa pagaments reals.
- La sessió d’administració és simulada.

El mode demo és una eina de prova; no s’ha d’utilitzar com a font de veritat d’una porra real.

## Configuració de Supabase

El frontend local queda restringit explícitament a `porra-live-beta` (`vczrkalsqdzwitpqwdwc`). `config.public.js` conté únicament la URL del projecte i la seva clau `publishable`, que és pública per disseny; el repositori rebutja qualsevol altra URL Supabase. No s’hi inclou cap `service_role`, secret key ni credencial administrativa.

En mode Supabase, les porres noves s’insereixen sense `id` perquè PostgreSQL generi l’UUID natiu; el frontend adopta exclusivament l’UUID retornat. Els identificadors locals amb prefix `pool-` es generen i s’accepten només dins de `DemoRepository`, i totes les operacions administratives Supabase validen els UUID abans de fer cap crida remota.

La hidratació administrativa de porres especifica explícitament `special_bets_pool_id_fkey` en l’embed PostgREST. Això conserva totes les apostes especials i evita l’ambigüitat amb altres relacions entre `pools` i `special_bets`; llistat, edició, historial, apostes, directe i premis comparteixen aquesta única càrrega.

1. Crea un projecte Supabase.
2. Valida totes les migracions de `supabase/migrations/` en una base local descartable i aplica-les després amb `supabase db push`.
3. Crea l’únic compte administrador a Supabase Auth.
4. Insereix el seu UUID a `public.admin_profiles` des d’un entorn de servidor o el SQL Editor.
5. Injecta al frontend la configuració pública basada en `config.example.js`:
   - `mode: "supabase"`;
   - `supabaseUrl`;
   - `supabasePublishableKey`.
6. Verifica RLS des d’una sessió anònima abans de desplegar.

La clau `publishable` és pública per disseny. Mai no s’han d’exposar `service_role`, contrasenyes, claus d’API o secrets de sincronització.

Consulta [supabase/README.md](supabase/README.md) per al model i el desplegament del backend.

## Seguretat i privacitat

- Supabase Auth només s’utilitza per a l’administrador i l’autorització depèn exclusivament de `admin_profiles`.
- Els participants no creen compte.
- Les reserves públiques entren per RPC transaccional i requereixen un enllaç reutilitzable o una invitació individual legacy vàlids.
- Cada invitació conté un token aleatori de 256 bits que només es mostra en generar-la; la base només en desa el hash SHA-256.
- L’enllaç reutilitzable no es consumeix: cada reserva correcta incrementa només un comptador agregat. Les invitacions individuals legacy continuen consumint-se una vegada.
- L’RPC utilitza bloquejos de transacció per impedir una tercera ocupació simultània.
- La base de dades limita dues apostes actives per participant i dues places per casella.
- El públic no pot modificar pagaments, resultats ni premis.
- L’enllaç privat conté un token aleatori; a la base de dades només se’n desa el hash SHA-256.
- Les reserves noves poden retornar una capacitat personal de 256 bits, diferent de l’enllaç d’invitació: el navegador la conserva per porra per recuperar «La meva aposta», mentre PostgreSQL només en desa SHA-256.
- Realtime publica només `pool_revisions`, amb slug, revisió i timestamp; no publica apostes, participants, UUID, pagaments, marcadors ni premis.
- Les operacions compostes `updateReservation`, `updateMatch` i `finalizePool` passen per RPC administratives atòmiques.
- No hi ha telèfons, Bizum, credencials ni secrets personals al repositori.

Les instruccions de pagament són privades: només es retornen després de reservar o amb el tracking individual. No hi introduïu telèfons ni comptes personals per a la beta.

Les migracions antiabús invite-only `20260811102102_add_pool_invitations.sql` i `20260811104810_fix_pool_invitation_listing.sql` estan aplicades una sola vegada a `porra-live-beta`; la segona repara additivament el `pg_catalog.coalesce` històric sense modificar la migració aplicada.

La matriu remota completa està validada amb PostgreSQL real: permisos admin/no-admin, tokens i hashes, errors uniformes, tracking privat, rollback, consum únic i les concurrències d’invitació, revocació i última plaça. Els advisors no mostren regressions i la neteja final confirma zero comptes o dades sintètiques residuals. El frontend invite-only ja està integrat amb el backend de la beta; la prèvia automatitzada continua exclusivament local i no s’ha desplegat. Turnstile i el rate limit continuen fora de l’abast actual.

### Flux d’invitació del frontend

- El participant obre un enllaç `?pool=<slug>#invite=<token>`; el fragment es valida, es copia a memòria i s’elimina immediatament amb `history.replaceState`.
- El token no entra a `localStorage`, `sessionStorage`, cookies, estat persistent, logs ni telemetria. La política de referrer és `no-referrer`.
- La reserva queda desactivada sense invitació i el token només s’envia com a quart argument de `create_public_reservation`.
- Després d’un èxit, una invitació invàlida o un error terminal de porra/fase, la còpia en memòria s’elimina. Els errors d’invitació mostren sempre el mateix missatge públic.
- El token de tracking i `paymentInstructions` conserven el comportament privat existent.
- A Administració, la pestanya Invitacions crea, llista i revoca invitacions. El secret només apareix en la resposta de creació, dins de l’enllaç copiable i compartible per WhatsApp; els llistats només mostren dates i estat.

### Recuperació personal de l’aposta (només local, pendent d’activació)

- Una reserva nova genera atòmicament una capacitat independent de 32 bytes i la retorna una sola vegada com a fragment `?pool=<slug>#mybet=<token>`.
- El fragment es llegeix abans d’inicialitzar el repositori, es desa per slug a `localStorage` amb la clau `porra-jarvis-personal-bet-links-v1` i s’elimina immediatament de l’URL visible amb `history.replaceState`.
- La base només desa SHA-256 a `private.participant_recovery_tokens`, amb RLS, sense grants directes i amb una sola capacitat activa per participant i porra.
- `get_personal_bet_state` és una lectura allowlisted: retorna només la porra, el nom voluntari, les apostes pròpies, l’estat de pagament, el partit, els premis i les instruccions de pagament protegides. No retorna UUID, hashes, secrets ni dades d’altres participants.
- Token mal format, desconegut, revocat, expirat o d’una altra porra produeix el mateix missatge públic. Les reserves i tokens de tracking anteriors continuen funcionant sense backfill.
- L’enllaç reutilitzable `#invite=` autoritza crear una participació; l’enllaç personal `#mybet=` només permet consultar la participació ja creada i no substitueix mai la invitació.

La migració `20260830084619_add_personal_bet_recovery_links.sql` és la desena migració local i encara no s’ha aplicat a `porra-live-beta`. Fins a una activació remota separada, beta continua alineada 9/9 i el frontend de recuperació no s’ha de publicar.

### Activació futura dels enllaços personals

1. Enllaçar la CLI exclusivament a `vczrkalsqdzwitpqwdwc` i confirmar la identitat del projecte.
2. Executar `npx supabase migration list` i `npx supabase db push --dry-run`; l’única migració pendent ha de ser `20260830084619_add_personal_bet_recovery_links.sql`.
3. Revisar de nou RLS, grants, signatures i diff; aplicar una sola vegada amb `npx supabase db push` només amb una autorització separada.
4. Validar en transaccions rollback-only token/hash, aïllament, errors uniformes, rollback i concurrència; executar advisors i confirmar zero residus.
5. Només després de la validació remota, publicar el frontend i provar recuperació en el mateix navegador i en un altre dispositiu.

### Canvi de nom extern pendent

La identitat de producte és **Porra JARVIS**, però aquesta fase conserva el repositori `marcmonferrer/finalissima-porra`, el remote Git existent i la ruta pública `https://marcmonferrer.github.io/finalissima-porra/`. En una versió futura i separada:

1. reservar i validar el slug desitjat `porra-jarvis`;
2. inventariar enllaços del portfolio, README, invitacions guardades i metadades socials;
3. preparar compatibilitat per als enllaços antics —redirect explícit o domini estable— abans de canviar la URL de GitHub Pages;
4. reanomenar el repositori a GitHub, actualitzar el remote local i verificar clone/fetch/push;
5. actualitzar la base de Pages, el canonical, el social card i els enllaços del portfolio/README;
6. provar tant la URL nova com el comportament de tots els enllaços antics abans de retirar cap compatibilitat.

## Regles de preus i capacitat

Valors per defecte:

- Preu: 4,00 € per aposta.
- Pot: 3,50 € per aposta.
- Gestió: 0,50 € per aposta.
- 25 caselles × 2 places = 50 apostes màximes.

Amb 50 apostes pagades: 200 € recaptats, 175 € de pot i 25 € de gestió.

Només les apostes pagades formen part del pot confirmat i poden guanyar premis.

## Regles dels premis

El pot confirmat més l’acumulat anterior es divideix així:

- 25% per al resultat exacte al descans.
- 50% per al resultat exacte final.
- 25% per a les apostes especials complertes.

El repartiment es fa per aposta guanyadora. Si dues apostes pagades ocupen la mateixa casella guanyadora, totes dues compten.

Redistribució:

1. Una franja de descans o especials sense guanyadors passa al resultat final.
2. Si no hi ha guanyador final, la franja final disponible es reparteix entre totes les apostes guanyadores del descans i dels especials.
3. Si no hi ha cap aposta guanyadora, el 100% queda acumulat.

Els càlculs es fan en cèntims. Les restes es distribueixen amb el mètode de la resta més gran i un ordre estable: descans, final i especials. Dins d’una franja, els cèntims sobrants s’assignen per identificador d’aposta ordenat. La suma dels premis sempre coincideix exactament amb el pot.

## Prèvia assistida del partit

L’administració estàndard ofereix un únic flux manual: Marc enganxa un bloc `LOCAL / VISITANT`, el valida i previsualitza al navegador, i el desa amb la sessió autenticada i la RLS administrativa existent. La vista pública mostra una targeta compacta abans de la graella amb els noms i escuts configurats, d’un a quatre punts per equip, la font opcional i l’hora d’actualització.

El text no s’interpreta com HTML. El client i PostgreSQL apliquen límits de forma i mida, la URL opcional només pot ser HTTP/HTTPS i `get_public_pool_state` reconstrueix una whitelist. Editar o publicar la porra no esborra `match_preview`.

La funció `refresh-match-preview` i el seu adaptador API-Football es conserven únicament com a experiment de backend. No hi ha cap botó ni ruta estàndard que els invoqui, i el flux manual no necessita la clau del proveïdor.

Consulta [docs/assisted-manual-match-preview.md](docs/assisted-manual-match-preview.md) per al format, el contracte de seguretat i els passos d’activació. [docs/match-preview-v1.md](docs/match-preview-v1.md) es conserva com a registre del prototip automàtic.

## Desplegament

El frontend es pot publicar com a web estàtica a GitHub Pages. Abans de desplegar el mode real:

1. Aplica i valida les migracions primer en una base local descartable.
2. Configura l’administrador i la configuració pública.
3. Executa totes les proves.
4. Revisa RLS i els fluxos anònims.
5. Publica només després d’haver verificat que no hi ha dades personals ni secrets.

El frontend manual només s’ha de publicar després d’aplicar i validar la migració additiva corresponent. L’Edge Function experimental no forma part d’aquesta activació. El procés i els controls previs es documenten a [supabase/README.md](supabase/README.md).

## Autor

**Marc Monferrer** — AI Consultant & Front-End Developer

[LinkedIn](https://www.linkedin.com/in/marcmonferrer/) · [marcmonferrer.ai@gmail.com](mailto:marcmonferrer.ai@gmail.com)


## Enllaç reutilitzable i regles completes (actius a la versió publicada)

Aquest HEAD local afegeix un únic enllaç compartible per porra. El token de 256 bits només es retorna en crear o rotar, viatja al fragment #invite=, i la base només en desa SHA-256. Després d’una recàrrega, Administració mostra estat, data i usos agregats, però mai no recupera el secret. Les invitacions individuals anteriors continuen funcionant.

La vista pública mostra Com funciona la porra abans de la graella i Administració reutilitza el mateix model com a Vista de les regles. El model deriva preu, tancament Europe/Madrid, límits, 25/50/25, especials, pagaments i redistribució de les constants que governen el motor. La nota i el contacte públic són opcionals, acotats i renderitzats com a text pla. Els nou contractes remots d’enllaç reutilitzable, regles configurables i reparació de l’estat de l’enllaç estan actius, validats i alineats a `porra-live-beta`; la seva UI ja forma part de la versió publicada. La migració local de recuperació personal i el rebranding Porra JARVIS continuen pendents d’activació i publicació.
