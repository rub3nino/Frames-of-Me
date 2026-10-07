# RePhoto — Vetrina / Showcase: Information Architecture & Content Spec

> **Status:** deep analysis / content & IA reference, pre-design. This is the spec that decides *what the
> public-facing showcase website must contain and say* for a real event of the
> **Conferința Europeană de Tineret și Familii** type (2026 theme **BIRUITORI**). It does **not** decide
> colours, components or layout — that is [`design/brand/DESIGN.md`](../../design/brand/DESIGN.md).
>
> **Grounding (sources of truth):** the real event site <https://conferintaeuropeana.it>;
> [`CONTRACTS.md`](../../CONTRACTS.md) (the frozen v4 product: roles `participant|photographer|admin`,
> `events.access = open|list`, `event_participants` allowlist, `consents`, selfie deleted after match,
> `retention_days`, galleries split 0.9 / 0.8); [`docs/ux-flows.md`](../ux-flows.md) (participant /
> photographer / admin flows, `/e/{slug}`, magic link, two consents); [`docs/DPIA.md`](../DPIA.md)
> (biometric lawfulness); [`design/brand/DESIGN.md`](../../design/brand/DESIGN.md) (tone only).
>
> **Language convention of this document:** user-facing labels and copy are written in **Italian**
> (the product UI is Italian, `@rephoto/web`), with the **RO/IT/EN** triad noted where it matters.
> Structural / rationale notes are in **English**.
>
> **Scale assumed (from the real event + ux-flows):** 4000+ partecipanti, 15+ paesi, ~3000 posti,
> **età minima 14 anni**, minori con consenso dei genitori; diaspora romena, evento in Italia (telefono
> +39), carattere comunitario/religioso. ~150k foto, ~12 fotografi, 3 giorni.

---

## 0. The one thing to understand first

The real conference site **has no photo gallery and no media section at all**. That absence is not a
gap to patch — it is the entire reason RePhoto's vetrina exists. The conference already has an
authoritative site for *registration and logistics*. RePhoto's showcase is not a clone of it; it is the
**memory layer** the conference never had: *"4000 persone, tre giorni, migliaia di foto — ritrova le tue
in dieci secondi con un selfie."*

Everything below optimises for that wedge: a showcase that (a) tells the story of the event and its
community, (b) previews past-edition photography as proof, and (c) funnels every visitor into the one
action only RePhoto can offer — **«Trova le tue foto»**.

---

## 1. Positioning — whose site is this?

### 1.1 Decision: **both**, with a clear primary axis

The vetrina is a **hybrid event-showcase + photo-service landing**, but the two are not equal:

| Layer | Weight | What it does |
| --- | --- | --- |
| **Event showcase** (the story) | ~40% | Legitimises RePhoto by speaking the event's own language: theme BIRUITORI, community stats, past editions, organisers. Makes a diaspora family trust it in 5 seconds. |
| **Photo service** (the action) | ~60% | Converts that trust into the single action RePhoto owns: selfie → match → gallery → download. This is the business. |

**Why both and not one.** A pure service landing ("upload a selfie") has no reason to be believed by a
religious-community, family audience that has never heard of RePhoto. A pure event clone competes with
the real conference site and loses. The hybrid borrows the event's credibility to sell the service.

> **Boundary rule (critical).** The vetrina must **never present itself as the official registration
> site** of the conference. Registration, pricing and accommodation belong to the organisers. The vetrina
> either (a) links out to the official registration, or (b) hosts a clearly-labelled *mirror* of
> practical info with a visible "fonte ufficiale / sursa oficială" link. This avoids both legal confusion
> and the impression of impersonating the organisers.

### 1.2 Primary goal per visitor type

| Visitor | Arrives via | Their one question | The site's job |
| --- | --- | --- | --- |
| **Partecipante (durante/dopo l'evento)** | QR in sala, link in chat di gruppo, email | *"Dove sono le mie foto?"* | Get them to `/e/{slug}` → selfie → gallery, fast, on mobile. **Primary conversion.** |
| **Partecipante / famiglia (prima dell'evento)** | Passaparola, social, newsletter | *"Cos'è, posso fidarmi, ci sarà un modo di avere le foto?"* | Build trust + capture email (newsletter / pre-registration of interest), set expectation "le foto saranno qui". |
| **Genitore di minore (14–17)** | Same as above | *"È sicuro per mio figlio? Chi vede la sua faccia?"* | Reassure: consenso genitoriale, selfie non conservato, accesso ristretto, diritti. **Trust is the conversion here.** |
| **Capogruppo / leader di chiesa** | Organiser briefing | *"Come faccio avere le foto al mio gruppo?"* | Explain the group/allowlist model (`access=list`, `event_participants`), give them a shareable link + instructions. |
| **Fotografo** | Email di invito | *"Dove carico?"* | A thin public page that routes to `/invito` / `/upload`; mostly out of the public funnel. |
| **Organizzatore / stampa** | Direct | *"Chi c'è dietro, è serio, è conforme?"* | Organisers/about, GDPR/DPIA references, contatti. |
| **Staff / admin** | Direct | — | Discreet footer link to admin login. |

### 1.3 How the service is woven across the event timeline

The same site reads differently in three phases; copy and the hero CTA must adapt (ideally driven by
event state / date, else by an admin-set flag):

- **PRIMA (teaser / attesa).** No photos yet. Hero sells the *promise* + past-edition proof. CTA =
  **«Avvisami quando le foto sono pronte»** (newsletter) and/or **«Scopri com'è»**. Explain the selfie
  flow as "come funzionerà".
- **DURANTE (live).** Photographers uploading; the two-stage uploader means web-size photos appear within
  seconds. Hero CTA becomes **«Trova le tue foto»** → `/e/{slug}`. A live counter ("già N foto caricate")
  is strong social proof.
- **DOPO (archivio).** The gallery is the product. Hero = **«Le tue foto della conferenza 2026»**, past
  editions move up, newsletter pivots to "ti avvisiamo quando aggiungiamo foto" (ties to the `attach`
  job + email kind `new`).

---

## 2. Full sitemap & navigation

### 2.1 Top navigation (menu principale)

Labels in **Italiano** (primary UI), with **RO** and **EN** equivalents for the multilingual build.
The nav is deliberately short; the photo action is a **button**, visually distinct from nav links
(DESIGN.md: one blue CTA, used with rarity).

| # | IT label (nav) | RO | EN | Route | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | **Le tue foto** *(CTA, pill accent)* | **Pozele tale** | **Your photos** | `/e/{slug}` (or `/foto`) | The primary action. Always visible, right-aligned, accent. This is RePhoto's reason to exist. |
| 2 | La conferenza | Conferința | The conference | `/conferenza` | What it is, theme BIRUITORI 2026. Dropdown → Tema, Giornate, Ospiti. |
| 3 | Programma | Program | Programme | `/programma` | Conference days / agenda. |
| 4 | Ospiti | Invitați | Guests | `/ospiti` | Speakers / special guests. |
| 5 | Informazioni pratiche | Informații practice | Practical info | `/info` | Alloggio & prezzi, iscrizioni, logistica (mirror + link ufficiale). |
| 6 | Edizioni precedenti | Ediții anterioare | Previous editions | `/edizioni` | 2019→2025, **each with its photo gallery** — the proof. |
| 7 | Community | Comunitatea | Community | `/community` | Stats 4000+/15+ paesi, organizzatori, chi siamo. |
| 8 | FAQ | Întrebări frecvente | FAQ | `/faq` | Split: evento + **FAQ foto/privacy**. |
| 9 | Contatti | Contact | Contact | `/contatti` | |
| — | *Language switcher* | RO · IT · EN | | — | Top-right, persistent. |

**Nav rationale.** "Le tue foto" is pulled out as the hero action, not buried in a dropdown — it is the
only thing competitors (and the real conference site) don't have. Conference / Programma / Ospiti mirror
the real site's "2026 Conference (Biruitori)" subsections so a returning visitor feels at home. "Edizioni
precedenti" is load-bearing: it is where photo galleries live and the service proves itself.

### 2.2 Footer navigation

Four columns + a legal strip. Footer carries everything secondary and all legal/trust links.

| Column | IT items |
| --- | --- |
| **Conferenza** | Tema BIRUITORI · Programma · Ospiti · Informazioni pratiche · Iscrizioni (link ufficiale) |
| **Foto** | Trova le tue foto · Come funziona · FAQ foto · Gestisci i miei dati · Per i fotografi |
| **Community** | Chi siamo / Organizzatori · Edizioni precedenti · Newsletter · Sostenitori |
| **Contatti** | Email · Telefono (+39…) · Sede · Social |
| **Legal strip** | © 2026 · Informativa privacy · Termini · Cookie · Informativa minori · Accessibilità · *Area staff* (discreet admin link) |

The newsletter signup sits in the footer on every page (persistent capture), plus a dedicated section
on the homepage and the "prima" phase.

### 2.3 Reconciling the real conference sections with the photo service

| Real conference site section | In the vetrina | How it changes |
| --- | --- | --- |
| Homepage | `/` | Re-composed to lead with the photo promise (see §3). |
| 2026 Conference (Biruitori) → Tema, Giornate, Ospiti, Alloggio & prezzi, Iscrizioni | `/conferenza`, `/programma`, `/ospiti`, `/info` | Kept, but Iscrizioni **links to / mirrors** the official registration (not RePhoto's job). |
| Previous Editions (2019→2025) | `/edizioni` | **Upgraded**: each edition gains a photo gallery — the single biggest add. |
| FAQ | `/faq` | Extended with a dedicated **photo-service / privacy FAQ**. |
| Contacts | `/contatti` | Kept. |
| Newsletter | footer + `/` + `/community` | Kept; repurposed as "ti avvisiamo quando le foto sono pronte". |
| Organizers (Philadelphia Mansue, Dept. for Romanians Abroad) | `/community` (Organizzatori/About) | Kept; add RePhoto as the photo-service provider + data processor note. |
| *(none)* **Photo gallery / media** | **`/e/{slug}` + `/edizioni/*` galleries** | **New — the whole opportunity.** |

---

## 3. Homepage composition (`/`) — every section, in order

Design intent (DESIGN.md): photo-led, Apple/Pic-Time calm, **one** blue CTA, the single authored
"Recognition" moment in the hero. Order below is the scroll order.

| # | Section | Contains | Why it's here / placement rationale |
| --- | --- | --- | --- |
| 1 | **Hero — Recognition** | Full-bleed wall of real event photos; the authored "lock-on" animation resolves matching faces into a clean grid. H1: **«Ritrova le tue foto della conferenza»** (phase-aware: «…saranno qui» prima / «Le tue foto 2026» dopo). Sub: one line on how (selfie → match → download). **Primary CTA: «Trova le tue foto»** (accent pill) → `/e/{slug}`. Secondary text link: «Come funziona». | The promise must be *shown* in the first viewport, not claimed (DESIGN.md §9). The CTA is the page's reason to exist. |
| 2 | **Come funziona (3 passi)** | Three steps, photo-first, no icon-card trio (banned): **1. Scatta un selfie · 2. Ti riconosciamo tra migliaia di foto · 3. Scarichi le tue.** Each with the key reassurance inline: *"il selfie non viene conservato."* | Removes the "is this creepy?" fear immediately, before the family audience bounces. |
| 3 | **Social proof / Community** | Stat row: **4000+ partecipanti · 15+ paesi · 7 edizioni · N foto caricate** (live count during the event). Short line on the community character. | The real site's "Our Community" block, reused as trust. Numbers are concrete and true. |
| 4 | **La conferenza 2026 — BIRUITORI** | Theme teaser, dates, location, one strong image. CTA → `/conferenza`. | Anchors the showcase in the real event; legitimises the service. |
| 5 | **Anteprima edizioni precedenti** | A curated strip of past-edition photos (2019→2025), each linking to that edition's gallery. "Guarda le foto di ogni edizione." | **Proof the service delivers** — real photos, browsable now, even before 2026 has any. Critical for the "prima" phase when there are no 2026 photos yet. |
| 6 | **Ospiti / speaker (teaser)** | 3–4 special guests with photo + name; CTA → `/ospiti`. | Mirrors the real site; adds faces/draw. |
| 7 | **Per i capigruppo** *(conditional, if `access=list`)* | Short block: "Organizzi un gruppo? Ecco come i tuoi far accedere alle foto." → `/info#capigruppo`. | The allowlist model needs a human explanation somewhere prominent. |
| 8 | **Trust & privacy (famiglie e minori)** | Calm band: "Pensato per famiglie. Consenso dei genitori per i minori di 18 anni. Il selfie non si conserva. Puoi cancellare i tuoi dati quando vuoi." Links → Informativa minori, Gestisci i miei dati. | The youth/family + religious audience needs this *before* converting. Given the minors angle, it earns a homepage slot, not just the footer. |
| 9 | **Newsletter** | Email capture: «Ti avvisiamo quando le foto sono pronte» (prima) / «Resta aggiornato sulle prossime edizioni» (dopo). Consent checkbox, link informativa. | Captures the "prima" visitor who can't convert yet. |
| 10 | **Organizzatori / sostenitori** | Logos: Philadelphia Mansue, Department for Romanians Abroad, RePhoto as photo partner. | Credibility + funding transparency. |
| 11 | **Footer** | Full footer (§2.2). | |

**Where the CTA lives:** persistent in the top nav (pill) + hero (primary) + repeated after §2 ("Come
funziona") and in §5 (edizioni). Three to four placements max — rarity keeps the accent strong.

---

## 4. Every other page — purpose, required information, content blocks

### 4.1 `/e/{slug}` — «Le tue foto» (the photo-service landing + flow) — **the heart**

**Purpose.** Convert a visitor into a matched gallery. This is the live product surface already described
in [`ux-flows.md`](../ux-flows.md) §3; the vetrina frames its entry.

**Must contain (entry / pre-auth state):**
- Event identity: nome conferenza, edizione, date, a few hero photos.
- The 3-step explainer (selfie → match → download) + **«il selfie non viene conservato»**.
- **Email capture → magic link** (`POST /v1/auth/request-link`, role participant; always `202`).
- **Consenso-contatto** checkbox (base for the email) — distinct from the biometric consent later.
- For `access=list` events: a visible notice "Questo evento è riservato ai partecipanti registrati" so
  non-listed users aren't surprised by a `403` only at the selfie step (ux-flows §9 gap #5).
- Age gate copy: **«Hai almeno 14 anni? I minori di 18 hanno bisogno del consenso di un genitore.»**

**Authenticated states (same URL, state machine):**
- **Selfie step** — camera challenge (v4 liveness) + **consenso biometrico esplicito (Art. 9)** on the
  same screen; "nessuna immagine esce dal telefono prima dello scatto"; file fallback.
- **`queued`** — «Confronto in corso…», polling 5s.
- **`ready`** — gallery split **«Le tue foto»** (score ≥ 0.9) / **«Forse sei tu»** (0.8–0.9), selection,
  ZIP download (Originali / Per il web), single download, "nuove foto" badges.
- **Empty / no-match** — «Non abbiamo trovato foto con te» + «Riprova selfie».
- Link **«Gestisci i miei dati»** (revoca consenso, cancellazione).

### 4.2 `/foto` or `/come-funziona` — public explainer for the service

**Purpose.** The marketing/explainer page for the photo service, for someone not ready to act or who
wants to understand before giving an email. (Distinct from `/e/{slug}` which *is* the flow.)

**Content blocks:** the mechanism in plain language; an animated/illustrated walkthrough; privacy
promises up front (selfie not kept, biometric consent, minors, accesso ristretto); "cosa serve" (uno
smartphone, la tua email); "cosa NON facciamo" (no vendita dati, no pubblicità, no riconoscimento oltre
l'evento); a prominent «Trova le tue foto» CTA; link to FAQ foto.

### 4.3 `/conferenza` — La conferenza (BIRUITORI 2026)

**Purpose.** Tell the story of the 2026 event. Mirrors the real "2026 Conference" hub.

**Required info:** titolo + tema **BIRUITORI** e suo significato; date e sede; a chi è rivolta (famiglie +
youth, età min. 14); carattere della conferenza (comunitario/spirituale); dimensione (4000+, 3000 posti);
link alle sotto-sezioni Programma / Ospiti / Info; strong imagery. CTA to registration (official) and to
"Le tue foto".

### 4.4 `/programma` — Programma / Giornate

**Purpose.** The agenda across the conference days.

**Required info:** struttura per **giornata** (Giorno 1/2/3) con fasce orarie; sessioni plenarie,
workshop, attività per famiglie e per youth; momenti serali; eventuali tracce parallele; luoghi/sale;
note (no accesso parziale per giornata — dal sito reale). Each day block: orario, titolo sessione,
relatore (link a `/ospiti`), sala. Downloadable PDF programme optional.

### 4.5 `/ospiti` — Ospiti / Speaker

**Purpose.** The speakers and special guests.

**Required info per ospite:** foto, nome, ruolo/titolo, breve bio (2–4 righe), eventuale paese,
sessione/i a cui partecipa (link al programma). Group into "Ospiti speciali" and "Relatori". Consistent
photo treatment (DESIGN.md: never crop a face out of the safe center).

### 4.6 `/info` — Informazioni pratiche (alloggio, prezzi, iscrizioni, logistica)

**Purpose.** Practical info, **mirroring** the official conference logistics with a clear source link.

**Content blocks:**
- **Iscrizioni:** come ci si iscrive (online, **a gruppi** tramite capogruppo/chiesa), scadenza
  pagamento, ~3000 posti, no accesso parziale. **CTA → sito ufficiale di registrazione.** A disclaimer:
  "La registrazione è gestita dagli organizzatori."
- **Alloggio & prezzi:** opzioni di alloggio, cosa è incluso (pasti inclusi vs add-on opzionali), fasce
  di prezzo, cosa portare.
- **Logistica in loco:** reception, braccialetti/badge, buoni pasto, chiavi camera, orari check-in.
- **#capigruppo (anchor):** how a group leader gets photos to their group — explains `access=list` +
  `event_participants` allowlist in human terms (see §4.12).
- **Come avere le foto:** short block pointing to `/e/{slug}`.

### 4.7 `/edizioni` — Edizioni precedenti (+ their galleries)

**Purpose.** The archive 2019→2025 and **the proof galleries** — the single biggest upgrade over the real
site.

**Content blocks:**
- Index: one card per edizione (2019, 2020?, 2021, …, 2025) with anno, tema, luogo, una foto chiave,
  "N foto".
- **Per-edition page `/edizioni/{anno}`:** breve racconto + **galleria pubblica** di quell'edizione. For
  older editions the gallery can be a **public browse** (no selfie needed) or, where faces of minors are
  involved, an access-controlled gallery. Decision below.

> **Design note — public vs matched galleries for past editions.** A fully public, browsable archive of
> thousands of faces of (past) minors is a GDPR and safeguarding risk. Recommended rule: past-edition
> galleries are **either** a small *curated highlights* set (consented, organiser-chosen, safe for public
> display) **or** the same selfie-gated `/e/{slug-anno}` flow as the live event. Avoid an open,
> un-gated dump of all faces. The homepage "anteprima edizioni" should use curated highlights only.

### 4.8 `/community` — Community / Chi siamo / Organizzatori

**Purpose.** The "Our Community" + "Organizers" story; credibility.

**Content blocks:** cos'è la conferenza europea (storia, missione); stats (4000+, 15+ paesi, 7 edizioni);
**Organizzatori**: Philadelphia Mansue, con il sostegno del Department for Romanians Abroad (logo +
nota sul finanziamento); **RePhoto** come fornitore del servizio foto e responsabile del trattamento dei
dati (link informativa + DPIA); testimonianze/foto di community; newsletter.

### 4.9 `/faq` — FAQ (evento + **FAQ foto/privacy** dedicata)

**Purpose.** Answer both logistics and the service/privacy questions. Two clearly separated groups.

**A. FAQ evento** (mirror the real site): chi può partecipare, età minima 14, minori e consenso,
iscrizione a gruppi, scadenze/pagamento, alloggio e pasti, cosa portare, lingue, contatti.

**B. FAQ foto & privacy (dedicated — RePhoto's own):**
- *Come fa a trovarmi tra migliaia di foto?* — face matching sull'evento, spiegato semplice.
- *Il mio selfie viene conservato?* — **No.** Viene usato solo per il confronto e poi cancellato
  (CONTRACTS: selfie deleted after `search`).
- *Chi può vedere le mie foto?* — solo tu, dalla tua galleria; accesso ristretto se l'evento è `list`.
- *Come scarico le foto?* — selezione → ZIP (originali o per web) o singola.
- *Non trovo le mie foto, perché?* — selfie poco chiaro, foto non ancora caricate, riprova più tardi;
  le nuove foto si agganciano da sole e ti avvisiamo via email.
- *Sono minorenne (14–17)?* — serve il consenso di un genitore/tutore; come funziona.
- *Posso cancellare i miei dati?* — sì, «Gestisci i miei dati» (revoca consenso + cancellazione).
- *Che cos'è il consenso biometrico?* — perché lo chiediamo, Art. 9 GDPR, cosa copre.
- *Le mie foto vengono vendute o usate per pubblicità?* — **No.**
- *Per quanto restano disponibili le foto?* — fino a `retention_days`, poi cancellate.

### 4.10 `/contatti` — Contatti

**Purpose.** Reach the organisers and the photo-service support (two distinct channels).

**Content:** email evento, telefono **+39…**, sede/indirizzo, social; **canale separato per il servizio
foto / privacy** (es. privacy@…) per richieste GDPR; form di contatto (invio = azione soggetta a
consenso; no dati in querystring); mappa opzionale; orari.

### 4.11 `/per-fotografi` — thin public page for photographers

**Purpose.** Route invited photographers; not part of the public funnel.

**Content:** "Sei un fotografo della conferenza? Accedi con il tuo invito." → `/invito` / `/upload`;
"Non hai un invito? Contatta lo staff." Minimal.

### 4.12 Capigruppo / allowlist explainer (section within `/info`, anchored)

**Purpose.** Translate `access=list` + `event_participants` into plain language for group leaders.

**Content:** "Per proteggere i partecipanti, alcune edizioni mostrano le foto solo a chi è in elenco.
Come capogruppo, fornisci allo staff le email del tuo gruppo; chi è in elenco potrà cercare le proprie
foto." + what a member does (stessa email usata per l'iscrizione) + cosa succede se non in elenco
(contatta il capogruppo/staff). Ties to admin import (`POST /v1/admin/participants/import`).

### 4.13 `/i-miei-dati` (or `/e/{slug}/i-miei-dati`) — Gestisci i miei dati (GDPR self-service)

**Purpose.** Data-subject rights self-service (ux-flows §9 gap #4 — recommended).

**Content:** stato del mio consenso; **revoca consenso** (`consents.withdrawn_at`); **richiesta
cancellazione** (dati, galleria, consensi); spiegazione: "le foto di gruppo scattate dai fotografi non
sono tue da cancellare, ma puoi chiedere la rimozione di una foto specifica che ti ritrae"; contatto
privacy. Note the current API routes erasure through admin — this page sets expectation + submits the
request.

### 4.14 Legal pages

- `/privacy` — **Informativa privacy** (see §6).
- `/termini` — Termini e condizioni d'uso del servizio foto.
- `/cookie` — Cookie policy (minimal if only technical cookies).
- `/minori` — **Informativa dedicata ai minori** (see §6) — given the audience, a standalone page, not a
  paragraph.
- `/accessibilita` — Accessibility statement.

---

## 5. Multilingual strategy (RO / IT / EN)

### 5.1 Priorities

- **Default locale: Romanian (RO)** — the audience is Romanian diaspora; the real site defaults to RO.
- **Italian (IT)** — the product UI is Italian and the event is in Italy; second priority, and the
  language of the running `@rephoto/web` app.
- **English (EN)** — for the 15+ countries / non-Romanian, non-Italian speakers.

> **Resolve the IT/RO tension explicitly.** The *product UI* (selfie flow, gallery, buttons inside
> `/e/{slug}`) is Italian today. The *showcase content* should default to Romanian to match the
> audience. Recommended: full tri-lingual for marketing/content pages; for the live app surface,
> prioritise RO + IT + EN strings in that order. This is a decision to confirm with the client.

### 5.2 What must be translated (all three locales)

| Content | Translate? | Note |
| --- | --- | --- |
| All navigation, buttons, CTAs | **Yes** | Including «Trova le tue foto». |
| Homepage, conferenza, programma, info, community, FAQ | **Yes** | Full copy. |
| Speaker bios | **Yes** (or RO+EN min.) | Names stay; bios translated. |
| **Legal: privacy, termini, cookie, minori** | **Yes — mandatory** | Consent and minors text **must** be in the language the user reads; a consent not understood is not valid consent. |
| Consent checkboxes (contatto + biometrico) | **Yes — mandatory** | Per-locale; `consents.text_version` should encode locale. |
| Email templates (magic link, gallery ready/new) | **Yes** | At least RO/IT/EN; pick by user locale. |
| Past-edition photos | n/a | Images are language-neutral; captions translated. |
| Error/empty states in the flow | **Yes** | `403`/`429`/no-match messages. |
| Dates, prices, phone | Localised format | +39 phone, EUR, DD/MM. |

### 5.3 Language switcher

- Persistent, top-right, **RO · IT · EN** (visible, not a flag-only dropdown — flags ≠ languages).
- Remembers choice (cookie / `localStorage`), but first-visit default by `Accept-Language` with RO
  fallback.
- Switching preserves the current page (locale-aware route mapping), never dumps to homepage.

### 5.4 URL strategy

- **Path-prefix locales:** `/ro/...`, `/it/...`, `/en/...` (recommended — simplest for SEO + `hreflang`).
  Default RO may be served at `/ro/` explicitly (avoid a bare-root ambiguity).
- One canonical URL per locale; **`hreflang` alternates** on every page (incl. `x-default`).
- `/e/{slug}` stays slug-based; locale as prefix (`/ro/e/{slug}`) or as cookie — keep the slug stable so
  QR codes and emailed links don't break across locales.
- Never put personal data or locale-switch state in query strings (CSP/privacy rule, CONTRACTS).

---

## 6. Trust & GDPR content the site must carry (minors-critical)

The youth/family audience with **minimum age 14** makes this the most consequential section. Biometric
face matching on minors is **special-category data (Art. 9)** *and* triggers **Art. 8** (child's consent
/ parental authorisation). The site is where that is communicated and gated.

### 6.1 The two consents (keep distinct — ux-flows §7, CONTRACTS `consents`)

1. **Consenso-contatto** (step email): lawful basis to send the magic link / newsletter. Checkbox, not
   pre-ticked, link to informativa.
2. **Consenso biometrico esplicito (Art. 9)** (step selfie): explicit, granular consent to process the
   facial template for matching. Checkbox not pre-ticked, link to informativa, `text_version` + `ip` +
   `user_agent` recorded server-side. Selfie is `403` without it.

### 6.2 Minors — parental/guardian consent (Art. 8 + Art. 9)

**What the site must say and do:**
- **Age gate** at both registration-interest and at `/e/{slug}` selfie entry: «Hai almeno 14 anni?» and
  «Hai meno di 18 anni?». A minor path appears when under 18.
- **Dedicated minors notice (`/minori`)** in RO/IT/EN: who processes the photo, what a facial template is,
  that the selfie is deleted, that a **parent/guardian must consent** for under-18 biometric processing,
  how a parent gives/withdraws consent, how to request erasure.
- **Parental consent mechanism.** Options (decision to confirm with client / counsel):
  (a) a parent/guardian completes a consent step on behalf of the minor (e.g. a signed form collected at
  registration by the organisers, referenced by the allowlist), or (b) an in-flow guardian confirmation
  with guardian contact recorded in `consents` (`text_version` noting "guardian"). The site must at
  minimum **collect and record** that a guardian consented, with version + timestamp.
- **Safer defaults for minors:** strongly prefer **`access=list`** for events with many minors, so only
  allow-listed participants can be searched — the site should explain this as a protection.
- **No public face dump of minors** (see §4.7): past-edition minor galleries are curated/consented or
  selfie-gated, never openly browsable.

### 6.3 The promises the site must state plainly (everywhere relevant)

- **«Il selfie non viene conservato.»** — used only for matching, then deleted (CONTRACTS: selfie
  deleted after `search`; AWS 2-day lifecycle safety net).
- **«Non salviamo il tuo volto come dato permanente oltre l'evento.»** — embeddings exist only to match
  within the event; retention deletes everything after `retention_days` (+ `deleteCollection` when empty).
- **«Le tue foto le vedi solo tu.»** — gallery is per-user; `access=list` limits who can search at all.
- **«Niente vendita dati, niente pubblicità, niente riconoscimento fuori dall'evento.»**
- **«Puoi revocare il consenso e cancellare i tuoi dati quando vuoi.»** → `/i-miei-dati`.

### 6.4 Where each GDPR element lives (checkpoint-per-page)

| Page | GDPR content it must carry |
| --- | --- |
| Homepage | Trust band (§3.8) + footer links privacy/minori. |
| `/e/{slug}` entry | Consenso-contatto; `access=list` notice; age gate; link informativa. |
| `/e/{slug}` selfie | Consenso biometrico esplicito; "selfie non conservato"; minors path. |
| `/e/{slug}` gallery | Link «Gestisci i miei dati». |
| `/minori` | Full minors notice + parental consent mechanism. |
| `/privacy` | Full informativa: titolare/responsabile (organizzatori + RePhoto), finalità, base giuridica (Art. 6 consenso + Art. 9 consenso esplicito + Art. 8 minori), categorie di dati (immagine, template facciale, email), conservazione (`retention_days`, selfie cancellato), destinatari/sub-responsabili (hosting VPS, SMTP provider), trasferimenti (none off-VPS by design), **diritti dell'interessato** (accesso, rettifica, cancellazione, revoca, opposizione, portabilità, reclamo al Garante/ANSPDCP), **riferimento alla DPIA** ([`docs/DPIA.md`](../DPIA.md)), contatto DPO/privacy. |
| `/cookie` | Technical-cookie notice; if no analytics, a minimal banner or none (privacy-friendly default, DESIGN/ux-flows §7). |
| `/termini` | Terms of use of the photo service, acceptable use, liability, takedown of a contested photo. |
| `/contatti` | Privacy channel. |

### 6.5 DPIA reference

The privacy page and the minors page must **reference the DPIA** (RePhoto maintains
[`docs/DPIA.md`](../DPIA.md)) — not publish it in full, but state that a Data Protection Impact
Assessment was carried out for the biometric processing, available on request. This is expected for
Art. 35 high-risk (biometrics + minors + large scale) processing.

---

## 7. Content inventory table — what the client must provide

Legend: **C** = client/organiser must supply · **R** = RePhoto provides/templated · **L** = legal/counsel.

| # | Content element | Type | Owner | Page(s) | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | Logo conferenza (RO/IT/EN lockups) | Image (SVG/PNG) | C | all | |
| 2 | Logo Philadelphia Mansue | Image | C | /community, footer | |
| 3 | Logo Dept. for Romanians Abroad | Image | C | /community, footer | Funding transparency. |
| 4 | Tema BIRUITORI — testo e significato | Copy (RO/IT/EN) | C | /conferenza, home | |
| 5 | Date, sede, indirizzo | Data | C | multiple | |
| 6 | Hero images (2026) | Image set | C | home, /conferenza | High-res, consented. |
| 7 | Programma / giornate (agenda) | Structured data | C | /programma | Per day/session/speaker/room. |
| 8 | Ospiti: foto + nome + ruolo + bio | Copy + Image | C | /ospiti | Per guest; bios translated. |
| 9 | Alloggio & prezzi | Copy/table | C | /info | Incluso vs add-on. |
| 10 | Iscrizioni: processo, scadenze, posti | Copy + link | C | /info | + official registration URL. |
| 11 | Logistica (badge, pasti, chiavi) | Copy | C | /info | |
| 12 | Stats community (4000+, 15+, edizioni) | Data | C | home, /community | |
| 13 | Testo "Chi siamo / storia" | Copy (RO/IT/EN) | C | /community | |
| 14 | **Foto edizioni precedenti 2019→2025** | Image sets | C | /edizioni | **Consented**, curated for public ones. |
| 15 | Temi/luoghi edizioni precedenti | Copy | C | /edizioni | |
| 16 | FAQ evento (Q&A) | Copy | C | /faq A | |
| 17 | FAQ foto & privacy (Q&A) | Copy | R | /faq B | Templated by RePhoto. |
| 18 | Contatti (email, +39, social) | Data | C | /contatti, footer | Event + privacy channel. |
| 19 | Testo newsletter + consenso | Copy | R+C | footer, home | |
| 20 | Email templates (magic link, ready, new) RO/IT/EN | Copy | R | — | Subjects fixed by spec. |
| 21 | **Informativa privacy** | Legal (RO/IT/EN) | L (+R inputs) | /privacy | Titolare/responsabile, Art.6/8/9, DPIA ref. |
| 22 | **Termini e condizioni** | Legal | L | /termini | |
| 23 | **Cookie policy** | Legal | L/R | /cookie | Minimal if only technical. |
| 24 | **Informativa minori + meccanismo consenso genitori** | Legal | L (+C process) | /minori | Critical. |
| 25 | Consent copy (contatto + biometrico) RO/IT/EN | Legal + copy | L+R | /e/{slug} | `text_version` per locale. |
| 26 | Accessibility statement | Copy | R | /accessibilita | |
| 27 | Capogruppo instructions | Copy | R+C | /info#capigruppo | |
| 28 | OG/social share images per page | Image | R | meta | |
| 29 | Favicon / app icons | Image | R | meta | |
| 30 | Sostenitori/sponsor logos | Image | C | home, /community | |

**Gaps to flag to the client:** items 14, 21, 24, 25 are the highest-risk — **past-edition photos must be
consent-cleared**, and the **minors + privacy legal texts must be lawyer-reviewed in all three
languages** before launch.

---

## 8. SEO / meta, performance, accessibility, analytics

### 8.1 SEO & meta
- Per-page, per-locale `<title>` + meta description; **`hreflang`** alternates (RO/IT/EN + `x-default`);
  canonical URLs.
- Structured data (JSON-LD): `Event` (conference, dates, location, offers→registration),
  `Organization` (organisers), `FAQPage` (FAQ), `BreadcrumbList`, `ImageObject`/`Photograph` for
  galleries where appropriate.
- OG/Twitter cards per page with event imagery.
- `sitemap.xml` (per-locale) + `robots.txt`. **Exclude** `/e/{slug}` gallery/selfie states and
  `/i-miei-dati` from indexing (private, personal); index the marketing + edizioni highlights.
- Clean, stable, human-readable slugs; QR/email links must never 404 across locales.

### 8.2 Performance
- Photo-heavy site → image discipline is the whole game: responsive `srcset`/`sizes`, AVIF/WebP, lazy
  loading below the fold, `IntersectionObserver` infinite scroll in galleries (already in the flow),
  presigned-URL thumbnails cached within the 10-min signing window (CONTRACTS).
- Core Web Vitals targets: LCP < 2.5s (hero image prioritised, `fetchpriority=high`), CLS < 0.1 (reserve
  image dimensions), INP < 200ms.
- The hero "Recognition" animation must respect `prefers-reduced-motion` and not block LCP.
- Serve from the VPS/CDN; the two-stage uploader means web-size derivatives are ready fast — surface a
  "foto caricate" live count without heavy polling.

### 8.3 Accessibility (WCAG 2.2 AA)
- Contrast per DESIGN.md (body ≥ 4.5:1); visible 3px focus ring on every interactive element.
- Full keyboard operability incl. gallery selection and download; camera/selfie step must have the
  **file-upload fallback** (already in flow) for users who can't use the camera challenge.
- Status always **icon + label + colour**, never colour alone.
- Alt text on meaningful images; decorative images `alt=""`.
- Forms: labelled inputs, consent checkboxes with large hit targets, errors announced (aria-live).
- Captions/transcripts if any video is added.
- Language of page set via `lang` attribute per locale; switcher reachable by keyboard.
- Accessibility statement page (item 26).

### 8.4 Analytics — privacy-first
- Prefer **cookieless / privacy-friendly analytics** (e.g. server-side counts or a consent-free tool) so
  the site can keep a minimal/no cookie banner (DESIGN/ux-flows §7).
- If any analytics sets cookies or processes personal data → a proper cookie consent banner (decline
  non-essential by default) and disclosure in `/cookie`.
- Track the funnel that matters: hero → «Trova le tue foto» → email → selfie → gallery → download; and
  newsletter signups. **Never** send personal data or selfie content to analytics.
- Respect Do-Not-Track / Global Privacy Control.

---

## 9. Benchmark — what good sites do that this must match

### 9.1 Good conference / community event sites
- **Clear event identity + theme up front** (BIRUITORI), dates and "who it's for" above the fold.
- **Agenda/programme** that's scannable by day and track; speaker pages with photos + bios.
- **Social proof**: attendee numbers, countries, past editions (the real site already leans on this).
- **Previous editions archive** — but good ones add *media*, which the real site lacks.
- **Multilingual** with a clean switcher and `hreflang`.
- **Trust/logistics clarity**: pricing, accommodation, registration deadlines, FAQ.
- Newsletter capture; organiser/sponsor transparency.

### 9.2 Good photo-gallery delivery platforms (Pic-Time / Pixieset style)
- **Photos lead; chrome recedes** — big, clean, aligned grids, generous gaps, rounded corners, hover
  lift (exactly DESIGN.md §5).
- **Fast, obvious selection + download** — select all / per-group, ZIP of a selection, single-photo
  download, quality choice (originals / web). RePhoto already matches this.
- **Lightbox/viewer** with keyboard nav and next/prev.
- **Favouriting / grouping** — RePhoto's score split «Le tue foto» / «Forse sei tu» is the analogue.
- **Fast delivery + smart image loading** (lazy, responsive, cached thumbnails).
- **A delivery mechanism that feels private and personal** — a per-user gallery, email when ready
  ("le tue foto sono pronte"), and a "new photos added" notification (RePhoto's `attach` + email kind
  `new`). This is where RePhoto *beats* a generic conference site: the face-match entry replaces
  "find your gallery by access code".
- **Clear privacy posture** — the differentiator for this audience: Pixieset/Pic-Time don't do biometric
  matching, so RePhoto must over-communicate the "selfie not kept / minors protected" story that those
  platforms never have to.

---

## 10. Open decisions to confirm with the client (before design)

1. **Registration:** link out to the official site, or mirror it? (Recommended: link out + light mirror.)
2. **Default content locale:** RO (recommended) vs IT, and whether the live app surface is tri-lingual at
   launch or RO+IT+EN in priority order.
3. **Past-edition galleries:** curated-public highlights vs selfie-gated per edition (safeguarding).
4. **Parental consent mechanism for minors:** organiser-collected form (allowlist-linked) vs in-flow
   guardian confirmation — and who is joint controller (organisers + RePhoto).
5. **`access` default:** push `list` for minor-heavy events?
6. **GDPR self-service erasure** (`/i-miei-dati`): build the self-service endpoint (ux-flows §9 gap #4) or
   route via admin at launch?
7. **Phase control:** is the hero/CTA driven automatically by event date/state, or an admin flag?
8. **Analytics:** cookieless (no banner) vs standard (needs banner)?

> Items 3 and 4 are blocking for the minors story and must be resolved before any public gallery of
> past-edition photos goes live.
