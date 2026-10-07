# RePhoto — Deep analysis (vetrina, admin, fotografi, motion)

Studio approfondito avviato dopo l'analisi del sito reale dell'evento
([conferintaeuropeana.it](https://conferintaeuropeana.it) — *Conferința Europeană de Tineret și
Familii*: 4000+ persone, 15+ paesi, **famiglie e giovani con minori dai 14 anni**, multilingua
RO/IT/EN, iscrizione per gruppi, edizioni 2019–2025, **nessuna photo gallery**). I quattro
documenti qui sotto sono il riferimento completo; questo file è la sintesi con le **priorità** e il
**lavoro backend** che ne deriva.

| # | Documento | Copre |
| --- | --- | --- |
| 01 | [01-vetrina-ia.md](01-vetrina-ia.md) | Informazioni e sezioni del sito vetrina: sitemap, homepage, ogni pagina, multilingua, GDPR minori, inventario contenuti |
| 02 | [02-admin-spec.md](02-admin-spec.md) | Console admin: ruoli/tier, menu completo, 15 schermate, funzioni in più, mappatura API + gap |
| 03 | [03-photographer-spec.md](03-photographer-spec.md) | Portale fotografo: IA a 9 sezioni, workspace, funzioni in più, mappatura API + gap |
| 04 | [04-motion-plan.md](04-motion-plan.md) | Piano animazioni (impeccable + Emil Kowalski): un momento autoriale + micro-interazioni, valori esatti |

Precede e completa [`../ux-flows.md`](../ux-flows.md) (i flussi) e [`../../design/`](../../design/) (la UI).

---

## 1. Le 5 scoperte che cambiano il prodotto

1. **Il sito reale non ha una galleria foto → RePhoto riempie un vuoto reale.** Posizionamento
   consigliato: **ibrido** — vetrina dell'evento (~40%) che incanala ogni visitatore nell'unica cosa
   che RePhoto possiede, *«Trova le tue foto»*, declinata in **PRIMA / DURANTE / DOPO** l'evento.

2. **I minori sono il nodo di conformità n.1.** Il pubblico è di famiglie e giovani (dai 14 anni).
   Il contratto attuale **non ha alcun concetto di età né di consenso genitoriale**: oggi un minore
   passerebbe come adulto. Serve: age-gating, **consenso del genitore/tutore** per il biometrico
   degli under-18 (Art. 8 + Art. 9 GDPR), blocco del selfie finché il consenso non c'è, audit ed
   erasure. **Blocca lo storytelling "porta i tuoi figli e trova le loro foto".**

3. **Multilingua RO/IT/EN** è obbligatorio (default RO, UI prodotto IT), con traduzione vincolante di
   legale, consensi ed email, URL con prefisso locale e slug stabili per i link QR/email.

4. **L'admin deve diventare anche un CMS + centro conformità**, non solo moderazione: gestione
   contenuti sito (home, tema, agenda, ospiti, alloggio, FAQ, edizioni, organizzatori, traduzioni,
   newsletter), iscrizioni/capigruppo, **dashboard GDPR/minori**, analytics, ruoli a livelli.

5. **Il fotografo deve diventare uno strumento professionale**: album per giorno/palco/zona,
   **copertura/agenda** (ogni sessione coperta), **embargo/release** (quando le foto diventano
   visibili), culling, statistiche proprie, elimina/sostituisci le proprie foto, mobile scatta-e-carica.

Riconfermati i due gap già noti (ux-flows §9): **erasure self-service** oggi passa dall'admin;
**`access=list`** fa scoprire la non-appartenenza solo allo step selfie.

---

## 2. Roadmap consolidata (P0 → P2)

**P0 — senza questi, pezzi interi non esistono o non sono conformi**
- Endpoint **creazione evento** + **letture/elenchi** admin (eventi, fotografi, partecipanti, foto, audit). *(02 §API, ux-flows §9.1–9.2)*
- **Modello minori**: campi età/data di nascita, **consenso genitoriale**, gate che blocca il selfie, audit. *(01 §6, 02 minors deep-dive)*
- **Bootstrap/invito admin** (creare i 3 admin aggiuntivi). *(02)*
- **Pagina/landing servizio foto** `/e/{slug}` come fulcro della vetrina. *(01)*

**P1 — rendono il prodotto davvero utilizzabile per questo evento**
- **CMS vetrina** (contenuti sito) + **multilingua RO/IT/EN**. *(01, 02)*
- **Fotografi pro**: tabelle `albums`/`photo_albums`, `coverage_slots`/`coverage_assignments`, colonne `photos.captured_at|exif|embargo_until`, `events.watermark_policy`; `DELETE /v1/photographer/photos/:id`; stats per fotografo. *(03)*
- **GDPR self-service** (revoca + erasure) + coda richieste lato admin. *(01 §6, 02)*
- **Ruoli admin a livelli** (Super-admin/Editor/Moderatore/Sola-lettura) + scoping per evento (`admin_grants`). *(02)*
- **Avviso anticipato `access=list`** in iscrizione (non solo al selfie). *(ux-flows §9.5)*

**P2 — qualità e scala**
- Analytics (ricerche, match, download, funnel per giorno/fotografo). *(02)*
- Notifiche/email gestibili da CMS; moderazione foto in bulk; retention schedulata. *(02)*
- Mobile scatta-e-carica fotografo; offline/resume; manifest di caricamento. *(03)*

---

## 3. Lavoro backend che ne deriva (tutto additivo, nessuna rinominazione)

Nuove migrazioni suggerite (es. `005_*`/`006_*`), da confermare:
- **Eventi/CMS**: `POST /v1/admin/events` + letture; tabelle contenuti sito + `locales`/traduzioni; `events.watermark_policy`, branding.
- **Minori/consenso**: `consents` esteso (tipo `biometric_minor`), campi età/guardian, gate nel selfie, coda richieste GDPR.
- **Admin**: `admin_grants` (tier + scope evento), invito admin.
- **Fotografi**: `albums`, `photo_albums`, `coverage_slots`, `coverage_assignments`; `photos.captured_at|exif|embargo_until`; `GET /v1/photographer/events|photos|stats|coverage`, `DELETE /v1/photographer/photos/:id`.
- **Letture admin**: `GET` elenco fotografi/partecipanti/foto/audit.

Dettaglio di metodi/path/body nelle tabelle di mapping in [02](02-admin-spec.md) e [03](03-photographer-spec.md).

---

## 4. Decisioni che servono da te (sbloccano il resto)

1. **Minori**: confermi che l'evento ammette under-18 e che vogliamo gestirne le foto? → fa scattare tutto il lavoro consenso genitoriale (P0).
2. **Posizionamento vetrina**: sito dell'evento completo (agenda/iscrizioni/alloggio) **o** solo landing del servizio foto agganciata al sito esistente della conferenza?
3. **Multilingua**: confermi RO/IT/EN? Chi fornisce le traduzioni?
4. **Ruoli admin**: i 4 restano pari poteri o introduciamo i livelli?
5. **Embargo/release**: le foto vanno online man mano o solo dopo un "via libera" dello staff?

---

## 5. Prossimi passi possibili
- (a) **Costruire le nuove pagine** emerse dall'analisi nel prototipo (vetrina multi-sezione, admin con i nuovi menu/CMS/GDPR, fotografo con album/copertura) nel mondo Apple già approvato.
- (b) **Scrivere la spec tecnica v3** (`docs/v3-spec.md`) con le migrazioni e gli endpoint additivi, pronta per l'implementazione in `apps/api` + `apps/web` (React).
- (c) **Rispondere alle 5 decisioni** sopra e io aggiorno di conseguenza.
