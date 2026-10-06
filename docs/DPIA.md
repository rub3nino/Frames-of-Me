# DPIA — photo-matching RePhoto

**BOZZA** per il consulente e il DPO. Non è una DPIA firmata. Non c'è sign-off. Non è stata chiesta una consultazione preventiva.

Redazione tecnica: 2026-10-06. Allineata a `CONTRACTS.md` (stato FROZEN) presente nel repository quel giorno. Dove il contratto e una scelta di legge non coincidono, il punto è aperto in fondo. L'MVP non è finito: l'interfaccia web indicata nel contratto al §8 non risulta implementata.

## 1. Titolare

Titolare del trattamento: **[organizzatore della conferenza]**.

Non è stato indicato un nome societario, una sede, un rappresentante né un DPO. Quei dati vanno scritti qui prima del go-live. RePhoto è il sistema; non è, in questa bozza, il titolare.

## 2. Trattamento

Photo-matching di un solo evento, una conferenza europea.

I fotografi (`role = photographer`) caricano JPEG o PNG, al massimo 30 MiB, con upload multipart su URL firmati da 15 minuti. L'oggetto resta nel bucket privato `rephoto`, chiave `originals/{eventId}/uploads/{uploadId}`. Il worker produce due derivati JPEG (`thumb` lato massimo 480 px, `web` lato massimo 1600 px) e poi indicizza la foto.

Il partecipante (`role = participant`) entra con un magic link (oggetto `Accedi a RePhoto`, solo l'URL, scadenza 30 minuti, un solo uso). Il consenso è una chiamata separata, `POST /api/events/:slug/consent`. Poi invia un selfie JPEG o PNG, al massimo 8 MiB, campo `image`. Il worker cerca i volti nella collection dell'evento. A ricerca conclusa, sia in successo sia in errore, cancella l'oggetto selfie. Se la ricerca è `done`, parte un'email transazionale (oggetto `Le tue foto sono pronte`) con il solo link `${PUBLIC_WEB_URL}/eventi/${eventSlug}/galleria`. Nessun allegato e nessuna immagine nel messaggio.

In produzione `FACE_ENGINE=rekognition`: `indexPhoto` chiama `IndexFaces` sulla foto dell'evento; `search` chiama solo `SearchFacesByImage` sul selfie. Il selfie non viene indicizzato e non entra nella collection. In locale il motore è `fake` (colore medio quantizzato, tabella `face_index`): vale solo per compose e test, ed è fuori da questa DPIA di produzione.

Scala, da contratto §9: **6.000 interessati**, **100.000–150.000 foto**, circa **1,2 TB**, un Postgres, un bucket, una collection per evento. `events.retention_days` di default **90**.

## 3. Categorie di dati

| Dato | Dove sta | Nota |
| --- | --- | --- |
| Email, ruolo (`participant`, `photographer`, `admin`) | Postgres `users` | Il ruolo non si cambia da solo al login |
| Consenso | `consents`: `text_version`, `accepted` (solo `true`), `accepted_at`, IP, `user_agent` | La riga resta anche se segue un'altra ricerca. È il registro del consenso, non un log applicativo |
| Testo del consenso | `events.consent_text`, versione `2026-10-06` | Vedi sotto. Non è l'informativa legale finale |
| Selfie | Oggetto `selfies/{eventId}/{searchId}` | Cancellato a fine ricerca. `searches.selfie_key` torna `null` |
| Vettori facciali | Collection Rekognition dell'evento, solo `eu-central-1` | Nome: `rephoto-` + `eventId` (i caratteri fuori da `[A-Za-z0-9_.\-]` diventano `_`). Esempio: `rephoto-11111111-1111-4111-8111-111111111111` |
| Identificatore del volto e geometria | Postgres `faces`: `external_face_id` (il `FaceId` Rekognition), bounding box normalizzata, `confidence` | **Nessuna colonna embedding.** Il vettore non è in Postgres |
| Galleria | `gallery_items`: `photo_id` + `score` (similarità 0–100, una riga per foto, il punteggio massimo) | Non è il vettore |
| IP di magic link e di ricerca | `magic_links.request_ip`, `searches.request_ip` | Servono ai limiti di frequenza |
| Sessione | solo `sha256` del cookie `rephoto_session` | Il token in chiaro non si memorizza |
| Audit | `audit_log` per consenso, cancellazione foto, cancellazione partecipante, retention, invito fotografo | Vietato metterci byte di immagine, token o template biometrici |

`IndexFaces` usa `ExternalImageId = photoId`, `MaxFaces = 50`, filtro qualità `AUTO`. `SearchFacesByImage` usa `FaceMatchThreshold = REKOGNITION_MIN_SIMILARITY` e `MaxFaces = 50`. I segreti non finiscono in `ExternalImageId`.

Testo di consenso congelato (versione `2026-10-06`):

> Acconsento al confronto temporaneo del mio volto con le foto dell'evento per trovare gli scatti in cui compaio. Il selfie viene cancellato subito dopo la ricerca. Le foto restano disponibili per 90 giorni.

L'API accetta solo `accepted: true` e solo se `textVersion` è uguale a `events.consent_text_version`. Qualsiasi altro valore è `400`. Una versione diversa è `409`. Senza una riga di consenso per quell'utente, quell'evento e la versione corrente, il selfie risponde `403 consent_required`.

## 4. Base giuridica

Dati comuni del partecipante (email, ruolo, link di galleria): art. 6(1)(a) GDPR, consenso.

Dati biometrici trattati per identificare la persona nelle foto: art. 9(1) e eccezione art. 9(2)(a), consenso esplicito. Il consenso è una rotta propria, non è mescolato a condizioni generali (nel contratto le condizioni generali non ci sono). Il booleano deve essere inviato come `true`: è la metà server di una casella non preselezionata. La schermata che tiene la casella spenta di default non è implementata (§8 del contratto). Va chiusa prima del go-live.

Il consenso è revocabile in diritto. Nel contratto la cancellazione del partecipante, consensi compresi, è `DELETE /api/admin/participants/:userId`, solo admin. Non c'è una rotta con cui il partecipante revoca da solo. Punto aperto, non una revoca già pronta.

Account di fotografi e admin: il contratto li crea su invito o su seed, senza il consenso biometrico. La base per quei soli dati di account (contratto con l'organizzatore, o misura precontrattuale) la qualifica il legale. Non va riusato l'art. 9(2)(a) del partecipante per coprire anche loro.

Art. 35: la DPIA serve perché il trattamento è identificazione biometrica di circa 6.000 persone su 100–150.000 foto. È larga scala di dati dell'art. 9 (art. 35(3)(b); criteri delle linee guida WP 248: dati biometrici, scala, abbinamento). Questa bozza non adempie da sola l'art. 35.

## 5. Finalità, e perché il QR del badge non basta

Finalità unica: dare al partecipante che ha acconsentito, per questo evento, il link alle foto in cui compare, e mandargli l'email che quel link è pronto.

Fuori finalità: sorveglianza, controllo accessi, marketing, newsletter, riutilizzo della collection a un evento successivo, cessione dei volti, addestramento di un modello nostro. La collection è una per `eventId`. Il prefisso `REKOGNITION_COLLECTION_PREFIX` di produzione resta `rephoto`.

Un QR sul badge identifica la persona a un banco o in una sessione dell'app. Non dice in quale fotografia di folla, tra 100–150.000, quella persona compare. Senza confrontare il selfie con i volti nello scatto, il sistema non può costruire la galleria. L'etichettatura manuale da parte dei fotografi non sta in quei volumi. Leggere il nome sul badge dentro la foto non è un'alternativa automatica affidabile. Per questa finalità il confronto biometrico è il mezzo che ottiene il risultato; il QR risolve un problema diverso.

## 6. Necessità e proporzionalità

- L'email serve al magic link e all'avviso di galleria. I messaggi sono solo testo, senza foto.
- Il ruolo serve a separare chi carica, chi cerca e chi amministra. Un fotografo non legge le gallerie. Un admin non riceve vettori: non esistono colonne da restituire. `GET /api/admin/metrics` non include face id né byte.
- La riga di consenso (versione, ora, IP, user agent) serve a dimostrare il consenso (art. 7).
- Il selfie è la sonda. Il contratto vieta di chiamare `IndexFaces` su quei byte. Si cancella a fine job, anche se il job fallisce. Un retry, se `selfie_key` è ancora valorizzato, cancella l'oggetto e poi azzera la chiave. Così un worker che muore a metà non lascia il selfie come stato stabile.
- In Postgres si tengono l'id opaco del volto, il riquadro e la similarità, perché servono a cancellare quel volto su Rekognition e a mostrare solo i match. Il vettore resta nella collection.
- Soglia di default **90/100**, variabile `REKOGNITION_MIN_SIMILARITY`, confronto **inclusivo** (`>=`). È la scala Rekognition, non va riscalata a 0–1. `SearchFacesByImage` la applica e il worker la riapplica. La galleria tiene, per ogni foto, solo il punteggio massimo.

La soglia è spostata sulla precisione: il danno da evitare è mostrare a una persona le foto di un'altra. Il danno accettato in cambio è non mostrare qualche foto vera (richiamo più basso). Novanta non è un tasso di falso match misurato su foto di questa conferenza. Nessun campione etichettato risulta valutato. Prima del go-live qualcuno deve misurarlo; finché non c'è il numero, 90 è la scelta di prodotto del contratto, non un risultato sperimentale.

Altri limiti già nel contratto, utili alla proporzione: al massimo 50 volti indicizzati per foto e al massimo 50 match per ricerca; URL firmati da 15 minuti per miniature, web, originale e parti di upload; bucket senza policy pubblica e senza ACL pubblica; rate limit magic link 5 per email / 15 minuti e 30 per IP / 15 minuti; rate limit selfie 10 per utente / 60 minuti e 30 per IP / 60 minuti. Il download originale è rifiutato per intero (`403`) se anche un solo `photoId` non è nella galleria di chi chiama.

## 7. Destinatari e responsabili

Responsabile del trattamento previsto: Amazon Web Services, per i servizi usati in produzione, tutti con region `eu-central-1`:

- Amazon Rekognition (collection per evento)
- Amazon S3 (bucket privato)
- Amazon SES (mail transazionale)
- Amazon ECS su Fargate (api e worker)
- Amazon RDS for PostgreSQL
- Amazon SQS, coda `rephoto-jobs` (stesso JSON della tabella `jobs`)
- AWS Secrets Manager e AWS KMS, se il deploy li usa per segreti e cifratura a riposo
- CloudFront, se gli URL firmati da 15 minuti passano di lì (il contratto fissa il TTL, non il nome CloudFront)

Base contrattuale: AWS Data Processing Addendum sull'account. Questa bozza non verifica che l'addendum sia stato accettato.

Nessuna region diversa da `eu-central-1` è ammessa: `AWS_REGION` e `S3_REGION` sono letterali e un altro valore va rifiutato. Il disegno non replica i datastore verso una region extra-UE.

Elenco dei sub-responsabili: la lista pubblica dei subprocessori AWS per i servizi sopra («the AWS subprocessor list for those services», https://aws.amazon.com/compliance/sub-processors/). Non se ne incolla una fotografia: la lista cambia e il DPO la legge sull'account, non da questo file.

In locale non si chiama AWS. MinIO, Mailpit e Postgres di compose non sono il trattamento di produzione.

## 8. Cancellazione

Due operazioni diverse. Vanno tenute distinte.

**Cancellazione del partecipante** (`DELETE /api/admin/participants/:userId`, solo se `role=participant`):

si tolgono account, sessioni, magic link, consensi, ricerche, l'oggetto selfie se `selfie_key` è ancora valorizzato, la galleria e le righe `gallery_items` di quell'utente.

Il selfie non è indicizzato, quindi una ricerca regolare non lascia un `FaceId` del partecipante. Il contratto non chiama `deleteFaces` in questa operazione e non cancella le righe `faces`. Le fotografie di gruppo restano, con i derivati e i volti indicizzati sulla foto, perché nello scatto ci sono altre persone. Si cancella il legame di identità (galleria e account), non lo scatto.

Se un bug avesse comunque salvato un face id di ricerca, andrebbe cancellato: il contratto vieta di crearlo. Non è il percorso normale.

**Cancellazione di una foto** (`DELETE /api/admin/photos/:photoId`):

oggetto originale, derivati `thumb` e `web`, `FaceEngine.deleteFaces` sugli `external_face_id` di quella foto, righe `faces`, `gallery_items` di quella foto, riga `photos`. Le altre foto restano.

**Retention a 90 giorni** (`POST /api/admin/retention`, corpo `{ "eventSlug" }`):

cutoff = `now() - events.retention_days` (default 90). Per le foto dell'evento con `created_at` anteriore al cutoff si applica la stessa cancellazione della foto (oggetti, derivati, volti Rekognition, link di galleria). Per le ricerche anteriori al cutoff si cancella il selfie residuo, la riga di ricerca e i `gallery_items` rimasti appesi solo a foto già rimosse.

Il contratto **lascia** `users`, `consents` e `audit_log`. Non è un job in coda: in v1 è una chiamata admin sincrona, senza un tipo `jobs` dedicato. Non chiama `DeleteCollection`: i volti si tolgono foto per foto; la collection vuota può restare su Rekognition. Non risulta uno scheduler che la invochi da solo il giorno 90.

Chi vuole una cancellazione secca di email e consensi allo scadere dei 90 giorni non la trova in questo contratto. È un punto aperto, non una promessa già mantenuta.

## 9. Rischi e misure

| Rischio | Misura prevista |
| --- | --- |
| Falso match: una persona vede le foto di un'altra | Soglia 90 inclusiva, applicata due volte (Rekognition e worker). La galleria è solo dell'utente e dell'evento. Il download fallisce tutto se un id non è in galleria |
| Accesso non autorizzato | Bucket privato, niente ACL pubblica. URL firmati 15 minuti. Cookie `HttpOnly`, `SameSite=Lax`, `Secure` solo se `PUBLIC_WEB_URL` è https, solo hash in database. Autorizzazione per ruolo (tabella §3.6 del contratto). Rate limit sui magic link e sui selfie. Task e RDS previsti su subnet private; ALB davanti |
| Galleria troppo larga | Filtro `score >= 90`, un item per foto, niente listing del bucket. `MaxFaces = 50` |
| Trasferimento verso gli USA | Region bloccata su `eu-central-1` per Rekognition, S3, SES, ECS, RDS, SQS. Niente GPU, niente secondo motore, niente Qdrant |
| Selfie che resta in storage | Cancellazione obbligatoria a fine ricerca, anche in errore e anche al retry se la chiave è ancora piena. Il selfie non si indicizza e non si allega alle email |
| Lock-in del modello | Interfaccia `FaceEngine` (`indexPhoto`, `search`, `deleteFaces`). Il primo evento usa l'adattatore Rekognition. Vedi la decisione in §11 |
| Vettori nei log | Divieto di loggare, a livello info, token, cookie, `SESSION_SECRET`, byte del selfie e face id. L'audit non contiene template. L'API Rekognition usata qui restituisce `FaceId`, box e similarità, non il vettore da scrivere su disco nostro |
| Cifratura | A riposo con KMS su RDS e S3; in transito TLS verso AWS e verso i client. Da realizzare nel deploy: non risulta un modulo Terraform in questo repository |

## 10. Rischi residui e punti che il DPO chiude prima del go-live

Nessuna casella sotto è fatta. Non vanno spuntate in questa bozza.

- [ ] Nome, sede e contatti di **[organizzatore della conferenza]**; nomina del DPO se dovuta; autorità di controllo competente e diritto dello Stato membro della sede e del luogo della conferenza (l'art. 9(4) può aggiungere limiti).
- [ ] Sign-off di questa DPIA da parte del DPO e del titolare.
- [ ] Informativa artt. 13–14. La frase versione `2026-10-06` è il testo di prodotto nel contratto, non l'informativa.
- [ ] Registro dei trattamenti, art. 30.
- [ ] Decisione sull'eventuale consultazione preventiva, art. 36. Non è stata avviata.
- [ ] Verifica che il DPA AWS sia accettato sull'account, e lettura della lista subprocessori per i servizi del §7.
- [ ] CloudFront. I PoP possono stare fuori dall'UE anche con origine a Francoforte. Prima del go-live: o gli URL firmati escono da S3 in `eu-central-1`, o la distribuzione è limitata in modo che il DPO accetti. Il vincolo «niente trasferimento extra-UE» non è chiuso finché CloudFront globale è solo un'ipotesi di deploy.
- [ ] Volti di chi non ha acconsentito. `IndexFaces` iscrive fino a 50 volti per scatto, non solo il partecipante che poi farà match. Quei vettori restano fino alla cancellazione della foto o alla retention. Il contratto non li elimina se non corrispondono a un consenso. Serve una decisione: cancellare i `FaceId` senza match, oppure un'altra base che il legale scriva. Oggi non c'è.
- [ ] Revoca dal partecipante. Oggi cancella solo un admin. Manca la rotta di revoca e manca la UI con casella spenta di default.
- [ ] Retention. Tenere email, consensi e audit dopo i 90 giorni è una scelta di accountability da confermare o da rovesciare. Manca chi chiama `POST /api/admin/retention`. Manca `DeleteCollection` a collection vuota.
- [ ] Tasso di falso match reale alla soglia 90, su un campione di foto di conferenza. I gemelli e la luce cattiva restano un rischio residuo anche dopo la misura.
- [ ] `MaxFaces = 50`: con molti volti sopra 90, un match vero può cadere fuori dai 50 restituiti. A soglia 90 è poco plausibile; va detto, non nascosto.
- [ ] Il job `email` in retry può mandare una seconda lettera. Il contratto lo accetta in v1.
- [ ] Finestra in cui il selfie è su S3 mentre il worker è fermo, prima del retry. La misura c'è (il retry cancella); il tempo di giacenza no, non è stato misurato.
- [ ] Cifratura KMS, security group, e condition IAM `aws:RequestedRegion = eu-central-1`: sono misure di questa bozza, non risorse già create.

Rischio residuo che resta anche con le misure: un admin infedele può cancellare o leggere metadati; un match a 90 può comunque essere la persona sbagliata; la lista subprocessori AWS può includere soggetti che il DPO non ha ancora accettato.

## 11. Decisione registrata il 2026-10-06

Il primo evento usa **Amazon Rekognition** dietro l'interfaccia **`FaceEngine`**, adattatore `FACE_ENGINE=rekognition`, collection per evento in `eu-central-1`, soglia 90.

**InsightFace è rinviato.** I pesi pubblici `buffalo_l` sono solo per ricerca non commerciale. Il contratto non prevede un runtime InsightFace. Un eventuale sostituto, se i pesi saranno utilizzabili, resta dietro la stessa interfaccia (`indexPhoto`, `search`, `deleteFaces`), senza cambiare il contratto HTTP.

Il motore `fake` non si usa in produzione.

## 12. Firme

| Ruolo | Nome | Data | Esito |
| --- | --- | --- | --- |
| Titolare | [organizzatore della conferenza] | | non firmato |
| DPO | | | non firmato |
| Redazione tecnica | bozza del 2026-10-06 | 2026-10-06 | non è una sign-off |
