# Prèvia assistida del partit

## Flux de producte

La interfície administrativa normal no invoca API-Football. Marc pot preparar una prèvia amb ChatGPT o una altra font, enganxar un bloc de text petit, previsualitzar-lo i desar-lo. La integració automàtica `refresh-match-preview` es conserva al repositori com a experiment, però no té cap acció accessible des de la UI estàndard.

Format acceptat:

```text
LOCAL:

- Primer punt destacat

VISITANT:

- Primer punt destacat

FONT: Etiqueta opcional
URL: https://exemple.cat/font-opcional
```

Cada equip necessita entre un i quatre punts. Cada punt admet 180 caràcters; el text complet, 4.096; l’etiqueta de font, 120; la URL, 2.048; i el snapshot manual serialitzat, 8 KiB. Només s’accepten URLs `http` o `https` sense credencials.

## Contracte i seguretat

La migració additiva `20260825071626_add_manual_match_previews.sql` amplia el `CHECK` existent de `public.pools.match_preview` amb el variant `provider: "manual"`. Els snapshots `provider: "api-football"` continuen sent vàlids sense cap conversió.

El variant manual desa únicament:

- `version`, `provider` i `fetchedAt`;
- `homeTeam.highlights` i `awayTeam.highlights`;
- `source.label` i `source.url`, si s’han proporcionat.

Els noms i escuts es llegeixen de la configuració de la porra, no es dupliquen al snapshot. `private.public_match_preview(jsonb)` reconstrueix una whitelist i no exposa identificadors del proveïdor, dades de participants, pagaments, credencials ni payloads externs. Les escriptures del frontend són actualitzacions normals de `public.pools` amb la sessió autenticada; la política RLS administrativa existent és l’única autorització i no s’utilitza `service_role`.

El navegador interpreta text pla i el renderitza amb escapament HTML. La URL de font es torna a validar abans de crear un enllaç públic. Sense snapshot no es renderitza cap contenidor buit.

## Activació posterior

Aquesta passada és només local. Per activar-la a beta amb una autorització separada:

1. Confirmar que l’arbre de treball publicat conté exclusivament la migració nova pendent.
2. Executar `npx supabase migration list` i `npx supabase db push --dry-run` contra `vczrkalsqdzwitpqwdwc`.
3. Aplicar només `20260825071626_add_manual_match_previews.sql` amb el mecanisme oficial de Supabase.
4. Verificar el `CHECK`, les funcions `private` amb `search_path = ''`, els revokes/grants i la whitelist de `get_public_pool_state`.
5. Provar que admin pot desar/eliminar, no-admin és rebutjat per RLS i anon només llegeix la projecció sanejada.
6. Confirmar que un snapshot automàtic preexistent continua sent llegible i que una prèvia manual persisteix després d’editar, publicar i recarregar la porra.
7. Executar advisors i netejar qualsevol dada exclusivament sintètica creada per a la validació.
8. Només després, publicar el frontend estàtic i verificar escriptori, mòbil i consola.

No cal desplegar de nou l’Edge Function ni configurar o llegir `API_FOOTBALL_KEY` per activar aquest flux manual.

## Limitació local

La migració no s’ha executat contra PostgreSQL local perquè la configuració existent requereix Docker o Podman i cap dels dos runtimes està disponible. No s’ha instal·lat ni configurat infraestructura nova.
