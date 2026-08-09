# Porra Live

Porra Live és una aplicació reutilitzable per crear, publicar i gestionar porres de diferents partits. L’administrador configura cada edició i els participants hi juguen sense registrar-se.

La versió actual inclou un mode demo local complet i deixa preparat el backend compartit amb Supabase. Encara no s’ha desplegat aquesta versió.

## Funcionalitats

### Administració

- Crear i editar múltiples porres.
- Configurar equips, imatges, horaris, preus, instruccions de pagament i quatre apostes especials.
- Publicar, tancar i reobrir participacions.
- Confirmar pagaments, alliberar reserves i corregir noms o apostes.
- Actualitzar manualment el marcador, la fase, el minut, el descans, el resultat final i els especials.
- Revisar i publicar premis definitius.
- Consultar l’historial de porres.

### Participants

- Participació sense compte.
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
- `src/repository.js`: adaptadors demo i Supabase.
- `src/app.js`: fluxos i interfície.
- `supabase/migrations/`: esquema versionat, funcions transaccionals i RLS.
- `supabase/functions/sync-live-score/`: integració opcional amb API-Football.
- `tests/`: proves del motor i de les proteccions de dades.

`app.js`, `demo.js` i `supabase/live-match.sql` es conserven només com a referència del prototip anterior i ja no són carregats per `index.html`.

## Executar localment

Requereix Node.js 20 o posterior. No cal instal·lar dependències.

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

`config.public.js` activa per defecte `mode: "demo"`.

- Les dades es desen a `localStorage` amb la clau `porra-live-demo-v1`.
- El mode queda identificat amb una franja groga permanent.
- No comparteix dades entre navegadors o dispositius.
- No processa pagaments reals.
- La sessió d’administració és simulada.

El mode demo és una eina de prova; no s’ha d’utilitzar com a font de veritat d’una porra real.

## Configuració de Supabase

1. Crea un projecte Supabase.
2. Aplica `supabase/migrations/202608090001_porra_live_v1.sql` amb `supabase db push`.
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

- Supabase Auth només s’utilitza per a l’administrador.
- Els participants no creen compte.
- Les reserves públiques entren per l’RPC transaccional `create_public_reservation`.
- L’RPC utilitza bloquejos de transacció per impedir una tercera ocupació simultània.
- La base de dades limita dues apostes actives per participant i dues places per casella.
- El públic no pot modificar pagaments, resultats ni premis.
- L’enllaç privat conté un token aleatori; a la base de dades només se’n desa el hash SHA-256.
- Les dades personals de participants no formen part de les publicacions Realtime.
- No hi ha telèfons, Bizum, credencials ni secrets personals al repositori.

Les instruccions de pagament són dades de cada porra i s’han de configurar des del panell d’administració.

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

La funció `sync-live-score` és opcional, rep un `poolId` i un `fixtureId` explícits i utilitza secrets exclusivament del servidor. No busca partits automàticament, no té cap cron actiu i una fallada del proveïdor no bloqueja la porra.

## Desplegament

El frontend es pot publicar com a web estàtica a GitHub Pages. Abans de desplegar el mode real:

1. Aplica i valida les migracions.
2. Configura l’administrador i la configuració pública.
3. Executa totes les proves.
4. Revisa RLS i els fluxos anònims.
5. Publica només després d’haver verificat que no hi ha dades personals ni secrets.

No cal activar l’Edge Function ni API-Football per a la primera publicació.

## Autor

**Marc Monferrer** — AI Consultant & Front-End Developer

[LinkedIn](https://www.linkedin.com/in/marcmonferrer/) · [marcmonferrer.ai@gmail.com](mailto:marcmonferrer.ai@gmail.com)
