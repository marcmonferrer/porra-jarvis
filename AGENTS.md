# Guia del projecte Porra Live

Aquesta guia complementa les instruccions globals de Codex i les de `JARVIS-Workspace/AGENTS.md`.

- Escriu en català planer i mantén l'abast de l'encàrrec.
- Abans de canviar res, revisa l'estat Git, la documentació i l'estructura existent. Reutilitza el que ja hi ha i preserva els canvis locals, especialment els que no són teus.
- Fes canvis petits i reversibles. Executa proves locals proporcionals al canvi i comprova que no facin peticions externes quan no estiguin autoritzades.
- No llegeixis ni mostris secrets, fitxers `.env`, credencials ni dades privades. Consulta la documentació oficial quan una integració o un comportament actual ho requereixi.
- Verifica les dates dels esdeveniments esportius. Interpreta i mostra les hores amb `Europe/Madrid` de manera explícita, i conserva els instants en UTC quan es desin o s'intercanviïn.
- Distingeix el marcador introduït manualment de les dades verificades d'una API. No prometis actualització en directe ni atribueixis a l'API dades que no s'han comprovat.
- Abans de fer un commit, push, desplegament, canvi de base de dades, permisos o DNS, instal·lació o eliminació, demana confirmació a Marc.
- En acabar, indica amb evidència què s'ha preparat, què s'ha provat i què s'ha publicat. Si alguna cosa no s'ha verificat o publicat, digues-ho clarament.
