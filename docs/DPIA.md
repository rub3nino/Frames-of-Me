# DPIA — photo-matching RePhoto (v4, self-hosted)

**BOZZA** per il consulente e il DPO. Non è una DPIA firmata. Non c'è sign-off. Non è stata chiesta una consultazione preventiva.

Redazione tecnica: 2026-10-07, aggiornata lo stesso giorno al codice v4 (motore volti self-hosted, `docs/v4-selfhost-spec.md`) e a `CONTRACTS.md` (contratto congelato v4). Ogni affermazione tecnica qui sotto è stata verificata su `apps/api/src/routes.ts`, `apps/worker/src/handlers.ts`, `packages/db/migrations/*.sql`, `packages/face-engine/src/insightface.ts`, `apps/face-service/app/*.py`, `apps/web/lib/liveness.ts`, `apps/api/src/mailer.ts`, `deploy/compose.yml` e `deploy/Caddyfile`. Dove il codice e una scelta di legge non coincidono, il punto è aperto in fondo (§10).

**Cosa cambia rispetto alla bozza v3.** Il confronto dei volti non è più affidato a un fornitore (Amazon Rekognition): gira su un server nostro, in Europa, e i **template biometrici sono a riposo nel nostro Postgres** (tabella `face_vectors`). È la differenza che pesa di più in questo documento: prima i vettori stavano in una collection del responsabile e noi tenevamo solo identificatori opachi; ora li custodiamo noi, con quello che comporta in cifratura, accessi, backup e cancellazione. In cambio nessun dato lascia il VPS tranne le e-mail (verso il provider SMTP) e le immagini servite al browser del partecipante. Rekognition resta disponibile come alternativa (`FACE_ENGINE=rekognition`): se venisse scelta, per quella parte vale la bozza v3 (storia git di questo file).

## 1. Titolare

Titolare del trattamento: **[organizzatore della conferenza]**.

Non è stato indicato un nome societario, una sede, un rappresentante né un DPO. Quei dati vanno scritti qui prima del go-live. RePhoto è il sistema; non è, in questa bozza, il titolare.

## 2. Trattamento

Photo-matching di un solo evento, una conferenza europea di tre giorni: circa **12 fotografi**, **~150.000 foto JPEG**, **~6.000 partecipanti** che cercano le proprie foto con un selfie, le sfogliano e le scaricano.

**Fotografi** (`role = photographer`). Entrano solo accettando un invito e-mail (`POST /v1/auth/accept-invite`, link `/invito?token=…`, valido 7 giorni, monouso), che li iscrive in `event_photographers`. Caricano JPEG o PNG fino a **60 MiB** (`POST /v1/uploads/init`, poi PUT su URL firmati da 30 minuti verso `media.<dominio>`, multipart sopra 8 MiB, `complete` che verifica la dimensione dichiarata). L'originale resta nel bucket privato MinIO, chiave `originals/{eventId}/{photoId}`. Il worker verifica lo sha256 dichiarato, produce due derivati JPEG (`thumbs/{photoId}.jpg` lato massimo 480 px, `web/{photoId}.jpg` lato massimo 1600 px) e indicizza la foto: manda il derivato `web` al `face-service` (processo Python sullo stesso host), che restituisce per ogni volto riquadro, punteggio e un vettore ArcFace a 512 dimensioni; il worker scrive una riga `face_vectors` per volto e una riga `faces` con l'identificatore e il riquadro.

Dalla v3 il fotografo può scegliere l'invio **a due stadi** («Prima il web, poi gli originali», pagina `/upload`, Chrome/Edge anche da una cartella sorvegliata che la pagina rilegge ogni 10 s): il browser genera in locale la versione da 1600 px e la carica per prima su `web/{photoId}.jpg`; il worker ricava da questa la miniatura e indicizza subito; l'originale arriva in seguito sulla stessa chiave e il job `verify` lo legge **una sola volta** per confrontarne sha256 e dimensione. Non cambia la categoria di dato né la sua collocazione. Il motore volti riceve sempre il derivato `web`, mai l'originale, in entrambi i flussi.

**Partecipanti** (`role = participant`). Entrano con un magic link (`POST /v1/auth/request-link`, e-mail con oggetto `Accedi a RePhoto` e il solo URL `/verifica?token=…`, scadenza **20 minuti**, un solo uso; la pagina web consuma il token solo al clic di un bottone). La sessione dura **30 giorni** (cookie `rephoto_session`, `HttpOnly`, `SameSite=Lax`, `Secure`). Il consenso è una chiamata separata, `POST /v1/events/:slug/consent`, con `textVersion` e `accepted: true`. Poi inviano un selfie JPEG o PNG, al massimo **8 MiB**, campo multipart `selfie` (`POST /v1/events/:slug/selfie`), in uno di due modi:

- **camera con challenge** (default dove c'è una camera e la pagina è servita in `https`): la pagina `/selfie` apre la camera frontale e guida la persona («Guarda la camera», «Gira la testa a sinistra», «a destra», «Sbatti le palpebre», poi lo scatto frontale automatico), 15 secondi per passo. Il riconoscimento dei punti del volto (MediaPipe Face Landmarker) gira **nel browser**, con file serviti dal nostro dominio; **nessun fotogramma lascia il telefono** prima dello scatto finale, e solo quello (JPEG, lato lungo 1280 px) viene inviato, con il campo `liveness = challenge`;
- **file** (camera negata o assente, o scelta esplicita «Usa un file invece»): il selettore di file, campo `liveness = file`.

L'API registra in `audit_log` una riga `selfie.submitted` con `meta.liveness`. Il worker cerca i volti nei vettori dell'evento, scrive la galleria e **cancella l'oggetto selfie**. Parte un'e-mail con oggetto `Le tue foto sono pronte` e il solo link `${WEB_ORIGIN}/e/{slug}`. Nessun allegato, nessuna immagine nel messaggio.

**Aggancio successivo (`attach`).** Le foto caricate *dopo* il selfie vengono agganciate alla galleria senza un nuovo selfie: per ogni volto della nuova foto il worker chiama `searchFaces` (ricerca per identificatore di un volto già indicizzato: una query sul vettore già in tabella, non una nuova immagine) e aggiunge la foto alle gallerie i cui `anchor_face_ids` contengono un volto simile. Al massimo una e-mail `Ci sono nuove foto per te` ogni **6 ore** per galleria. Cosa sono gli anchor è spiegato in §3.

**Admin** (`role = admin`). Esistono solo da seed o da una riga SQL inserita al primo deploy. Invitano i fotografi, impostano l'accesso dell'evento (`open` o `list`), importano l'elenco dei partecipanti ammessi, leggono i contatori, cancellano foto e partecipanti, avviano la retention.

In produzione `FACE_ENGINE=insightface`: `indexPhoto` manda il derivato `web` a `POST /v1/embed` del `face-service` e inserisce i vettori in `face_vectors`; `search` manda il selfie (ridotto sotto 5 MB) allo stesso endpoint, prende il volto più grande e cerca i vicini nell'evento (`embedding <=> query`, indice HNSW); `searchFaces` cerca a partire dal vettore già memorizzato; `checkLiveness` (solo se `LIVENESS_CHECK=true`) manda il selfie a `POST /v1/liveness`. Il selfie non viene indicizzato e non entra in `face_vectors`; il worker rifiuta di indicizzare qualsiasi oggetto sotto `selfies/`. Il `face-service` non ha persistenza e non logga byte di immagine (solo dimensioni, numero di volti, tempi). In locale il motore è `fake` (colore medio quantizzato, tabella `face_index`): vale solo per compose e test ed è fuori da questa DPIA.

Scala: un VPS, un Postgres (con estensione pgvector), un bucket MinIO sullo stesso host, un `face-service`. `events.retention_days` di default **90**.

## 3. Categorie di dati

| Dato | Dove sta | Nota |
| --- | --- | --- |
| E-mail, ruolo | Postgres `users` (`email`, `role`), unico per coppia | Il ruolo non cambia al login |
| Consenso | `consents`: `user_id`, `event_id`, `text_version`, `granted_at`, `withdrawn_at`, `ip`, `user_agent` | Registro del consenso (art. 7). `withdrawn_at` esiste ma nessuna rotta lo valorizza (§10) |
| Testo del consenso | Nel client web (`apps/web/app/selfie/page.tsx`), `textVersion` **`2026-10-06`** | L'API accetta solo la versione corrente (`CONSENT_TEXT_VERSION` in `packages/contracts`), altrimenti `400`. Non è l'informativa |
| Elenco ammessi | `event_participants` (`event_id`, `email`) | Solo se `events.access = 'list'`. È un elenco di e-mail importato dall'admin, non un account |
| Selfie | Oggetto `selfies/{eventId}/{userId}/{uuid}` in MinIO | Cancellato dal job `match` a ricerca conclusa (anche quando la liveness lo rifiuta); se il job fallisce definitivamente, cancellato comunque. **Nessuna regola di lifecycle su MinIO** (§10) |
| **Template biometrici** | Postgres **`face_vectors`**: `external_face_id` (uuid), `event_id`, `photo_id`, `embedding vector(512)`, `created_at` | Un vettore ArcFace (512 float32, norma 1, ~2 KB) per ogni volto rilevato in una **foto dell'evento**, fino a 50 per foto; con 3–5 volti per scatto, 450–750k righe. È un **dato biometrico a riposo nel nostro database**, non un identificatore: da solo permette di confrontare un volto con un altro. Non c'è nessun vettore del selfie (il selfie non viene indicizzato). Lo legge e lo scrive solo il motore; nessuna rotta HTTP lo restituisce |
| Identificatore del volto e geometria | Postgres `faces`: `external_id` (l'uuid di `face_vectors`), `bbox` normalizzata, `confidence` 0–1 | **Nessuna colonna embedding** in `faces`; il legame con il vettore è l'uuid |
| Galleria | `galleries` (`user_id`, `event_id`, `anchor_face_ids`, `matched_at`, `notified_at`) e `gallery_items` (`photo_id`, `face_id`, `score` 0–1, `source` `match`\|`attach`, `created_at`) | Una riga per foto, punteggio massimo. Non è il vettore |
| Anchor | `galleries.anchor_face_ids`: al massimo **5** uuid di `face_vectors` | Vedi sotto |
| IP | `magic_links.ip` (richiesta link), `consents.ip` | Il primo serve al limite di frequenza; il secondo alla prova del consenso. Con `TRUSTED_PROXY_HOPS=1` l'API legge l'IP messo da Caddy |
| Sessione | `sessions.token_hash` = SHA-256 del cookie | Il token in chiaro non si memorizza |
| Sessione di upload | `upload_sessions`: fotografo, evento, chiave oggetto, sha256 e dimensione dichiarati, `stage`, `photo_id`, tipo e dimensione dell'originale annunciati al primo stadio | Dati del fotografo e del file, nessun dato del partecipante. Le sessioni lasciate aperte sono abortite dopo 24 ore |
| Audit | `audit_log`: `photo.deleted` (admin o retention), `participant.deleted`, **`selfie.submitted`** (`actor_id` = partecipante, `meta.liveness` = `challenge` \| `file`) | Niente byte di immagine, token o template. Il download ZIP non scrive nulla qui |
| Log applicativi | Una riga JSON per job: `{ ts, job, type, ms, outcome, error?, liveness? }`; log di accesso di Caddy (IP, URI, status); log del `face-service` (dimensioni, conteggi, tempi) | Nessun payload, nessun byte, nessun vettore. Rotazione `json-file` 50 MB × 5 per container, log di accesso 50 MB × 5 per 7 giorni |
| Backup | `BACKUP_DIR` su un secondo disco: `pg_dump` giornaliero (7 copie) **che contiene `face_vectors`**, copia speculare del bucket | Vedi §8: una riga cancellata resta nei dump fino a 7 giorni |

**Cosa sono gli `anchor_face_ids`.** Quando il selfie trova foto, il worker prende le 5 foto con punteggio più alto e salva nella galleria gli identificatori dei volti **in quelle foto dell'evento** che hanno fatto match. Sono uuid di righe `face_vectors` già esistenti, indicizzate per conto del fotografo; non sono il selfie, non sono una nuova registrazione del partecipante. Dalla v4 però l'identificatore punta a un vettore che sta nel nostro database: un anchor **collega una galleria (quindi un'e-mail) a un template biometrico specifico** per tutta la retention. È lo stesso legame logico della v3, con la differenza che il vettore ora è nostro. Servono al job `attach`; permettono di **non conservare il selfie**. Quando una foto viene cancellata (admin o retention) i suoi volti vengono tolti da `face_vectors` e, alla retention, dagli anchor di tutte le gallerie dell'evento (`removeAnchors`); con la cancellazione del partecipante la riga `galleries`, e quindi gli anchor, sparisce.

Parametri del motore fissati nel codice o nell'ambiente: indicizzazione fino a **50 volti** per foto, scartati quelli con `quality < INSIGHTFACE_MIN_FACE_QUALITY` (0,3: volti piccoli o incerti); ricerca con al massimo **500** vicini (`INSIGHTFACE_MAX_FACES`); soglie coseno `INSIGHTFACE_MIN_COSINE = 0,45` e `INSIGHTFACE_SURE_COSINE = 0,65`, mappate in `similarità = 80 + 20 × clamp((cos − 0,45) / 0,20, 0, 1)` così che la soglia del worker (0,8) coincida con coseno 0,45 e «Le tue foto» (≥ 0,9) con coseno ≥ 0,55. Le immagini passano al `face-service` come byte (massimo 5 MB, ridotte dal worker), sulla rete interna di Compose, mai su Internet.

Testo di consenso attualmente nel client (versione `2026-10-06`):

> Acconsento al confronto temporaneo del mio volto con le foto dell'evento per trovare gli scatti in cui compaio. Il selfie viene cancellato subito dopo la ricerca. Le foto restano disponibili per 90 giorni.

L'API accetta solo `accepted: true` (qualsiasi altro valore è `400`). Senza una riga di consenso per quell'utente e quell'evento con `withdrawn_at` nullo, il selfie risponde `403`. Il testo non dice che le foto caricate in seguito vengono agganciate in automatico, né che i volti delle foto dell'evento sono conservati come template nel nostro database (§10).

## 4. Base giuridica

Dati comuni del partecipante (e-mail, ruolo, link di galleria, IP di richiesta link e di consenso): art. 6(1)(a) GDPR, consenso, per la finalità di §5.

Dati biometrici trattati per identificare la persona nelle foto: art. 9(1) ed eccezione art. 9(2)(a), consenso esplicito. Il consenso è una rotta propria, non mescolata a condizioni generali. Il booleano deve essere inviato come `true`: è la metà server di una casella non preselezionata; la pagina `/selfie` mostra la casella spenta e abilita l'invio solo dopo la spunta. Nella v4 il trattamento biometrico comprende, oltre al confronto, la **conservazione dei template** dei volti delle foto dell'evento per la durata della retention: va detto nell'informativa con queste parole.

Il consenso è revocabile in diritto. Nel codice la cancellazione del partecipante, consensi compresi, è `DELETE /v1/admin/participants/:id`, solo admin. Non c'è una rotta con cui il partecipante revoca o si cancella da solo, e `consents.withdrawn_at` non viene mai scritto. Punto aperto (§10), non una revoca già pronta.

Elenco ammessi (`event_participants`): e-mail importate dall'admin prima che la persona interagisca con il sistema. La base per quell'elenco la qualifica il legale; non è coperta dal consenso dell'interessato, che arriva dopo.

Account di fotografi e admin: creati su invito, da seed o da SQL, senza consenso biometrico. La base per quei soli dati di account la qualifica il legale. Non va riusato l'art. 9(2)(a) del partecipante per coprire anche loro.

Art. 35: la DPIA serve perché il trattamento è identificazione biometrica di circa 6.000 persone su 150.000 foto, con template a riposo. È larga scala di dati dell'art. 9 (art. 35(3)(b); criteri WP 248: dati biometrici, scala, abbinamento). Questa bozza non adempie da sola l'art. 35.

## 5. Finalità, e perché il QR del badge non basta

Finalità unica: dare al partecipante che ha acconsentito, per questo evento, la galleria delle foto in cui compare (comprese quelle caricate dopo il suo selfie), avvisarlo via e-mail, e permettergli di scaricarle.

Fuori finalità: sorveglianza, controllo accessi, marketing, newsletter, riutilizzo dei vettori a un evento successivo, cessione dei volti, addestramento di un modello nostro (il modello ArcFace è preaddestrato e non viene mai aggiornato con dati nostri). Le righe `face_vectors` sono per `eventId` e vengono cancellate dalla retention insieme alle foto; `deleteCollection` svuota quel che resta dell'evento.

Un QR sul badge identifica la persona a un banco. Non dice in quale fotografia di folla, tra 150.000, quella persona compare. Senza confrontare il selfie con i volti nello scatto il sistema non può costruire la galleria. L'etichettatura manuale non sta in quei volumi. Per questa finalità il confronto biometrico è il mezzo che ottiene il risultato; il QR risolve un problema diverso.

## 6. Necessità e proporzionalità

- L'e-mail serve al magic link e agli avvisi di galleria. I messaggi sono solo testo, con il solo link.
- Il ruolo separa chi carica, chi cerca e chi amministra. Un fotografo non legge le gallerie. Un admin non riceve vettori: nessuna rotta li restituisce. `GET /v1/admin/metrics` restituisce solo contatori.
- La riga di consenso (versione, ora, IP, user agent) serve a dimostrare il consenso (art. 7).
- Il selfie è la sonda. Non viene mai passato a `indexPhoto`. Si cancella nel job `match` subito dopo la ricerca (e anche quando la liveness lo rifiuta); se il job fallisce dopo i 5 tentativi, `applyFinalFailure` lo cancella comunque. Nella challenge in camera, solo lo scatto finale esce dal telefono.
- **Perché i template stanno nel nostro database.** L'alternativa (v3) era mandare ogni volto a un fornitore extra-UE con sede legale in UE e tenere da noi solo identificatori opachi. La v4 preferisce la custodia diretta: nessun trasferimento, nessun sub-responsabile per il dato più sensibile, cancellazione verificabile con una query. Il prezzo è che la misura di sicurezza del dato biometrico è ora **nostra**: cifratura del disco, accessi all'host, backup (§9, §10). I vettori servono a due cose e a nessun'altra: la ricerca dal selfie e l'aggancio delle foto successive (`searchFaces` parte dal vettore memorizzato). Senza vettori a riposo l'aggancio richiederebbe un nuovo selfie a ogni caricamento, o la conservazione del selfie: due opzioni peggiori.
- Gli anchor sono 5 identificatori per galleria, scelti tra volti già indicizzati; sono l'alternativa a conservare il selfie o a richiederlo a ogni nuovo caricamento.
- Soglie. Il motore scarta le coppie con coseno sotto **0,45** e mappa l'intervallo 0,45–0,65 su 80–100; il worker riapplica `>= 0.8` sul punteggio diviso per 100 (`DEFAULT_MATCH_THRESHOLD`), che con i default coincide con la soglia del motore. L'interfaccia divide la galleria in «Le tue foto» (score ≥ 0,9, cioè coseno ≥ 0,55) e «Forse sei tu» (0,8 ≤ score < 0,9).

La soglia è spostata sulla precisione: il danno da evitare è mostrare a una persona le foto di un'altra. Il danno accettato in cambio è non mostrare qualche foto vera. **0,45 non è un tasso di falso match misurato su foto di questa conferenza.** L'unica verifica fatta è una prova end-to-end: 6 volti indicizzati, il ritaglio del selfie ha trovato solo la propria foto con punteggio 1,0 (coseno sopra 0,65). È una prova di funzionamento, non una misura. Prima del go-live qualcuno deve misurare su un campione etichettato; finché non c'è il numero, 0,45 è una scelta di prodotto.

- **Liveness: due livelli, entrambi deterrenti.** (1) La challenge in camera prova che davanti al telefono c'è qualcosa che gira la testa e sbatte le palpebre quando richiesto; il risultato (`liveness = challenge`) è **asserito dal client** e registrato in audit, non verificato dal server: un client modificato può inviare un file con quel campo. (2) Con `LIVENESS_CHECK=true` il worker chiede al `face-service` un giudizio passivo sul selfie («silent face» anti-spoofing, modello MiniFASNet, soglia 0,5): se `live = false` la galleria resta vuota e la mail «pronte» parte lo stesso (l'interfaccia mostra «Nessuna corrispondenza»); nel log del job compare `liveness: "rejected"`. Il modello non è stato misurato su foto-di-foto e schermi in condizioni di sala; **di default il controllo è spento** (`LIVENESS_CHECK=false`) e i pesi vengono da un repository senza licenza esplicita (§10). Nessuno dei due livelli è una prova biometrica di presenza: lo dice il codice (`apps/web/lib/liveness.ts`: «A deterrent, not a biometric proof») e lo deve dire l'informativa.

Altri limiti nel codice, utili alla proporzione:

- Indicizzazione al massimo 50 volti per foto, scartati quelli sotto qualità 0,3; ricerche al massimo 500 vicini.
- URL firmati da **30 minuti** per miniature, versione web, originali e parti di upload, firmati a finestre di 10 minuti perché il browser possa riusarli; bucket senza policy pubblica, MinIO raggiungibile solo attraverso Caddy su `media.<dominio>` (console disattivata, nessuna porta esposta oltre 80/443).
- Rate limit magic link: **3 per e-mail / ora** e **20 per IP / ora**. Rate limit selfie: **5 per utente / ora**. Al bordo, fail2ban sul log di accesso di Caddy per `/v1/auth/*` (configurazione in `deploy/README.md`, non applicata da Compose).
- Il download (`gallery/download`, massimo 100 id) e lo ZIP (`gallery/zip`, massimo 500 id) sono rifiutati per intero (`403`) se anche un solo `photoId` non è nella galleria di chi chiama. Lo ZIP accetta solo richieste con `Origin` uguale a `WEB_ORIGIN` quando l'header è presente, viene costruito in streaming e non lascia traccia in `audit_log`.
- Accesso ristretto: con `events.access = 'list'` il selfie è `403` per un'e-mail non presente in `event_participants`.
- Upload: solo fotografi iscritti all'evento (`event_photographers`), sha256 verificato dal worker, dimensione verificata dall'API; nel flusso a due stadi il browser carica solo oggetti con chiave assegnata dall'API (PUT firmato vincolato a tipo e dimensione).

## 7. Destinatari e responsabili

Tutto il trattamento gira su **un solo VPS** in un data center dell'Unione (`deploy/compose.yml`): Caddy (TLS, Let's Encrypt), Postgres con pgvector, MinIO, `face-service`, api, worker, web, backup e, opzionale, uptime-kuma. Nessun CDN, nessun PoP, nessun servizio gestito: la connessione TLS del partecipante termina sul VPS. Le immagini (miniature, web, originali, PUT di upload) passano da Caddy a MinIO sullo stesso host. Il bucket non è replicato altrove. **Nessun dato personale esce dal VPS** tranne quanto segue.

Responsabili del trattamento previsti:

- **Fornitore di hosting** (es. Hetzner, data center in Germania o Finlandia): fornisce macchina, disco, rete e, se si usa, il volume di rete e gli snapshot. Non accede ai dati per disegno, ma ha il controllo fisico dell'host e dei dischi: serve il DPA del provider e la verifica della localizzazione del data center e dello storage box di backup. Se il provider offre cifratura dei volumi, va attivata e annotata qui (§9, §10).
- **Provider di posta transazionale** (SMTP autenticato: Brevo, Postmark, Mailgun, SES in modalità SMTP, Resend; scelta non ancora fatta): riceve per ogni messaggio **l'indirizzo del destinatario, l'oggetto e il corpo**, cioè il **link con il token** del magic link o dell'invito (`/verifica?token=…`, `/invito?token=…`) e il link della galleria. Il token è monouso e scade in 20 minuti (invito: 7 giorni); il provider lo vede comunque in chiaro finché scade. Conserva di solito log e, se attivato, il contenuto dei messaggi per giorni: va scelto un provider UE o con DPA e clausole adeguate, con la conservazione del contenuto disattivata. La connessione api → provider è autenticata e cifrata (STARTTLS richiesto con `SMTP_STARTTLS=true`, o TLS implicito su 465). SPF, DKIM e DMARC sul dominio mittente sono requisiti di consegna, non di protezione dei dati (`deploy/README.md` §8).

Non sono responsabili, ma vanno nominati:

- **Let's Encrypt** (ACME) tratta solo il nome di dominio.
- **Download dei modelli al build** delle immagini: il pacchetto `buffalo_l` dalla release GitHub di InsightFace, i pesi anti-spoofing da GitHub (`hairymax/Face-AntiSpoofing`), il modello MediaPipe `face_landmarker.task` da Google Storage. Avvengono al `docker compose build`, senza dati personali; i container in esecuzione non hanno bisogno di rete verso l'esterno per il riconoscimento.
- **MediaPipe nel browser**: i file wasm e il modello sono serviti dal nostro dominio (`/mediapipe/`), la CSP non ammette altri script; nessuna chiamata a Google a runtime.

**Amazon Web Services** non è un responsabile in questo deploy. Lo diventa solo se l'organizzatore sceglie `FACE_ENGINE=rekognition` (collection in `eu-central-1`) o `MAIL_TRANSPORT=ses`; in quel caso valgono le righe della bozza v3 (DPA AWS, lista subprocessori, nessuna region diversa da `eu-central-1`) e questo paragrafo va riscritto.

In locale non si chiama nessun fornitore. MinIO, Mailpit, Postgres e `face-service` di compose non sono il trattamento di produzione.

## 8. Cancellazione

Tre operazioni diverse. Vanno tenute distinte. Dalla v4 ognuna deve lasciare `face_vectors` coerente con `faces`.

**Cancellazione del partecipante** (`DELETE /v1/admin/participants/:id`, solo se `role = participant`): in una transazione si tolgono `gallery_items`, `galleries` (anchor compresi), `consents`, `sessions`, `magic_links` di quella e-mail e la riga `users`. Scrive `audit_log` `participant.deleted`.

Il selfie non è indicizzato, quindi **non esiste un vettore del partecipante** da cancellare: in `face_vectors` ci sono solo i volti delle foto dell'evento. L'operazione non chiama `deleteFaces` e non cancella righe `faces`: le fotografie di gruppo restano, con i derivati e i volti indicizzati sulla foto, perché nello scatto ci sono altre persone. Si cancella il legame di identità (galleria e account), non lo scatto. La riga in `event_participants` **non** viene rimossa: è un dato dell'organizzatore, non dell'account.

**Cancellazione di una foto** (`DELETE /v1/admin/photos/:id`): `FaceEngine.deleteFaces` sugli `external_id` di quella foto — con InsightFace è `delete from face_vectors where event_id = … and external_face_id = any(…)`, quindi **i template di quei volti spariscono dal database** — poi oggetto originale e derivati da MinIO, poi in transazione `gallery_items`, `faces`, `face_index`, riga `photos`. Scrive `audit_log` `photo.deleted`. Gli anchor che puntavano a quei volti restano nelle gallerie fino alla retention (`removeAnchors` è chiamato solo dal job `retention`); sono uuid di righe ormai inesistenti, quindi inerti.

**Retention** (`POST /v1/admin/retention/run` con `{ eventId }` → job `retention`, eseguito dal worker): cutoff = `now() - events.retention_days` (default 90, modificabile con `PATCH /v1/admin/events/:id`). Per le foto dell'evento con `created_at` anteriore al cutoff, a lotti di 50: `deleteFaces` a blocchi di 1000 (righe `face_vectors`), `removeAnchors` dagli `anchor_face_ids` di tutte le gallerie dell'evento, cancellazione di originale e derivati, cancellazione della riga foto (con `gallery_items`, `faces`, `face_index`) e una riga `audit_log` `photo.deleted` con `retention: true` e l'admin che ha avviato il job. Quando l'evento non ha più foto, `deleteCollection` esegue `delete from face_vectors where event_id = …`: nessun vettore dell'evento sopravvive.

La retention **lascia** `users`, `consents`, `galleries` (ormai vuote), `event_participants` e `audit_log`. Non c'è uno scheduler che la invochi da solo il giorno 90: la avvia un admin (§10).

**Backup.** Il servizio `backup` fa ogni notte `pg_dump` (7 copie conservate) e `mc mirror --remove` del bucket. Quindi: una riga `face_vectors` o `users` cancellata oggi resta leggibile nei dump per **fino a 7 giorni**; un oggetto cancellato sparisce dalla copia al giro successivo (**fino a 24 ore**). La cancellazione definitiva di un partecipante o di una foto si completa con la rotazione dei dump; dopo l'evento, quando si purgano i dati, va cancellato anche `BACKUP_DIR` (e le copie portate fuori dal VPS). Lo spazio Postgres liberato da `delete` viene riusato, non azzerato: non è una misura, è un fatto da sapere.

**Cancellazioni automatiche minori**: job `done` eliminati dopo 7 giorni; sessioni di upload lasciate aperte abortite dopo 24 ore; log dei container a rotazione per dimensione (50 MB × 5), log di accesso di Caddy a rotazione per dimensione e dopo 7 giorni. **Manca** una scadenza automatica degli oggetti `selfies/` (il lifecycle a 2 giorni era una regola del bucket AWS; MinIO qui non la applica): resta solo la cancellazione del job, in corso e al fallimento definitivo (§10).

## 9. Rischi e misure

| Rischio | Misura nel codice o nel deploy |
| --- | --- |
| Falso match: una persona vede le foto di un'altra | Soglia coseno 0,45 nel motore (= 0,8 dopo la mappatura), riapplicata nel worker. Galleria per utente ed evento. Download e ZIP falliscono tutti se un id non è in galleria |
| Aggancio sbagliato (`attach`) | Stessa soglia; l'aggancio parte solo da vettori già indicizzati e richiede l'overlap con gli anchor della galleria. Al massimo 5 anchor per galleria; una foto cancellata esce dagli anchor alla retention |
| **Lettura o furto dei template biometrici** (nuovo in v4) | Postgres non espone porte sull'host; `face_vectors` è letta solo dal motore; nessuna rotta HTTP la restituisce; log senza vettori. Accesso all'host solo via SSH con chiave (bootstrap apre 22/80/443). **Cifratura a riposo: nessuna a livello applicativo**; si affida alla cifratura del disco o del volume del VPS (LUKS, o volume cifrato del provider), che Compose non configura (§10). Backup su secondo disco: stessa condizione |
| Accesso non autorizzato all'app | Bucket privato, URL firmati 30 minuti via `media.<dominio>`. Cookie `HttpOnly`, `SameSite=Lax`, `Secure`, solo hash in database. Autorizzazione per ruolo. Rate limit su magic link e selfie; fail2ban raccomandato su `/v1/auth/*`. HSTS, `nosniff`, `X-Frame-Options: DENY`, CSP, `Permissions-Policy: camera=(self)` da Caddy e dal web |
| Ricerche da estranei | `events.access = 'list'` + `event_participants` |
| Galleria troppo larga | Soglia, un item per foto, niente listing del bucket, 50 volti in indicizzazione e 500 vicini in ricerca |
| Trasferimento extra-UE | **Nessuno per disegno**: un solo host UE, nessun CDN, nessun PoP, TLS terminato sul VPS, motore e vettori in casa. Unica uscita: la posta verso il provider SMTP (scelta del provider in §10). `S3_REGION`/`AWS_REGION` restano letterali `eu-central-1` nello schema dell'ambiente, ma nessun servizio AWS è chiamato con `FACE_ENGINE=insightface` e `MAIL_TRANSPORT=smtp` |
| Selfie che resta in storage | Cancellazione nel job a ricerca conclusa (anche su rifiuto della liveness), cancellazione al fallimento definitivo. Il selfie non si indicizza e non si allega alle e-mail. **Nessuna scadenza automatica dell'oggetto su MinIO** (§10) |
| Selfie non autentico (foto di una foto, schermo) | Challenge attiva nel browser (testa a sinistra/destra, battito di ciglia, scatto automatico), asserita dal client e registrata in audit; opzionale anti-spoofing passivo lato server (`LIVENESS_CHECK=true`, spento di default). **Deterrenti, non prove**: limiti in §6 e §10 |
| Vettori nei log o nelle risposte | Il log per job non contiene payload; gli errori del `face-service` sono ripuliti a testo ASCII di 200 caratteri; il `face-service` logga solo dimensioni e conteggi; l'audit non contiene template; nessuna rotta restituisce `face_vectors` |
| Saturazione del motore | Semaforo a 2 inferenze nel `face-service`, token bucket per processo (`FACE_INDEX_TPS`, `FACE_SEARCH_TPS`); job `match` a priorità 0 così i selfie passano davanti all'indicizzazione |
| Guasto dell'host | È un solo VPS: `restart: unless-stopped`, healthcheck, systemd al boot, backup giornaliero su disco separato, prova di ripristino prescritta prima dell'evento (`deploy/README.md` §6). Nessuna alta disponibilità |
| Posta: credenziali o token in chiaro | `SMTP_STARTTLS=true` fa fallire l'invio se il server non offre STARTTLS; credenziali solo in `.env.production` (non committato); password non loggate |
| Cifratura in transito | TLS 1.2+ da Caddy (Let's Encrypt, HSTS 2 anni) verso i client; rete interna di Compose in chiaro tra container sullo stesso host (api ↔ Postgres ↔ MinIO ↔ face-service), senza uscita |
| Lock-in del modello | Interfaccia `FaceEngine` (`indexPhoto`, `search`, `searchFaces`, `deleteFaces`, `deleteCollection`, `checkLiveness?`). Rekognition e `fake` restano implementazioni alternative (§11) |

## 10. Rischi residui e punti che il DPO chiude prima del go-live

Nessuna casella sotto è fatta. Non vanno spuntate in questa bozza.

- [ ] Nome, sede e contatti di **[organizzatore della conferenza]**; nomina del DPO se dovuta; autorità di controllo competente e diritto dello Stato membro (l'art. 9(4) può aggiungere limiti).
- [ ] Sign-off di questa DPIA da parte del DPO e del titolare.
- [ ] Informativa artt. 13–14. La frase versione `2026-10-06` è il testo di prodotto nel client, non l'informativa. Deve dire anche: che i volti di tutte le foto dell'evento sono conservati come **template biometrici nel database dell'organizzatore** per la retention; che le foto caricate dopo il selfie vengono agganciate in automatico conservando fino a 5 identificatori (`anchor_face_ids`); che la challenge in camera e l'eventuale controllo server sono deterrenti e non garanzie; che il selfie non si conserva.
- [ ] Registro dei trattamenti, art. 30.
- [ ] Decisione sull'eventuale consultazione preventiva, art. 36. Con template a riposo in casa il caso è, se possibile, più forte di prima. Non è stata avviata.
- [ ] **Cifratura a riposo dei template.** `face_vectors` è in chiaro nel file system di Postgres; i dump pure. Compose non cifra nulla. Prima del go-live: disco o volume cifrato sull'host (LUKS, o cifratura del volume offerta dal provider) e `BACKUP_DIR` su disco o storage cifrato; chiavi non sullo stesso disco. Da fare e da annotare qui con chi l'ha verificato.
- [ ] **Chi può leggere `face_vectors`.** Chiunque abbia SSH sull'host o la password di Postgres (in `.env.production`) legge i template con una query, cosa che con Rekognition non era possibile. Elenco nominativo delle persone con accesso all'host, chiavi SSH personali, nessuna password condivisa, log di accesso SSH conservato. È una misura organizzativa che il codice non può dare.
- [ ] **DPA con il fornitore di hosting** e verifica della localizzazione UE di VPS, volume e storage box; snapshot del provider (se attivati) contengono i template: stessa cifratura e stessa retention.
- [ ] **Scelta e DPA del provider di posta.** Vede indirizzi, token monouso e link di galleria; disattivare la conservazione del contenuto dei messaggi; preferire un provider con data center UE. Senza questa scelta la lista dei responsabili del §7 è incompleta.
- [ ] **Licenza dei modelli.** I pesi `buffalo_l` sono pubblicati da InsightFace per uso di ricerca non commerciale (era la ragione del rinvio nella v3); i pesi anti-spoofing vengono da un repository **senza file di licenza** (`hairymax/Face-AntiSpoofing`, addestrati su CelebA-Spoof). Non è un punto di protezione dei dati ma blocca il go-live: il legale decide se l'uso per un evento dell'organizzatore rientra, se chiedere una licenza, o se costruire l'immagine con `WITH_LIVENESS=0` (il controllo passivo risponde sempre «live») e cercare altri pesi.
- [ ] **Revoca self-service del partecipante.** Oggi cancella solo un admin; `consents.withdrawn_at` non viene mai scritto; non c'è una pagina «I miei dati». Fino ad allora la revoca è una richiesta e-mail all'organizzatore gestita a mano, con tempi dell'art. 12(3).
- [ ] **Liveness: limiti dichiarati.** `liveness = challenge` è un'asserzione del client; il controllo passivo è spento di default, non misurato, con pesi di provenienza incerta. Decidere se attivare `LIVENESS_CHECK=true` per l'evento (costo: ~160 ms per selfie e qualche vero partecipante rifiutato con luce cattiva, che vedrà «Nessuna corrispondenza» senza spiegazione) e scrivere nell'informativa che un selfie può essere una fotografia. Mitigazione ulteriore: `access = 'list'`.
- [ ] **Scadenza automatica dei selfie.** Il lifecycle a 2 giorni di `selfies/` era una regola del bucket AWS; MinIO non ce l'ha. La cancellazione nel job c'è; manca la rete di sicurezza. Aggiungere una regola `mc ilm` al `minio-init` o un cron, e scrivere qui il valore.
- [ ] **Backup e cancellazione.** I dump tengono per 7 giorni righe cancellate (template compresi); la copia del bucket per 24 ore. Va accettato e scritto nell'informativa, oppure ridotto `BACKUP_KEEP_DAYS`. Dopo l'evento, la purga comprende `BACKUP_DIR` e le copie esterne.
- [ ] Volti di chi non ha acconsentito. L'indicizzazione iscrive fino a 50 volti per scatto, non solo il partecipante che poi farà match; **ora quei volti sono template nel nostro database**, non identificatori presso un fornitore. Restano fino alla cancellazione della foto o alla retention. Il codice non li elimina se non corrispondono a un consenso. Serve una decisione: cancellare i vettori senza match (richiede codice), oppure un'altra base che il legale scriva. Oggi non c'è.
- [ ] Anchor. Collegano una galleria (quindi un'e-mail) a template specifici in foto specifiche per tutta la retention. Il DPO conferma che l'informativa lo copre e che la soglia dei 5 è accettabile.
- [ ] Elenco ammessi (`event_participants`): base giuridica dell'import e del fatto che resti dopo la cancellazione del partecipante.
- [ ] Retention. Tenere e-mail, consensi, gallerie vuote e audit dopo i 90 giorni è una scelta di accountability da confermare o da rovesciare. Manca chi chiama `retention/run` il giorno 90 (nessuno scheduler). `retentionDays` è modificabile da un admin con `PATCH`: va deciso se l'informativa fissa il numero.
- [ ] Tasso di falso match reale a coseno 0,45 (e a 0,55 per «Le tue foto»), su un campione etichettato di foto di conferenza. La prova fatta (6 volti, un selfie) non è una misura. Gemelli e luce cattiva restano un rischio residuo anche dopo.
- [ ] 500 vicini in ricerca (`INSIGHTFACE_MAX_FACES`), con l'indice HNSW interrogato a `ef_search = 100`: con più di 500 volti sopra soglia nell'evento un match vero può cadere fuori, e l'indice approssimato può perderne qualcuno anche prima. A 150.000 foto è possibile per una persona molto fotografata; va detto, non nascosto.
- [ ] Il job `email` in retry può mandare una seconda lettera. La dedupe vale solo per job attivi, non per job già `done`.
- [ ] Finestra in cui il selfie è in MinIO mentre il job attende un retry (fino a 5 tentativi, attese 30/60/90/120 s; con il `face-service` giù il job riprova e il selfie resta): la misura c'è (cancellazione al fallimento definitivo); il tempo di giacenza non è misurato e manca la scadenza automatica (sopra).
- [ ] L'IP registrato dipende da `TRUSTED_PROXY_HOPS=1` corretto per la topologia (Caddy unico proxy, `X-Forwarded-*` in ingresso scartati). Se si mette un altro proxy davanti (Cloudflare) va portato a 2 e dichiarato il nuovo responsabile.
- [ ] La pagina `/` dice al partecipante che il link vale «trenta minuti»; l'API lo fa scadere dopo 20. Testo da allineare.
- [ ] Nessuna alta disponibilità: un guasto del VPS ferma il servizio finché non si ripristina dal backup (prova di ripristino prescritta, non ancora fatta). Non è un rischio per i diritti, ma il piano di ripristino va scritto.

Rischio residuo che resta anche con le misure: chi ha accesso all'host può leggere i template; un admin infedele può cancellare o leggere metadati e importare elenchi; un match a 0,45 può comunque essere la persona sbagliata; la challenge e l'anti-spoofing possono essere aggirati da un client modificato o da un attacco di presentazione ben fatto; il provider di posta vede i token finché scadono.

## 11. Decisione registrata il 2026-10-07 (v4), che sostituisce quella del 2026-10-06

Il primo evento usa **InsightFace self-hosted** dietro l'interfaccia **`FaceEngine`**, adattatore `FACE_ENGINE=insightface`: `face-service` (`buffalo_l`, SCRFD + ArcFace 512-d, CPU) sullo stesso VPS, vettori in Postgres + pgvector (`face_vectors`), soglie coseno 0,45 / 0,65 mappate su 80 / 100, aggancio incrementale con `searchFaces` sul vettore memorizzato e anchor (identificatori di righe `face_vectors`). Tutto su un solo host in un data center UE; posta via provider SMTP.

La decisione del 2026-10-06 (Rekognition, InsightFace rinviato per la licenza dei pesi) è superata sul piano tecnico ma **non su quello della licenza**: il punto resta aperto in §10 e va chiuso dal legale prima del go-live. Rekognition (`FACE_ENGINE=rekognition`, `infra/cdk`) resta nel repository come alternativa dietro la stessa interfaccia, senza cambiare il contratto HTTP; se venisse scelta, §7 e §9 vanno riscritti sulla base della bozza v3.

Il motore `fake` non si usa in produzione.

## 12. Firme

| Ruolo | Nome | Data | Esito |
| --- | --- | --- | --- |
| Titolare | [organizzatore della conferenza] | | non firmato |
| DPO | | | non firmato |
| Redazione tecnica | bozza del 2026-10-07 (v4) | 2026-10-07 | non è una sign-off |
