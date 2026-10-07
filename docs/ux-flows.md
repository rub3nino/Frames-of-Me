# RePhoto — Studio dei flussi UX/UI (pre-design)

> Stato: **studio dei flussi, non design**. Qui non si decidono colori, componenti o layout.
> Si decide *chi fa cosa, in che ordine, su quali pagine, con quali stati ed errori*, e
> *cosa manca nell'API* perché il flusso stia in piedi. Il design parte solo dopo
> l'approvazione di questo documento.
>
> Fonti di verità usate: [`docs/v2-spec.md`](v2-spec.md), [`CONTRACTS.md`](../CONTRACTS.md),
> [`apps/api/src/routes.ts`](../apps/api/src/routes.ts), [`docs/DPIA.md`](DPIA.md).
> Dove questo documento e la spec divergono, **vince la spec**; questo file segnala le divergenze come "gap".
>
> Verifica del 2026-10-07 sul codice v2: le rotte, i limiti e i codici di errore citati corrispondono a
> [`CONTRACTS.md`](../CONTRACTS.md). Le pagine descritte sono il flusso *proposto*; quelle implementate
> oggi sono `/` (e-mail partecipante), `/verify`, `/invito`, `/selfie`, `/gallery`, `/e/[slug]`, `/upload`,
> `/admin`. Una precisazione a §5.4: la dedupe `retention:{eventId}` vale per i job accodati dal worker;
> `POST /v1/admin/retention/run` accoda con chiave di dedupe: un secondo clic mentre il job è in coda o in corso restituisce lo stesso job.
>
> Aggiornamento v3 (stesso giorno): il flusso fotografo ha in più la cartella sorvegliata e l'invio a due stadi
> (`docs/v3-uploader-spec.md`, `CONTRACTS.md` → *Two-stage upload* e *Web uploader*). Vedi la nota in §4.2.
>
> Aggiornamento v4 (stesso giorno): lo step selfie del partecipante apre la camera e guida una breve challenge
> prima dello scatto (`docs/v4-selfhost-spec.md` §4, `apps/web/lib/liveness.ts`). Vedi la nota in §3.3; il punto 8 di §9
> («selfie-liveness fuori scope») è superato nei termini descritti lì.

---

## 0. Scenario e vincoli reali

- **1 conferenza, 3 giorni, ~150k JPEG, ~12 fotografi, ~6.000 partecipanti** che cercano le proprie foto con un selfie.
- **3 mondi, 3 ruoli** (`CONTRACTS.md` → `users.role`): `participant`, `photographer`, `admin`.
- **4 admin** (tu + 3) con **capacità identiche**: non servono permessi granulari fra admin, basta che `audit_log.actor_id` registri chi ha fatto cosa.
- **Sessione** unica a cookie (`rephoto_session`, httpOnly, SameSite=Lax). Un browser = un ruolo attivo per volta.
- **L'unica pagina davvero comune è la landing.** Da lì i tre mondi si separano e non si reincrociano quasi mai.

### Assunzioni su dispositivo (da confermare — vedi §9)

Interpretazione della richiesta "versione mobile e desktop, desktop soprattutto per i fotografi":

| Ruolo | Dispositivo primario | Secondario | Perché |
| --- | --- | --- | --- |
| Partecipante | **Mobile** (fotocamera per il selfie, sfoglia e scarica dal telefono) | Desktop | Arriva da QR in sala, ha il telefono in mano |
| Fotografo | **Desktop** (upload massivo, resume, parallelo) | Mobile "scatta-e-carica" leggero | 150k file non si caricano dal telefono |
| Admin | **Desktop** | — | Pannello di gestione, tabelle, import |

Conseguenza progettuale: **il partecipante si disegna mobile-first**, **il fotografo desktop-first**. Non sono la stessa UI ridimensionata.

---

## 1. Mappa generale degli ingressi

Come si *arriva* a ciascun mondo (nessun mondo condivide l'ingresso tranne la landing):

```
                         ┌─────────────────────────────┐
   QR in sala / link  →  │        LANDING (/)          │  ← unica pagina comune
                         └──────────────┬──────────────┘
          ┌─────────────────────────────┼─────────────────────────────┐
          ▼                             ▼                             ▼
   PARTECIPANTE                    FOTOGRAFO                       ADMIN
   (mobile)                        (desktop)                       (desktop)
   ingresso: QR evento            ingresso: email di invito       ingresso: magic link
   + email magic link             /invito?token=…                 (l'utente deve già esistere)
```

Tre canali email distinti entrano nei flussi (template in §6):
1. **Magic link di accesso** — partecipante e admin per autenticarsi.
2. **Invito fotografo** — link `/invito?token=…`.
3. **Notifiche galleria** — "le tue foto sono pronte" (ready) e "ci sono nuove foto" (attach).

---

## 2. Landing page (`/`) — l'unico incrocio

La landing ha **un solo compito**: smistare, senza far sbagliare mondo a nessuno.

Deve rispondere a tre domande, nell'ordine in cui le persone le hanno:

1. **"Sono un ospite e cerco le mie foto"** → CTA primaria, enorme, mobile-first → porta al flusso partecipante dell'evento.
2. **"Sono un fotografo"** → CTA secondaria → porta all'accesso fotografo (in pratica si entra solo via invito; la landing offre "Ho ricevuto un invito" + "Accedi").
3. **"Sono staff/admin"** → link discreto a piè di pagina → accesso admin.

Decisioni di flusso sulla landing:

- La landing **non deve chiedere lo slug dell'evento** al partecipante: lo slug arriva dal QR (`/?e=slug` o direttamente `/e/{slug}`). La CTA partecipante è quindi contestuale all'evento. Se si arriva alla landing *senza* slug (digitata a mano), mostra un campo "codice evento" come fallback, non come percorso principale.
- La landing **non autentica**. Non c'è login in home. Ogni mondo ha il suo ingresso dedicato (magic link / invito). Questo evita la casella "email + password" che qui non esiste proprio (non ci sono password).
- Stato "evento chiuso/retention scaduta": se lo slug non esiste o l'evento è stato ripulito, la landing mostra un messaggio netto ("Questo evento non è più disponibile") e **non** manda avanti nel flusso.

> **Nessun passaggio ripetuto:** la scelta del mondo si fa **una volta sola** qui. Da dentro un mondo non si torna in landing per cambiare ruolo; si fa logout esplicito.

---

## 3. Flusso PARTECIPANTE (mobile-first)

Obiettivo della persona: *"ho sentito che c'erano fotografi, voglio le mie foto e scaricarle"*. Tutto il flusso deve reggere **6.000 persone**, molte poco tecniche, spesso in sala con rete lenta.

### 3.1 Catena di pagine (happy path)

```
QR → /e/{slug}            (pagina evento / iscrizione)
      │  inserisce email + spunta consenso-contatto
      ▼
   "Controlla la mail"     (schermata di attesa, stesso evento in memoria)
      │  apre mail sul telefono → tocca il link
      ▼
   /verify?token=…         (bottone "Entra" → POST verify → sessione)  ← niente consumo automatico del token
      │
      ▼
   /e/{slug}  (ora autenticato) → STEP SELFIE
      │  consenso biometrico esplicito (Art. 9) + scatta/carica selfie
      ▼
   Galleria /e/{slug}  stato = queued  ("Confronto in corso…", polling 5s)
      │
      ▼
   Galleria /e/{slug}  stato = ready   → sfoglia, seleziona, scarica ZIP
```

### 3.2 Il nodo cruciale: ordine di login, consenso, selfie

Dall'API (`CONTRACTS.md`): **il selfie richiede un utente autenticato** *e* **una riga di consenso** (`consents`, `withdrawn_at` null) per quell'evento, altrimenti `403`. Quindi l'ordine è obbligato:

1. **Email** (pre-auth) → `POST /v1/auth/request-link { email, role: "participant" }`. Risposta **sempre** `202` (nessuna enumerazione account). Rate limit v2: max 3 link/email/ora, 20/IP/ora → `429`.
2. **Magic link** → `/verify` mostra un bottone **"Entra"** e fa POST solo al click (difende dagli scanner di link in posta). `POST /v1/auth/verify { token }` crea l'utente `participant` al primo uso e setta il cookie.
3. **Consenso biometrico** → `POST /v1/events/:slug/consent { textVersion, accepted:true }`. Qui si registra `ip` e `user_agent` (lato server). Questo è il consenso *sensibile* (template facciale), diverso dalla spunta "contatto" fatta allo step 1.
4. **Selfie** → `POST /v1/events/:slug/selfie` (multipart). Rate limit **5/ora per email** → `429`. Se `access = list` e l'email non è in `event_participants` → `403`.
5. Parte il job `match` → galleria `queued` → `ready`.

> **Perché due consensi e non uno.** La spunta allo step 1 è base giuridica per *contattare via email* (mandare il link). Il consenso allo step 3 è il consenso **esplicito e granulare** al trattamento del dato biometrico (categoria particolare, Art. 9 GDPR). Vanno tenuti distinti anche se la tabella `consents` ne registra uno per `text_version`. Dettagli GDPR in §7.

> **Attenzione UX (round-trip email in sala).** Il magic link costringe a: digitare email → uscire dall'app → aprire la posta → tornare. Per 6.000 persone con rete di sala è l'attrito n.1. Tre mitigazioni da valutare in §9 senza rompere il contratto: (a) tenere lo **slug e lo stato in `localStorage`** così al ritorno dal link si atterra *già* sullo step selfie, non da capo; (b) testo email ultra-chiaro "torna qui e scatta il selfie"; (c) valutare se il consenso-contatto allo step 1 basti a non ridomandare nulla al ritorno.

### 3.3 Step selfie (dentro `/e/{slug}` autenticato)

- **Mobile:** apri fotocamera frontale inline (`getUserMedia`, `Permissions-Policy: camera=(self)` è già previsto in spec). Fallback: `<input type=file capture=user>` se `getUserMedia` nega.
- Un solo scatto, anteprima, "Usa questa" / "Rifai". Niente upload multiplo: è un selfie.
- Selfie fino a 8 MB (il restringimento sotto 5 MB lo fa il worker). JPEG/PNG.
- Il consenso biometrico è **sulla stessa schermata del selfie**, come checkbox che sblocca il bottone "Trova le mie foto". Non è una pagina separata (evita un passaggio in più) ma è **esplicito** e non pre-spuntato.
- Dopo l'invio: la pagina **non cambia URL**, passa a stato "Confronto in corso…". Niente navigazione nuova = niente passaggio ripetuto.

> **Nota v4 — challenge in camera.** Nella pagina `/selfie` implementata, dopo il consenso la camera frontale si apre
> inline e la persona segue cinque indicazioni, una alla volta, con una barra di avanzamento: «Guarda la camera» →
> «Gira la testa a sinistra» → «Gira la testa a destra» → «Sbatti le palpebre» → «Guarda la camera» (scatto automatico
> quando il viso è frontale, centrato nell'ovale e con gli occhi aperti). Ogni passo ha 15 secondi; allo scadere compare
> «Tempo scaduto. Riprova» e si ripete sulla stessa camera. Il riconoscimento dei punti del volto gira nel browser
> (MediaPipe, file serviti dal nostro dominio): **nessun fotogramma esce dal telefono** prima dello scatto finale, e la
> pagina lo dice («Nessuna immagine esce dal telefono prima dello scatto»). Dopo lo scatto: anteprima, «Invia il selfie»,
> «Rifai lo scatto». Fallback sempre disponibile con «Usa un file invece» (e automatico se la camera è negata, assente,
> o la pagina non è in `https`/`localhost`): il flusso a file di prima, con «Scatta o scegli» e «Scegli un'altra»; da lì
> «Usa la camera» torna alla challenge. L'API riceve con il selfie il campo `liveness = challenge | file` e lo registra
> in `audit_log`: è un'asserzione del client, utile alla DPIA, non un controllo. Il controllo server-side opzionale
> (`LIVENESS_CHECK`) non cambia la UI: un selfie rifiutato arriva a galleria `ready` vuota («Nessuna corrispondenza»),
> stesso stato dell'edge case «Nessun match» in §3.6; il partecipante può rifare il selfie entro il limite di 5/ora.
> Attrito aggiunto: ~10–20 secondi e il permesso camera del browser; da misurare in sala quanti scelgono il file.

### 3.4 Galleria (`/e/{slug}`) — stati e azioni

Stati da `GET /v1/events/:slug/gallery` → `status`: `empty` | `queued` | `ready`.

- **`queued`**: banner "Confronto in corso…", polling ogni **5s** finché `ready`. Nessuna azione.
- **`empty`**: l'utente è autenticato ma non ha ancora fatto il selfie → in realtà qui si mostra lo **step selfie** (3.3), non una galleria vuota.
- **`ready`**: griglia a scorrimento infinito (`IntersectionObserver` + `nextCursor`, limit 60, max 200). Thumbnail lazy. Due gruppi per punteggio:
  - **"Le tue foto"** (score ≥ 0.9)
  - **"Forse sei tu"** (0.8 ≤ score < 0.9), collassabile.
- **Selezione**: checkbox per foto, "Seleziona tutte (gruppo)", "Annulla", contatore in barra azioni.
- **Download**:
  - ZIP di una selezione → `POST /v1/events/:slug/gallery/zip` tramite **form POST nascosto** (navigazione, il browser gestisce lo stream). Scelta variante: **"Originali"** / **"Per il web"**. Max **500** per ZIP; oltre → la UI chiede di selezionarne meno.
  - Singola foto dal viewer → `POST .../gallery/download` → apre l'URL firmato.
- **"Nuove foto"**: badge sugli item con `source = attach` più recenti dell'ultima visita (`localStorage` per slug). Quando arrivano nuove foto mentre la pagina è aperta → toast "Nuove foto".

### 3.5 Ritorno del partecipante (sessioni successive)

Il partecipante torna **senza rifare selfie**:
- da **email "nuove foto"** → link diretto `/e/{slug}` (se la sessione cookie è viva, entra; se scaduta, rifà solo il magic link — **mai** un nuovo selfie, la galleria esiste già).
- La galleria è persistente (`galleries` + `anchor_face_ids`): foto caricate *dopo* il suo selfie si agganciano da sole (job `attach`) e compaiono senza azione sua.

### 3.6 Edge case partecipante (da gestire esplicitamente nel design)

| Situazione | Causa API | Cosa deve vedere/fare |
| --- | --- | --- |
| Evento ad accesso ristretto, email non in lista | selfie `403` (`access=list`) | Messaggio "Il tuo indirizzo non è in elenco per questo evento" + contatto staff. **Scoperto solo allo step selfie** perché `request-link` è sempre `202` → vedi gap §9 |
| Troppi tentativi link | `request-link` `429` | "Hai richiesto troppi link, riprova tra un'ora" |
| Troppi selfie | selfie `429` (5/ora) | "Hai già cercato più volte, riprova più tardi" |
| Link scaduto/già usato | verify `400` | "Link scaduto, richiedine uno nuovo" → torna allo step email |
| Nessun match | `ready` con 0 item | "Non abbiamo trovato foto con te. Riprova con un selfie più chiaro / torna più tardi" + bottone "Riprova selfie" |
| Revoca consenso / cancellazione | `consents.withdrawn_at`, delete partecipante | Pagina "Gestisci i miei dati": revoca consenso + richiesta cancellazione (vedi §7) |
| Foto ancora in elaborazione dai fotografi | galleria `ready` ma incompleta | "Le foto vengono aggiunte man mano: ti avvisiamo via email" |

---

## 4. Flusso FOTOGRAFO (desktop-first)

Obiettivo: *"caricare migliaia di foto il più velocemente possibile, sapere cosa è andato e cosa no, poter riprendere se si interrompe"*. Non naviga molto: vive in **una** schermata di lavoro.

### 4.1 Ingresso: solo su invito

Non esiste auto-registrazione fotografo. L'unico modo per creare un fotografo è **accettare un invito** (`CONTRACTS.md`).

```
Admin invita  →  email con /invito?token=…
                      │  fotografo apre il link, click "Accetta"
                      ▼
            POST /v1/auth/accept-invite { token }
              (crea utente photographer se manca, inserisce event_photographers,
               marca used_at, crea sessione + cookie)
                      │
                      ▼
                   /upload   (già dentro, pronto a caricare)
```

Accessi successivi: **magic link** `role: photographer` — la mail parte **solo se l'utente esiste già** (è stato creato dall'invito). Verify per photographer su utente inesistente → `400` generico.

### 4.2 Schermata di upload (`/upload`) — desktop

È il cuore del mondo fotografo. Un'unica pagina, nessun wizard.

Elementi di flusso (da `v2-spec.md` §6):
- **Scelta evento**: il fotografo può essere invitato a più eventi (`event_photographers`). Se ne ha più d'uno, un selettore evento in testa; se uno solo, è preselezionato. L'upload richiede membership (`uploads/init` → `403` se non membro).
- **Drag & drop** di cartelle/file. Validazione: **jpeg/png**, max **60 MiB**, file vuoti rifiutati, duplicati nello stesso drop collassati.
- **Hashing sha256 in streaming** (`hash-wasm`, slice 4 MiB) → memoria piatta anche a 60 MiB.
- **Dedupe locale (IndexedDB)**: fingerprint `name|size|lastModified`. Al ri-drop: salta l'hash se già noto; salta l'upload se server dice `409` o stato locale `sent`.
- **Parallelismo**: fino a **4** file in volo, parti sequenziali per file.
- **Resume**: file in `error` → azione "Riprova"; "Riprova tutti" rilancia i falliti.
- **Lista windowed** (render solo righe visibili) perché le righe sono migliaia.
- **Progresso aggregato**: `caricate / totali`, MB/s, ETA.
- **Pannello stato**: polling `GET /v1/uploads/summary` ogni **10s** (non la lista intera): sessioni `{open, completed, aborted}` + foto `{uploaded, processing, indexed, error}`. Storico sessioni dietro "Mostra storico" (`GET /v1/uploads` paginato).

> **Nota v3 — cartella sorvegliata.** La stessa pagina ha ora un secondo ingresso oltre al drag & drop: la sezione «Cartella sorvegliata» (solo Chrome/Edge; altrove una riga spiega di usare Chrome o Edge). Il fotografo sceglie una volta la cartella in cui salva gli scatti, preme «Avvia» e la pagina la rilegge ogni 10 s caricando da sola ogni nuovo file, anche per giorni; «Pausa», «Riprendi», «Ferma», «Rimuovi cartella»; al ritorno sulla pagina «Riprendi `<nome>`» riautorizza la cartella con un clic e riprende anche gli originali ancora dovuti. Sopra la zona di drop c'è l'interruttore «Prima il web, poi gli originali» (acceso di default dove il browser sa renderizzare): la versione da 1600 px parte subito e i partecipanti si trovano in pochi secondi, gli originali seguono quando la coda è libera; nel frattempo il pannello stato mostra `originalsPending` e la galleria del partecipante segna quelle foto «solo web». Il parallelismo non è più fisso a 4: parte da 2 e si adatta tra 1 e 6 alla banda disponibile. La pagina si può installare come app («Installa come app») e tiene lo schermo acceso mentre carica. La macchina a stati di §4.3 guadagna uno stato intermedio «Web inviata» tra `complete` del primo stadio e l'invio dell'originale.

### 4.3 Macchina a stati di un file (ciò che il fotografo capisce a colpo d'occhio)

```
 in coda → hashing → init → upload(parti) → complete → SERVER:
                                                        uploaded → processing → indexed
 ogni step può → error (con "Riprova")
 duplicato (409) → "già caricata" (non è un errore)
```

Il fotografo **non deve vedere** il mondo riconoscimento facciale: a lui interessa solo "caricata e accettata dal server" (`uploaded`/`indexed`) vs "da ripetere" (`error`). Il resto (derive/index/attach) è server-side.

### 4.4 Versione mobile del fotografo (secondaria)

Interpretazione: esiste ma leggera. Caso d'uso: fotografo che vuole buttare dentro pochi scatti al volo dal telefono. Stessa `/upload` responsive, ma:
- niente drag&drop cartelle (sul telefono si usa il picker/galleria),
- stessa pipeline init/parts/complete,
- il grosso (150k) resta desktop.

Da confermare in §9 se la versione mobile fotografo è richiesta al lancio o è "fase 2".

### 4.5 Edge case fotografo

| Situazione | Causa API | Cosa deve vedere/fare |
| --- | --- | --- |
| Non invitato a quell'evento | `uploads/init` `403` | "Non sei abilitato a caricare per questo evento" |
| Foto già presente | `409` su `(event_id, sha256)` | "Già caricata" — conteggiata come ok, non come errore |
| File troppo grande | `init` `400` (> 60 MiB) | Rifiuto in locale prima dell'upload |
| Byte non combaciano al complete | `complete` `400`, sessione `aborted` | "Caricamento corrotto, riprova" |
| Interruzione/chiusura tab | sessioni `open` → `aborted` dopo 24h (housekeeping) | Al rientro, resume dei falliti via dedupe locale |
| Invito scaduto/già usato | `accept-invite` `400` | "Invito non valido, chiedi un nuovo invito allo staff" |

---

## 5. Flusso ADMIN (desktop, 4 persone con pari poteri)

Obiettivo: *"configurare l'evento, far entrare i fotografi, (se serve) limitare l'accesso, tenere d'occhio i numeri, rispettare il GDPR"*. 

### 5.1 Ingresso admin

Magic link `role: admin`. **L'utente admin deve già esistere** (oggi solo via seed). La mail parte solo se esiste. → **Gap critico §9: non c'è modo via UI/route di creare i 3 admin aggiuntivi.**

### 5.2 Pannello admin (`/admin`) — sezioni

Mappa delle sezioni che l'admin deve avere, con a fianco **cosa l'API supporta oggi**:

| Sezione | Azione | Endpoint | Esiste? |
| --- | --- | --- | --- |
| **Dashboard** | metriche live | `GET /v1/admin/metrics` (v2: + jobsRunning, jobsError, photosByStatus, galleries) | ✅ |
| **Eventi** | vedere elenco eventi | — | ❌ **manca list** |
| **Eventi** | creare evento | — | ❌ **manca create** (oggi solo seed/migration) |
| **Eventi** | cambiare accesso open/list, retentionDays | `PATCH /v1/admin/events/:id` | ✅ |
| **Fotografi** | invitare fotografo | `POST /v1/admin/photographers/invite` (v2: manda la mail `/invito?token=`) | ✅ |
| **Fotografi** | elenco fotografi / revoca | — | ❌ **manca** |
| **Partecipanti** | import lista (accesso ristretto) | `POST /v1/admin/participants/import { eventId, emails[1..5000] }` | ✅ |
| **Partecipanti** | elenco / rimozione singola | `DELETE /v1/admin/participants/:id` (cancellazione utente) | parziale (no list) |
| **Foto** | eliminare una foto | `DELETE /v1/admin/photos/:id` (+ audit) | ✅ |
| **Foto** | moderare/cercare foto | — | ❌ **manca browse foto admin** |
| **Retention** | forzare pulizia evento | `POST /v1/admin/retention/run { eventId }` | ✅ |
| **Audit** | vedere chi ha fatto cosa | `audit_log` tabella | ❌ **manca read** |

### 5.3 Flussi admin principali (happy path)

**A. Preparare un evento (prima della conferenza)**
```
/admin → Eventi → (crea evento)*  → imposta accesso open|list, retention
      → Fotografi → invita i 12 fotografi (email) 
      → se access=list: Partecipanti → incolla lista email (textarea, 1 per riga) → import
```
`*` passaggio che **oggi non ha endpoint** → va aggiunto o l'evento si crea a mano via seed/SQL (non accettabile per un prodotto a 4 admin).

**B. Durante la conferenza (monitoraggio)**
```
/admin → Dashboard → guarda photosByStatus (uploaded/processing/indexed/error),
                      jobsRunning, jobsError, galleries, coda
      → se jobsError sale → capire quale foto è in error (serve browse foto → gap)
```

**C. Dopo / GDPR**
```
Richiesta cancellazione partecipante → DELETE /v1/admin/participants/:id (cancella utente, gallerie, consensi, sessioni; le foto di gruppo restano)
Fine ciclo di vita evento → Retention → run  (worker cancella foto oltre retention, poi deleteCollection quando l'evento è vuoto)
Una foto da rimuovere (soggetto che la contesta) → DELETE /v1/admin/photos/:id
```

### 5.4 Concorrenza fra i 4 admin

Pari poteri, nessun lock applicativo. Rischi bassi ma da gestire in UI:
- due admin che importano liste → upsert idempotente, ok.
- due admin che lanciano retention sullo stesso evento → job `dedupe_key` `retention:{eventId}` ⇒ un solo job. Ok.
- la UI mostri **chi** ha fatto l'ultima azione (da `audit_log`) per evitare sovrapposizioni.

### 5.5 Edge case admin

| Situazione | Nota |
| --- | --- |
| Retention su evento con job attivo | deduplicato, nessun doppione |
| Delete partecipante | NON cancella le foto di gruppo (scelta di contratto) — va spiegato in UI |
| Delete foto | irreversibile (S3 + Rekognition) → doppia conferma obbligatoria |
| Import 5000 email | limite hard a 5000/chiamata → UI avvisa se incolli di più |

---

## 6. Template email (3 canali)

Tutte in italiano. `WEB_ORIGIN` è la base dei link.

| # | Trigger | Oggetto | Corpo (contenuto minimo) | Destinatario |
| --- | --- | --- | --- | --- |
| 1 | `POST request-link` (participant/admin) | "Accedi a RePhoto" | bottone/link `/verify?token=…` + "vale X minuti, non condividerlo" | chi chiede il link |
| 2 | `POST admin/photographers/invite` | "Sei stato invitato come fotografo" | link `/invito?token=…` + nome evento | fotografo |
| 3 | job `email` kind `ready` | **"Le tue foto sono pronte"** | solo link galleria `/e/{slug}` | partecipante dopo match |
| 4 | job `email` kind `new` | **"Ci sono nuove foto per te"** | solo link galleria `/e/{slug}` | partecipante quando `attach` aggiunge foto (max 1 ogni 6h, `notified_at`) |

Note di flusso email:
- Oggetti 3 e 4 sono **già fissati dalla spec** (§2.7): non reinventarli.
- Il corpo di 3 e 4 è **solo il link** per spec. In design si può arricchire ma senza cambiare il significato.
- Email 1 (magic link): la pagina `/verify` **non consuma il token al caricamento** (anti-scanner) → il template non deve suggerire "il link si attiva da solo".
- Niente dati personali in querystring oltre al token monouso (vincolo privacy della spec/CSP).

---

## 7. GDPR come attraversa i flussi

Il GDPR non è una pagina, è una **serie di checkpoint** dentro i flussi. Dal `DPIA.md` e dal contratto:

1. **Consenso-contatto** (step email partecipante): base per inviare il magic link.
2. **Consenso biometrico esplicito** (step selfie): categoria particolare Art. 9. Checkbox non pre-spuntata, con link all'informativa, `text_version` registrata insieme a `ip`/`user_agent` lato server (`POST .../consent`). Il selfie è bloccato (`403`) senza questa riga.
3. **Minimizzazione**: nessun embedding salvato (solo `anchor_face_ids` = FaceId Rekognition delle proprie foto). Il selfie viene **cancellato** dopo il match. Da dire chiaramente all'utente ("il selfie non viene conservato").
4. **Revoca**: pagina "I miei dati" per il partecipante → revoca consenso (`withdrawn_at`) e richiesta cancellazione. (Endpoint di self-service revoca: **gap §9** — oggi la cancellazione è `DELETE admin/participants/:id`, cioè passa dall'admin.)
5. **Accesso ristretto** (`access=list`): solo email in `event_participants` possono fare selfie → tutela chi non vuole essere cercato da estranei.
6. **Retention**: cancellazione automatica oltre `retention_days`; `deleteCollection` quando l'evento è vuoto.
7. **Cookie/consenso tecnico**: sessione solo cookie tecnico httpOnly → se non si usano analytics, niente banner cookie invasivo (scelta più privacy-friendly di default, coerente con le regole).

**Checkpoint GDPR per pagina:**

| Pagina | Obbligo GDPR |
| --- | --- |
| Landing | link informativa visibile |
| Iscrizione (email) | consenso-contatto + link informativa |
| Selfie | consenso biometrico esplicito + "il selfie non è conservato" |
| Galleria | link "I miei dati" (revoca/cancellazione) |
| Admin partecipanti | tracciare import come base lecita; audit |

---

## 8. Mappa di navigazione e transizioni (anti-passaggi-ripetuti)

Sitemap per ruolo. "→" = transizione prevista; in **grassetto** le pagine dove si *resta* (no nuova navigazione).

**Partecipante**
```
/  →  /e/{slug} (iscrizione)  →  [attesa email]  →  /verify  →  **/e/{slug}** (selfie → queued → ready, stessa pagina)
         ↑ ritorno da email "nuove foto" direttamente qui
accessorie: /e/{slug}/i-miei-dati  (revoca/cancellazione)
```
Punti dove si evita la ripetizione:
- Selfie, "confronto in corso", galleria **sono la stessa URL** `/e/{slug}` a stati diversi. Niente wizard a più pagine.
- Il consenso biometrico vive **nella** schermata selfie, non in una pagina a parte.
- Al ritorno dal magic link si atterra **già** sullo step giusto (stato in `localStorage`), non da capo.

**Fotografo**
```
[email invito] → /invito → **/upload**  (si vive qui)
accessi successivi: / → "accedi fotografo" → [email magic link] → /verify → /upload
```
- Una sola pagina di lavoro. Nessun passaggio avanti/indietro.

**Admin**
```
/ → "staff" → [email magic link] → /verify → **/admin** (sezioni a tab, non pagine separate)
```
- Tutte le funzioni admin come **tab/pannelli dentro `/admin`**, non pagine che si rincorrono.

Regola generale: **un cambio di mondo = logout esplicito**, mai un rimbalzo in landing. Chi è loggato come fotografo non vede ingressi partecipante/admin e viceversa (`require-role`).

---

## 9. Punti aperti e decisioni da prendere (prima del design)

Ordinati per impatto sul flusso. Questi sono i punti dove il flusso "ideale" tocca i **limiti dell'API attuale** o dipende da una tua scelta.

### Gap API da colmare (altrimenti certi flussi non esistono)
1. **Creazione evento**: nessuna rotta `POST /v1/admin/events`. Oggi gli eventi nascono solo da seed/migration. Senza questa, l'admin non può preparare una conferenza da UI. → **Serve nuovo endpoint** (additivo).
2. **Elenchi admin**: niente `GET` per elenco eventi, fotografi, partecipanti, foto in `error`, audit. La dashboard admin oltre ai contatori ha bisogno di *liste*. → **Servono endpoint di lettura**.
3. **Bootstrap admin**: non c'è modo di creare i 3 admin aggiuntivi via UI (solo seed). → Decidere: seed esteso, oppure un "invita admin" simile a `photographers/invite`.
4. **Self-service GDPR partecipante**: revoca consenso e richiesta cancellazione oggi passano dall'admin. → Decidere se serve un endpoint di self-service (consigliato per 6.000 utenti).
5. **Accesso ristretto scoperto tardi**: con `access=list`, l'utente scopre di non essere in lista solo al selfie (`403`), dopo aver già fatto email+link+consenso. `request-link` resta `202` per non enumerare. → Decidere il messaggio e se accettare questo attrito (alternativa: avviso generico in pagina iscrizione per eventi ristretti).

### Decisioni di prodotto (tue, cambiano i flussi)
6. **Mobile fotografo**: al lancio o fase 2? (§4.4)
7. **Round-trip magic link in sala**: accettiamo l'attrito o investiamo su atterraggio-sullo-stato (§3.2)? Nessuna delle mitigazioni rompe il contratto.
8. **Selfie-liveness**: la spec la mette fuori scope (serve Amplify UI). → Confermare che al lancio NON c'è liveness (rischio: foto di foto).
9. **Un solo evento o più**: lo studio assume 1 conferenza ma il modello regge N eventi. Confermare se la UI deve già gestire il multi-evento (cambia il selettore evento in fotografo/admin).

---

## 10. Cosa serve come prossimo passo (dopo l'ok a questo studio)

1. Validare §9 (gap API + decisioni) — alcune bloccano interi flussi admin.
2. Trasformare questo studio in **wireframe a bassa fedeltà** per le 3 pagine cardine: iscrizione+selfie (mobile), upload (desktop), admin (desktop).
3. Solo dopo: design system, componenti, visual.

> Finché §9 punti 1–2 non sono decisi, il mondo **admin** non è disegnabile per intero: mancano gli endpoint che le sue schermate consumerebbero.
