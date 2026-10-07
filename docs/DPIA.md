# DPIA — photo-matching RePhoto (v3)

**BOZZA** per il consulente e il DPO. Non è una DPIA firmata. Non c'è sign-off. Non è stata chiesta una consultazione preventiva.

Redazione tecnica: 2026-10-07, aggiornata lo stesso giorno al codice v3 (upload a due stadi e cartella sorvegliata, `docs/v3-uploader-spec.md`) e a `CONTRACTS.md` (contratto congelato v3). Ogni affermazione tecnica qui sotto è stata verificata su `apps/api/src/routes.ts`, `apps/worker/src/handlers.ts`, `packages/db/migrations/*.sql`, `packages/face-engine/src/rekognition.ts`, `apps/web/lib/upload-queue.ts` e `infra/cdk/lib/rephoto-stack.ts`. Dove il codice e una scelta di legge non coincidono, il punto è aperto in fondo (§10).

## 1. Titolare

Titolare del trattamento: **[organizzatore della conferenza]**.

Non è stato indicato un nome societario, una sede, un rappresentante né un DPO. Quei dati vanno scritti qui prima del go-live. RePhoto è il sistema; non è, in questa bozza, il titolare.

## 2. Trattamento

Photo-matching di un solo evento, una conferenza europea di tre giorni: circa **12 fotografi**, **~150.000 foto JPEG**, **~6.000 partecipanti** che cercano le proprie foto con un selfie, le sfogliano e le scaricano.

**Fotografi** (`role = photographer`). Entrano solo accettando un invito e-mail (`POST /v1/auth/accept-invite`, link `/invito?token=…`, valido 7 giorni, monouso), che li iscrive in `event_photographers`. Caricano JPEG o PNG fino a **60 MiB** (`POST /v1/uploads/init`, poi PUT su URL firmati da 30 minuti, multipart sopra 8 MiB, `complete` che verifica la dimensione dichiarata). L'originale resta nel bucket privato, chiave `originals/{eventId}/{photoId}`. Il worker verifica lo sha256 dichiarato, produce due derivati JPEG (`thumbs/{photoId}.jpg` lato massimo 480 px, `web/{photoId}.jpg` lato massimo 1600 px) e indicizza la foto nella collection Rekognition dell'evento.

Dalla v3 il fotografo può scegliere l'invio **a due stadi** («Prima il web, poi gli originali», pagina `/upload`, Chrome/Edge anche da una cartella sorvegliata che la pagina rilegge ogni 10 s): il browser genera in locale la versione da 1600 px (stessa geometria e qualità di quella del worker) e la carica per prima su `web/{photoId}.jpg`; il worker ricava da questa la miniatura e indicizza subito; l'originale arriva in seguito sulla stessa chiave `originals/{eventId}/{photoId}` e il job `verify` lo legge **una sola volta** per confrontarne sha256 e dimensione con quanto dichiarato al primo stadio (se non coincidono l'originale viene scartato e richiesto di nuovo; la foto resta indicizzata). Non cambia la categoria di dato né la sua collocazione: è la stessa immagine, nello stesso bucket, con le stesse chiavi; cambia solo chi produce il derivato e in che ordine arrivano i byte. Rekognition riceve sempre il derivato `web`, mai l'originale, in entrambi i flussi.

**Partecipanti** (`role = participant`). Entrano con un magic link (`POST /v1/auth/request-link`, e-mail con oggetto `Accedi a RePhoto` e il solo URL `/verifica?token=…`, scadenza **20 minuti**, un solo uso; la pagina web consuma il token solo al clic di un bottone). La sessione dura **30 giorni** (cookie `rephoto_session`, `HttpOnly`, `SameSite=Lax`). Il consenso è una chiamata separata, `POST /v1/events/:slug/consent`, con `textVersion` e `accepted: true`. Poi inviano un selfie JPEG o PNG, al massimo **8 MiB**, campo multipart `selfie` (`POST /v1/events/:slug/selfie`). Il worker cerca i volti nella collection dell'evento, scrive la galleria e **cancella l'oggetto selfie**. Parte un'e-mail con oggetto `Le tue foto sono pronte` e il solo link `${WEB_ORIGIN}/e/{slug}`. Nessun allegato, nessuna immagine nel messaggio.

**Aggancio successivo (`attach`).** Le foto caricate *dopo* il selfie vengono agganciate alla galleria senza un nuovo selfie: per ogni volto della nuova foto il worker chiama `SearchFaces` (ricerca per `FaceId`, non per immagine) e aggiunge la foto alle gallerie i cui `anchor_face_ids` contengono un volto simile. Al massimo una e-mail `Ci sono nuove foto per te` ogni **6 ore** per galleria. Cosa sono gli anchor è spiegato in §3.

**Admin** (`role = admin`). Esistono solo da seed. Invitano i fotografi, impostano l'accesso dell'evento (`open` o `list`), importano l'elenco dei partecipanti ammessi, leggono i contatori, cancellano foto e partecipanti, avviano la retention.

In produzione `FACE_ENGINE=rekognition`, region `eu-central-1` (qualsiasi altro valore di `AWS_REGION` o `S3_REGION` fa fallire l'avvio): `indexPhoto` chiama `IndexFaces` sul derivato `web` della foto dell'evento; `search` chiama `SearchFacesByImage` sui byte del selfie; `searchFaces` chiama `SearchFaces` su un `FaceId` già in collection. Il selfie non viene indicizzato e non entra nella collection; il worker rifiuta di indicizzare qualsiasi oggetto sotto `selfies/`. In locale il motore è `fake` (colore medio quantizzato, tabella `face_index`): vale solo per compose e test ed è fuori da questa DPIA.

Scala: un Postgres, un bucket, una collection per evento. `events.retention_days` di default **90**.

## 3. Categorie di dati

| Dato | Dove sta | Nota |
| --- | --- | --- |
| E-mail, ruolo | Postgres `users` (`email`, `role`), unico per coppia | Il ruolo non cambia al login |
| Consenso | `consents`: `user_id`, `event_id`, `text_version`, `granted_at`, `withdrawn_at`, `ip`, `user_agent` | Registro del consenso (art. 7). `withdrawn_at` esiste ma nessuna rotta lo valorizza (§10) |
| Testo del consenso | Nel client web (`apps/web/app/selfie/page.tsx`), `textVersion` **`2026-10-06`** | L'API accetta solo la versione corrente (`CONSENT_TEXT_VERSION` in `packages/contracts`), altrimenti `400`. Non è l'informativa |
| Elenco ammessi | `event_participants` (`event_id`, `email`) | Solo se `events.access = 'list'`. È un elenco di e-mail importato dall'admin, non un account |
| Selfie | Oggetto `selfies/{eventId}/{userId}/{uuid}` | Cancellato dal job `match` a ricerca conclusa; se il job fallisce definitivamente, cancellato comunque; sul bucket AWS una regola di lifecycle lo elimina dopo 2 giorni in ogni caso |
| Vettori facciali | Collection Rekognition dell'evento, solo `eu-central-1` | Nome `rephoto-{eventId}` (i trattini dell'UUID restano). Non escono mai da Rekognition |
| Identificatore del volto e geometria | Postgres `faces`: `external_id` (il `FaceId` Rekognition), `bbox` normalizzata, `confidence` 0–1 | **Nessuna colonna embedding.** Fino a 50 volti per foto (`MaxFaces = 50` in `IndexFaces`) |
| Galleria | `galleries` (`user_id`, `event_id`, `anchor_face_ids`, `matched_at`, `notified_at`) e `gallery_items` (`photo_id`, `face_id`, `score` 0–1, `source` `match`\|`attach`, `created_at`) | Una riga per foto, punteggio massimo. Non è il vettore |
| Anchor | `galleries.anchor_face_ids`: al massimo **5** `FaceId` | Vedi sotto |
| IP | `magic_links.ip` (richiesta link), `consents.ip` | Il primo serve al limite di frequenza; il secondo alla prova del consenso. Con `TRUSTED_PROXY_HOPS` l'API legge l'IP del client dietro i proxy |
| Sessione | `sessions.token_hash` = SHA-256 del cookie | Il token in chiaro non si memorizza |
| Sessione di upload | `upload_sessions`: fotografo, evento, chiave oggetto, sha256 e dimensione dichiarati, `stage` (`original` \| `web`), `photo_id` (solo sul secondo stadio: collega la sessione alla riga `photos` già creata), tipo e dimensione dell'originale annunciati al primo stadio | Dati del fotografo e del file, nessun dato del partecipante. Le sessioni lasciate aperte sono abortite dopo 24 ore |
| Audit | `audit_log`: `photo.deleted` (admin o retention), `participant.deleted` | Niente byte di immagine, token o template. Il download ZIP non scrive nulla qui |
| Log applicativi | Una riga JSON per job: `{ ts, job, type, ms, outcome, error? }` | Nessun payload, nessun byte; gli errori Rekognition sono ripuliti dai byte dell'immagine prima del log |

**Cosa sono gli `anchor_face_ids`.** Quando il selfie trova foto, il worker prende le 5 foto con punteggio più alto e salva nella galleria i `FaceId` Rekognition dei volti **in quelle foto dell'evento** che hanno fatto match. Sono identificatori opachi (UUID emessi da Rekognition) di volti già indicizzati per conto del fotografo; non sono vettori, non sono il selfie, non sono una nuova registrazione del partecipante. Servono al job `attach`: per una foto caricata dopo, `SearchFaces` restituisce i `FaceId` simili e l'overlap con gli anchor dice a quali gallerie la foto appartiene. È questo che permette di **non conservare il selfie** e di non chiedere un nuovo selfie a ogni caricamento. Quando una foto viene cancellata (admin o retention) i suoi `FaceId` vengono tolti dagli anchor di tutte le gallerie dell'evento (`removeAnchors`); con la cancellazione del partecipante la riga `galleries`, e quindi gli anchor, sparisce.

Parametri Rekognition fissati nel codice: `IndexFaces` con `ExternalImageId = photoId`, `MaxFaces = 50`, `QualityFilter = AUTO`; `SearchFacesByImage` e `SearchFaces` con `MaxFaces = REKOGNITION_SEARCH_MAX_FACES` (default **500**) e `FaceMatchThreshold = REKOGNITION_MIN_SIMILARITY` (default **90**). Nessun segreto in `ExternalImageId`. Le immagini passano come byte (massimo 5 MB, ridotte dal worker), mai come riferimento S3.

Testo di consenso attualmente nel client (versione `2026-10-06`):

> Acconsento al confronto temporaneo del mio volto con le foto dell'evento per trovare gli scatti in cui compaio. Il selfie viene cancellato subito dopo la ricerca. Le foto restano disponibili per 90 giorni.

L'API accetta solo `accepted: true` (qualsiasi altro valore è `400`). Senza una riga di consenso per quell'utente e quell'evento con `withdrawn_at` nullo, il selfie risponde `403`. Il testo non dice che le foto caricate in seguito vengono agganciate in automatico (§10).

## 4. Base giuridica

Dati comuni del partecipante (e-mail, ruolo, link di galleria, IP di richiesta link e di consenso): art. 6(1)(a) GDPR, consenso, per la finalità di §5.

Dati biometrici trattati per identificare la persona nelle foto: art. 9(1) ed eccezione art. 9(2)(a), consenso esplicito. Il consenso è una rotta propria, non mescolata a condizioni generali. Il booleano deve essere inviato come `true`: è la metà server di una casella non preselezionata; la pagina `/selfie` mostra la casella spenta e abilita l'invio solo dopo la spunta.

Il consenso è revocabile in diritto. Nel codice la cancellazione del partecipante, consensi compresi, è `DELETE /v1/admin/participants/:id`, solo admin. Non c'è una rotta con cui il partecipante revoca o si cancella da solo, e `consents.withdrawn_at` non viene mai scritto. Punto aperto (§10), non una revoca già pronta.

Elenco ammessi (`event_participants`): e-mail importate dall'admin prima che la persona interagisca con il sistema. La base per quell'elenco (contratto di partecipazione, interesse legittimo dell'organizzatore a limitare la ricerca agli iscritti) la qualifica il legale; non è coperta dal consenso dell'interessato, che arriva dopo.

Account di fotografi e admin: creati su invito o su seed, senza consenso biometrico. La base per quei soli dati di account (contratto con l'organizzatore, o misura precontrattuale) la qualifica il legale. Non va riusato l'art. 9(2)(a) del partecipante per coprire anche loro.

Art. 35: la DPIA serve perché il trattamento è identificazione biometrica di circa 6.000 persone su 150.000 foto. È larga scala di dati dell'art. 9 (art. 35(3)(b); criteri WP 248: dati biometrici, scala, abbinamento). Questa bozza non adempie da sola l'art. 35.

## 5. Finalità, e perché il QR del badge non basta

Finalità unica: dare al partecipante che ha acconsentito, per questo evento, la galleria delle foto in cui compare (comprese quelle caricate dopo il suo selfie), avvisarlo via e-mail, e permettergli di scaricarle.

Fuori finalità: sorveglianza, controllo accessi, marketing, newsletter, riutilizzo della collection a un evento successivo, cessione dei volti, addestramento di un modello nostro. La collection è una per `eventId` e viene cancellata dalla retention quando l'evento non ha più foto. Il prefisso di produzione resta `rephoto-`.

Un QR sul badge identifica la persona a un banco. Non dice in quale fotografia di folla, tra 150.000, quella persona compare. Senza confrontare il selfie con i volti nello scatto il sistema non può costruire la galleria. L'etichettatura manuale non sta in quei volumi. Per questa finalità il confronto biometrico è il mezzo che ottiene il risultato; il QR risolve un problema diverso.

## 6. Necessità e proporzionalità

- L'e-mail serve al magic link e agli avvisi di galleria. I messaggi sono solo testo, con il solo link.
- Il ruolo separa chi carica, chi cerca e chi amministra. Un fotografo non legge le gallerie. Un admin non riceve vettori: non esistono colonne da restituire. `GET /v1/admin/metrics` restituisce solo contatori.
- La riga di consenso (versione, ora, IP, user agent) serve a dimostrare il consenso (art. 7).
- Il selfie è la sonda. Non viene mai passato a `IndexFaces`. Si cancella nel job `match` subito dopo la ricerca; se il job fallisce dopo i 5 tentativi, `applyFinalFailure` lo cancella comunque; il lifecycle S3 a 2 giorni è la rete di sicurezza.
- In Postgres si tengono l'id opaco del volto, il riquadro e la similarità, perché servono a cancellare quel volto su Rekognition e a mostrare solo i match. Il vettore resta nella collection.
- Gli anchor sono 5 identificatori per galleria, scelti tra volti già indicizzati; sono l'alternativa a conservare il selfie o a richiederlo a ogni nuovo caricamento.
- Due soglie, entrambe inclusive: Rekognition applica `FaceMatchThreshold = 90` (scala 0–100) in `SearchFacesByImage` e `SearchFaces`; il worker riapplica `>= 0.8` sul punteggio diviso per 100 (`DEFAULT_MATCH_THRESHOLD`). Con i default la prima è la più stretta e decide; la seconda vale solo se qualcuno abbassa `REKOGNITION_MIN_SIMILARITY`. L'interfaccia divide ancora la galleria in «Le tue foto» (score ≥ 0,9) e «Forse sei tu» (0,8 ≤ score < 0,9).

La soglia è spostata sulla precisione: il danno da evitare è mostrare a una persona le foto di un'altra. Il danno accettato in cambio è non mostrare qualche foto vera. Novanta non è un tasso di falso match misurato su foto di questa conferenza. Nessun campione etichettato risulta valutato. Prima del go-live qualcuno deve misurarlo; finché non c'è il numero, 90 è una scelta di prodotto, non un risultato sperimentale.

Altri limiti nel codice, utili alla proporzione:

- `IndexFaces` al massimo 50 volti per foto; ricerche al massimo 500 match.
- URL firmati da **30 minuti** per miniature, versione web, originali e parti di upload, firmati a finestre di 10 minuti perché il browser possa riusarli; bucket senza policy pubblica e senza ACL pubblica.
- Rate limit magic link: **3 per e-mail / ora** e **20 per IP / ora**. Rate limit selfie: **5 per utente / ora**. Nel deploy di riferimento il WAF aggiunge 300 richieste / 5 minuti per IP su `/v1/auth/*`.
- Il download (`gallery/download`, massimo 100 id) e lo ZIP (`gallery/zip`, massimo 500 id) sono rifiutati per intero (`403`) se anche un solo `photoId` non è nella galleria di chi chiama. Lo ZIP accetta solo richieste con `Origin` uguale a `WEB_ORIGIN` quando l'header è presente, viene costruito in streaming e non lascia traccia in `audit_log` né nei log applicativi oltre al conteggio degli oggetti mancanti.
- Accesso ristretto: con `events.access = 'list'` il selfie è `403` per un'e-mail non presente in `event_participants`. Tutela chi non vuole essere cercato da estranei quando l'organizzatore ha un elenco di iscritti.
- Upload: solo fotografi iscritti all'evento (`event_photographers`), sha256 verificato dal worker (`derive`, o `verify` per l'originale arrivato al secondo stadio: una sola lettura), dimensione verificata dall'API. Nel flusso a due stadi il browser carica solo oggetti con chiave assegnata dall'API (`web/{photoId}.jpg`, PUT firmato vincolato a tipo e dimensione, massimo 8 MiB) e un originale solo per una propria foto in attesa (`404` altrimenti).

## 7. Destinatari e responsabili

Responsabile del trattamento previsto: Amazon Web Services, per i servizi del deploy di riferimento (`infra/cdk`, descritto in `docs/infra.md`), tutti in `eu-central-1`:

- Amazon Rekognition (collection per evento; raggiunto via interface endpoint nella VPC)
- Amazon S3 (bucket privato, cifrato KMS, lifecycle `selfies/` 2 giorni)
- Amazon SES (mail transazionale, API SESv2)
- Amazon ECS su Fargate (api, worker, web)
- Amazon RDS for PostgreSQL 16 con RDS Proxy (cifratura KMS, TLS obbligatorio)
- AWS Secrets Manager e AWS KMS
- Amazon CloudWatch (log applicativi con retention 30 giorni, metrica `rephoto/QueueDepth`, allarmi)
- AWS WAF e Amazon CloudFront **solo per il traffico web e API**: le immagini (miniature, versione web, originali, ZIP) non passano da CloudFront. Le miniature e i download sono URL firmati direttamente verso S3 in `eu-central-1`; lo ZIP è servito dall'API attraverso ALB e CloudFront. CloudFront è configurato con price class 100 (PoP in Europa e Nord America): un partecipante che si collega da fuori Europa può essere servito da un PoP extra-UE per le pagine e le chiamate API (non per le immagini firmate). Punto aperto in §10.

Non c'è SQS: la coda è la tabella `jobs` di Postgres.

Base contrattuale: AWS Data Processing Addendum sull'account. Questa bozza non verifica che l'addendum sia stato accettato.

Nessuna region diversa da `eu-central-1` è ammessa: `AWS_REGION` e `S3_REGION` sono letterali nello schema dell'ambiente e un altro valore impedisce l'avvio. Il disegno non replica i datastore verso una region extra-UE.

Elenco dei sub-responsabili: la lista pubblica dei subprocessori AWS per i servizi sopra (https://aws.amazon.com/compliance/sub-processors/). Non se ne incolla una fotografia: la lista cambia e il DPO la legge sull'account.

In locale non si chiama AWS. MinIO, Mailpit e Postgres di compose non sono il trattamento di produzione.

## 8. Cancellazione

Tre operazioni diverse. Vanno tenute distinte.

**Cancellazione del partecipante** (`DELETE /v1/admin/participants/:id`, solo se `role = participant`): in una transazione si tolgono `gallery_items`, `galleries` (anchor compresi), `consents`, `sessions`, `magic_links` di quella e-mail e la riga `users`. Scrive `audit_log` `participant.deleted`.

Il selfie non è indicizzato, quindi una ricerca regolare non lascia un `FaceId` del partecipante in collection. L'operazione non chiama `deleteFaces` e non cancella righe `faces`: le fotografie di gruppo restano, con i derivati e i volti indicizzati sulla foto, perché nello scatto ci sono altre persone. Si cancella il legame di identità (galleria e account), non lo scatto. La riga in `event_participants` (l'e-mail nell'elenco degli ammessi) **non** viene rimossa: è un dato dell'organizzatore, non dell'account.

**Cancellazione di una foto** (`DELETE /v1/admin/photos/:id`): `FaceEngine.deleteFaces` sugli `external_id` di quella foto, oggetto originale e derivati, poi in transazione `gallery_items`, `faces`, `face_index`, riga `photos`. Scrive `audit_log` `photo.deleted`. Gli anchor che puntavano a quei volti restano nelle gallerie fino alla retention (`removeAnchors` è chiamato solo dal job `retention`); sono id ormai inesistenti in collection, quindi inerti.

**Retention** (`POST /v1/admin/retention/run` con `{ eventId }` → job `retention`, eseguito dal worker): cutoff = `now() - events.retention_days` (default 90, modificabile con `PATCH /v1/admin/events/:id`). Per le foto dell'evento con `created_at` anteriore al cutoff, a lotti di 50: `deleteFaces` a blocchi di 1000, `removeAnchors` dagli `anchor_face_ids` di tutte le gallerie dell'evento, cancellazione di originale e derivati, cancellazione della riga foto (con `gallery_items`, `faces`, `face_index`) e una riga `audit_log` `photo.deleted` con `retention: true` e l'admin che ha avviato il job. Quando l'evento non ha più foto, `deleteCollection` cancella la collection Rekognition.

La retention **lascia** `users`, `consents`, `galleries` (ormai vuote), `event_participants` e `audit_log`. Non c'è uno scheduler che la invochi da solo il giorno 90: la avvia un admin. Chi vuole una cancellazione secca di e-mail e consensi allo scadere dei 90 giorni non la trova nel codice (§10).

**Cancellazioni automatiche minori**: job `done` eliminati dopo 7 giorni; sessioni di upload lasciate aperte abortite dopo 24 ore (compreso il multipart S3); `selfies/` scaduti dopo 2 giorni dal lifecycle del bucket; log CloudWatch dopo 30 giorni.

## 9. Rischi e misure

| Rischio | Misura nel codice o nel deploy di riferimento |
| --- | --- |
| Falso match: una persona vede le foto di un'altra | Soglia 90 inclusiva applicata da Rekognition in entrambe le ricerche, più `>= 0.8` nel worker. Galleria per utente ed evento. Download e ZIP falliscono tutti se un id non è in galleria |
| Aggancio sbagliato (`attach`) | Stessa soglia; l'aggancio parte solo da volti già indicizzati e richiede l'overlap con gli anchor della galleria. Un anchor è al massimo 5 per galleria; una foto cancellata esce dagli anchor alla retention |
| Accesso non autorizzato | Bucket privato, URL firmati 30 minuti. Cookie `HttpOnly`, `SameSite=Lax`, `Secure` con `https`, solo hash in database. Autorizzazione per ruolo. Rate limit su magic link e selfie; WAF su `/v1/auth/*`. ALB che accetta solo traffico con l'header segreto di CloudFront. Task e RDS su subnet private, RDS Proxy con TLS |
| Ricerche da estranei | `events.access = 'list'` + `event_participants` |
| Galleria troppo larga | Soglia, un item per foto, niente listing del bucket, `MaxFaces` 50 in indicizzazione e 500 in ricerca |
| Trasferimento extra-UE | Region bloccata su `eu-central-1` per Rekognition, S3, SES, ECS, RDS. Immagini servite da S3 in region. CloudFront price class 100 solo per pagine e API (§10) |
| Selfie che resta in storage | Cancellazione nel job a ricerca conclusa, cancellazione al fallimento definitivo, lifecycle 2 giorni. Il selfie non si indicizza e non si allega alle e-mail |
| Selfie non autentico (foto di una foto) | **Nessuna misura oggi.** Rekognition Face Liveness è pianificato, non implementato (§10) |
| Vettori nei log | Il log per job non contiene payload; gli errori Rekognition sono ripuliti dai byte dell'immagine; l'audit non contiene template. L'API Rekognition usata restituisce `FaceId`, box e similarità, non il vettore |
| Perdita di controllo sulla quota Rekognition | Token bucket per processo (`REKOGNITION_INDEX_TPS`, `REKOGNITION_SEARCH_TPS`), throttle requeue senza consumare tentativi |
| Cifratura | KMS su RDS e S3 (chiave con rotazione), TLS verso i client, verso RDS Proxy e verso le API AWS. Nel codice CDK, non applicato finché qualcuno non fa `cdk deploy` |
| Lock-in del modello | Interfaccia `FaceEngine` (`indexPhoto`, `search`, `searchFaces`, `deleteFaces`, `deleteCollection`). Vedi §11 |

## 10. Rischi residui e punti che il DPO chiude prima del go-live

Nessuna casella sotto è fatta. Non vanno spuntate in questa bozza.

- [ ] Nome, sede e contatti di **[organizzatore della conferenza]**; nomina del DPO se dovuta; autorità di controllo competente e diritto dello Stato membro (l'art. 9(4) può aggiungere limiti).
- [ ] Sign-off di questa DPIA da parte del DPO e del titolare.
- [ ] Informativa artt. 13–14. La frase versione `2026-10-06` è il testo di prodotto nel client, non l'informativa. Il testo deve dire anche che le foto caricate dopo il selfie vengono agganciate in automatico (job `attach`) e che a tal fine si conservano fino a 5 identificatori di volti già indicizzati (`anchor_face_ids`), non il selfie.
- [ ] Registro dei trattamenti, art. 30.
- [ ] Decisione sull'eventuale consultazione preventiva, art. 36. Non è stata avviata.
- [ ] Verifica che il DPA AWS sia accettato sull'account, e lettura della lista subprocessori per i servizi del §7.
- [ ] **Revoca self-service del partecipante.** Oggi cancella solo un admin; `consents.withdrawn_at` non viene mai scritto; non c'è una pagina «I miei dati». Controllo pianificato: una rotta partecipante che valorizzi `withdrawn_at` (il selfie torna `403`) e una che cancelli galleria e account come fa l'admin. Fino ad allora la revoca è una richiesta e-mail all'organizzatore gestita a mano, con tempi dell'art. 12(3).
- [ ] **Face Liveness.** Oggi chiunque abbia una foto del volto di un'altra persona e un'e-mail può ottenere la galleria di quella persona, se l'evento è `open` o se l'e-mail è nell'elenco. Controllo pianificato: Amazon Rekognition Face Liveness (sessione server + componente Amplify) prima del `POST .../selfie`. Non è nel codice v2. Finché manca, il rischio va dichiarato nell'informativa e mitigato con `access = 'list'`.
- [ ] CloudFront. Price class 100 copre PoP in Europa e Nord America: pagine e chiamate API di un visitatore fuori Europa possono transitare da un PoP extra-UE (le immagini no: URL firmati S3 in region). Prima del go-live: o il DPO accetta questo perimetro, o si restringe (geo-restriction, o un'altra price class non esiste per «solo UE»), oppure si serve l'ALB direttamente in region.
- [ ] Volti di chi non ha acconsentito. `IndexFaces` iscrive fino a 50 volti per scatto, non solo il partecipante che poi farà match. Quei vettori restano fino alla cancellazione della foto o alla retention. Il codice non li elimina se non corrispondono a un consenso. Serve una decisione: cancellare i `FaceId` senza match, oppure un'altra base che il legale scriva. Oggi non c'è.
- [ ] Anchor. Sono `FaceId` di volti in foto dell'evento, non un template del partecipante; ma collegano una galleria (quindi un'e-mail) a volti specifici in foto specifiche per tutta la retention. Il DPO conferma che l'informativa lo copre e che la soglia dei 5 è accettabile.
- [ ] Elenco ammessi (`event_participants`): base giuridica dell'import e del fatto che resti dopo la cancellazione del partecipante.
- [ ] Retention. Tenere e-mail, consensi, gallerie vuote e audit dopo i 90 giorni è una scelta di accountability da confermare o da rovesciare. Manca chi chiama `retention/run` il giorno 90 (nessuno scheduler). `retentionDays` è modificabile da un admin con `PATCH`: va deciso se l'informativa fissa il numero.
- [ ] Tasso di falso match reale alla soglia 90, su un campione di foto di conferenza. Gemelli e luce cattiva restano un rischio residuo anche dopo la misura.
- [ ] `MaxFaces = 500` in ricerca: con più di 500 volti sopra 90 nella collection, un match vero può cadere fuori. A 150.000 foto è possibile per una persona molto fotografata; va detto, non nascosto.
- [ ] Il job `email` in retry può mandare una seconda lettera. La dedupe vale solo per job attivi, non per job già `done`.
- [ ] Finestra in cui il selfie è su S3 mentre il job attende un retry (fino a 5 tentativi, attese 30/60/90/120 s più eventuali requeue per throttle): la misura c'è (cancellazione al fallimento definitivo, lifecycle 2 giorni); il tempo di giacenza non è misurato.
- [ ] L'IP registrato dipende da `TRUSTED_PROXY_HOPS` corretto per la topologia (2 nel deploy di riferimento). Un valore sbagliato registra l'IP di un proxy, e i rate limit per IP diventano inutili.
- [ ] La pagina `/` dice al partecipante che il link vale «trenta minuti»; l'API lo fa scadere dopo 20. Testo da allineare.
- [ ] Cifratura KMS, security group, WAF, condition IAM: sono nel codice CDK, non risorse già create. L'ambiente va applicato e verificato.

Rischio residuo che resta anche con le misure: un admin infedele può cancellare o leggere metadati e importare elenchi; un match a 90 può comunque essere la persona sbagliata; senza liveness un selfie può essere una fotografia; la lista subprocessori AWS può includere soggetti che il DPO non ha ancora accettato.

## 11. Decisione registrata il 2026-10-06, confermata il 2026-10-07

Il primo evento usa **Amazon Rekognition** dietro l'interfaccia **`FaceEngine`**, adattatore `FACE_ENGINE=rekognition`, collection per evento in `eu-central-1`, soglia 90, aggancio incrementale con `SearchFaces` e anchor (identificatori, non vettori).

**InsightFace è rinviato.** I pesi pubblici `buffalo_l` sono solo per ricerca non commerciale. Un eventuale sostituto, se i pesi saranno utilizzabili, resta dietro la stessa interfaccia senza cambiare il contratto HTTP.

Il motore `fake` non si usa in produzione.

## 12. Firme

| Ruolo | Nome | Data | Esito |
| --- | --- | --- | --- |
| Titolare | [organizzatore della conferenza] | | non firmato |
| DPO | | | non firmato |
| Redazione tecnica | bozza del 2026-10-07 | 2026-10-07 | non è una sign-off |
