# Match Preview V1

## Estat del checkpoint

Implementació exclusivament local a `feature/match-preview-v1`. La migració `20260824072852_add_match_previews.sql`, l’Edge Function `refresh-match-preview` i `API_FOOTBALL_KEY` no s’han aplicat, desplegat ni configurat a cap projecte Supabase. No s’ha creat ni modificat cap dada remota.

## Validació local del checkpoint

- `npm test`: 128/128 proves superades.
- `npm run check`: superat per tots els mòduls JavaScript del frontend i el normalitzador compartit.
- `git diff --check`: superat; els fitxers nous també s’han comprovat per whitespace i newline final.
- Servidor estàtic: HTTP 200 a localhost.
- Secrets i artefactes: zero patrons de credencial real, zero logs/persistència nous i zero artefactes sospitosos.
- PostgreSQL/Deno real: no executat perquè l’entorn no té Docker, Podman ni Deno, i no s’ha instal·lat infraestructura nova.
- QA visual i consola: superat amb `playwright-core` del runtime local i Chrome instal·lat, contextos aïllats i dades demo deterministes servides només a localhost. S’han inspeccionat les captures de vista pública amb i sense prèvia a 1440 × 1000, vista pública amb prèvia a 390 × 844 i administració a 1440 × 1000.
- Telemetria de la passada visual: zero errors de consola, zero excepcions no capturades, zero requests fallides, zero respostes HTTP locals fallides, zero crides a Supabase i zero crides al proveïdor. Les peticions preexistents de l’avatar públic s’han interceptat localment, sense trànsit extern.
- Interaccions verificades: tabs administratives, càrrega, èxit, error sanejat amb snapshot anterior preservat, una sola operació davant clic duplicat i cooldown de 45 segons. Desktop i mòbil no presenten overflow horitzontal.
## Decisió de proveïdor

S’ha triat API-Football v3 per a la V1 perquè el repositori ja en conserva una integració de referència amb el mateix host i capçalera, i la pàgina oficial del pla declara accés a totes les competicions i endpoints amb 100 peticions diàries. La verificació de la temporada activa de La Liga continua pendent: el pla gratuït limita les temporades disponibles i no hi ha cap credencial local segura amb què confirmar-la.

football-data.org v4 s’ha descartat com a fallback inicial. La seva cobertura oficial inclou La Liga al tier gratuït i permet classificació i partits, però afegir un segon contracte augmentaria superfície i complexitat; a més, el detall de golejadors requereix el complement Deep Data. Si API-Football no cobreix la temporada necessària, caldrà una nova decisió explícita abans d’implementar un fallback.

## Contracte del snapshot

`public.pools.match_preview` és `jsonb` nullable. Les porres existents continuen sent vàlides. El snapshot privat normalitzat té un màxim de 32 KiB i aquesta forma versionada:

- `version`: `"1"`;
- `provider`: `"api-football"`;
- `providerFixtureId`, `competitionId`: IDs necessaris per traçabilitat administrativa, mai públics;
- `competitionName`, `season`, `fetchedAt`, `kickoffAt`;
- `homeTeam`, `awayTeam`: ID intern del proveïdor, nom, escut HTTPS opcional, classificació opcional, forma W/D/L de fins a cinc partits, dos resultats competitius recents i referència ofensiva opcional;
- `warnings`: fins a cinc avisos de dades parcials;
- `source`: etiqueta i URL canòniques.

No es desa cap resposta crua, cap capçalera, quota, paràmetre de petició, clau, token, UUID de Supabase, participant, pagament ni dada d’un altre flux.

`get_public_pool_state` reconstrueix una whitelist separada. El públic no rep cap ID de fixture, competició, equip o jugador; només noms, context esportiu, temps del snapshot, avisos i font. El tracking reutilitza aquesta mateixa projecció i continua afegint únicament les instruccions de pagament protegides pel token privat.

## Flux segur

1. L’administrador autenticat prem `Carregar prèvia automàtica` o `Actualitzar prèvia`.
2. `supabase-js` invoca l’Edge Function amb la sessió JWT normal; el navegador no coneix el secret del proveïdor.
3. La funció valida format, JWT i una fila positiva a `admin_profiles` abans de consultar la porra o el proveïdor.
4. La funció usa `SUPABASE_ANON_KEY` més el JWT de l’usuari, de manera que la lectura i l’actualització continuen sota RLS. No usa `service_role`.
5. Es resolen els dos equips per nom normalitzat i s’exigeix una única fixture amb IDs, localia i hora dins de 30 minuts. Zero o múltiples coincidències fallen; no s’endevina cap partit.
6. S’executen com a màxim set crides, sense reintents ni polling, amb timeout de 8 segons per petició.
7. Només després d’obtenir i normalitzar el snapshot s’actualitza la porra. Qualsevol error anterior deixa intacta la còpia existent.
8. El trigger existent de `pools` incrementa `pool_revisions`; les visites públiques tornen a carregar l’RPC. Realtime no publica cap taula ni payload nou.

La UI i la funció apliquen un cooldown de 45 segons. El límit de la instància de l’Edge Function és una defensa operativa de millor esforç; no és un rate limit global distribuït.

## Comportament degradat

- Sense snapshot: la vista pública no mostra una targeta buida i la resta de la porra funciona.
- Classificació, recents o golejador no disponibles: el snapshot es desa amb avisos i sense inventar dades.
- Timeout, 429, equip/fixture ambigu, error del proveïdor o error de desament: es mostra un missatge sanejat, es conserva l’últim snapshot i els fluxos de reserva, tracking, directe i premis no es bloquegen.
- Snapshot de més de sis hores: la UI el marca com a antic, però el manté visible com a context informatiu.
- Mode demo: `DemoRepository` genera una fixture sintètica determinista i no fa crides de xarxa.

## Configuració futura

Quan hi hagi una autorització separada:

1. Obtenir una clau d’API-Football des del compte del proveïdor.
2. Confirmar manualment al dashboard o amb una consulta segura que el pla cobreix La Liga i la temporada activa.
3. Configurar `API_FOOTBALL_KEY` exclusivament com a secret de Supabase Functions. No escriure’n cap valor a `.env.example`, `config.public.js`, GitHub Actions, logs ni captures.
4. Aplicar primer la migració al projecte beta autoritzat i verificar historial, CHECK, grants, RLS i contracte públic.
5. Desplegar només `refresh-match-preview` amb verificació JWT activa.
6. Provar admin, no-admin, anon, errors 429/timeout, conservació del snapshot, Realtime i advisors abans de publicar frontend.

## Fonts oficials consultades

- API-Football pricing: <https://www.api-football.com/pricing/>
- football-data.org pricing: <https://www.football-data.org/pricing>
- football-data.org coverage: <https://www.football-data.org/coverage>
- Supabase Edge Functions auth: <https://supabase.com/docs/guides/functions/auth>

## Riscos pendents

- Cobertura real de la temporada activa de La Liga al pla gratuït d’API-Football, no verificable sense credencial.
- Els noms lliures configurats a una porra poden no coincidir exactament amb el proveïdor; la V1 falla de manera segura i demana corregir el nom, en lloc d’endevinar.
- El cooldown de runtime no és distribuït entre instàncies. Un rate limit global requeriria estat addicional i queda fora d’aquesta migració mínima.
- No hi ha validació PostgreSQL real local perquè no s’instal·larà infraestructura nova; cal executar la migració en una base descartable o beta només amb una autorització posterior.
