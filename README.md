# Porra Live

Porra Live és una aplicació reutilitzable per crear, publicar i gestionar porres de diferents partits. L’administrador configura cada edició i els participants hi juguen sense registrar-se.

La versió actual inclou un mode demo local complet i deixa preparat el backend compartit amb Supabase. Encara no s’ha desplegat aquesta versió.

## Funcionalitats

### Administració

- Crear i editar múltiples porres.
- Generar, consultar i revocar invitacions individuals d’un sol ús.
- Configurar equips, imatges, horaris, preus, instruccions de pagament i quatre apostes especials.
- Publicar, tancar i reobrir participacions.
- Confirmar pagaments, alliberar reserves i corregir noms o apostes.
- Actualitzar manualment el marcador, la fase, el minut, el descans, el resultat final i els especials.
- Revisar i publicar premis definitius.
- Consultar l’historial de porres.

### Participants

- Participació sense compte.
- Accés mitjançant una invitació individual d’un sol ús en mode Supabase.
- Una o dues apostes diferents per participant.
- Dues places independents per casella.
- Resum del cost i de l’import destinat al pot abans de confirmar.
- Reserva indefinida pendent de verificar pagament.
- Enllaç privat per recuperar i seguir la participació des d’un altre dispositiu en mode Supabase.
- Premi provisional i definitiu per aposta.

## Arquitectura

Porra Live continua sent un frontend estàtic i responsive, sense procés de compilació obligatori:

- `index.html`: shell i perfil públic.
- `styles.css`: sistema visual responsive.
- `social-card-porra-live.png`: previsualització social de la nova identitat.
- `src/core.js`: regles de negoci, capacitat i motor de premis.
- `src/repository.js`: adaptadors demo i Supabase, amb `supabase-js` fixat a `2.111.0`.
- `src/app.js`: fluxos i interfície.
- `supabase/migrations/`: esquema versionat, funcions transaccionals i RLS.
- `supabase/functions/sync-live-score/`: integració opcional amb API-Football.
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
- Les reserves públiques entren per l’RPC transaccional `create_public_reservation` i requereixen una invitació individual vàlida.
- Cada invitació conté un token aleatori de 256 bits que només es mostra en generar-la; la base només en desa el hash SHA-256.
- Una invitació permet crear exactament una participació i queda consumida dins de la mateixa transacció.
- L’RPC utilitza bloquejos de transacció per impedir una tercera ocupació simultània.
- La base de dades limita dues apostes actives per participant i dues places per casella.
- El públic no pot modificar pagaments, resultats ni premis.
- L’enllaç privat conté un token aleatori; a la base de dades només se’n desa el hash SHA-256.
- Realtime publica només `pool_revisions`, amb slug, revisió i timestamp; no publica apostes, participants, UUID, pagaments, marcadors ni premis.
- Les operacions compostes `updateReservation`, `updateMatch` i `finalizePool` passen per RPC administratives atòmiques.
- No hi ha telèfons, Bizum, credencials ni secrets personals al repositori.

Les instruccions de pagament són privades: només es retornen després de reservar o amb el tracking individual. No hi introduïu telèfons ni comptes personals per a la beta.

Les migracions antiabús invite-only `20260811102102_add_pool_invitations.sql` i `20260811104810_fix_pool_invitation_listing.sql` estan aplicades una sola vegada a `porra-live-beta`; la segona repara additivament el `pg_catalog.coalesce` històric sense modificar la migració aplicada.

La matriu remota completa està validada amb PostgreSQL real: permisos admin/no-admin, tokens i hashes, errors uniformes, tracking privat, rollback, consum únic i les concurrències d’invitació, revocació i última plaça. Els advisors no mostren regressions i la neteja final confirma zero comptes o dades sintètiques residuals. El frontend local ja està integrat exclusivament amb el backend invite-only de la beta; no s’ha desplegat. Turnstile i el rate limit continuen fora de l’abast actual.

### Flux d’invitació del frontend

- El participant obre un enllaç `?pool=<slug>#invite=<token>`; el fragment es valida, es copia a memòria i s’elimina immediatament amb `history.replaceState`.
- El token no entra a `localStorage`, `sessionStorage`, cookies, estat persistent, logs ni telemetria. La política de referrer és `no-referrer`.
- La reserva queda desactivada sense invitació i el token només s’envia com a quart argument de `create_public_reservation`.
- Després d’un èxit, una invitació invàlida o un error terminal de porra/fase, la còpia en memòria s’elimina. Els errors d’invitació mostren sempre el mateix missatge públic.
- El token de tracking i `paymentInstructions` conserven el comportament privat existent.
- A Administració, la pestanya Invitacions crea, llista i revoca invitacions. El secret només apareix en la resposta de creació, dins de l’enllaç copiable i compartible per WhatsApp; els llistats només mostren dates i estat.

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

## API-Football

El control manual funciona completament sense API externa.

La funció `sync-live-score` es conserva com a referència opcional, però API-Football queda completament desactivada per a la beta: no es desplega la funció, no hi ha cap cron i no es configuren els seus secrets.

## Desplegament

El frontend es pot publicar com a web estàtica a GitHub Pages. Abans de desplegar el mode real:

1. Aplica i valida les migracions primer en una base local descartable.
2. Configura l’administrador i la configuració pública.
3. Executa totes les proves.
4. Revisa RLS i els fluxos anònims.
5. Publica només després d’haver verificat que no hi ha dades personals ni secrets.

No s’ha d’activar l’Edge Function ni API-Football per a la beta. El procés complet, la matriu de permisos i els controls previs es documenten a [supabase/README.md](supabase/README.md).

## Autor

**Marc Monferrer** — AI Consultant & Front-End Developer

[LinkedIn](https://www.linkedin.com/in/marcmonferrer/) · [marcmonferrer.ai@gmail.com](mailto:marcmonferrer.ai@gmail.com)
