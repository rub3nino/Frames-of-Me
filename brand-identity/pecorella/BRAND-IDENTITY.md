# Frames of Me — Brand Identity "Prato" 🐑

Manuale operativo per chi costruisce UI di Frames of Me. Nasce dall'analisi delle 4 immagini di
riferimento ([analysis/style-extraction.json](../analysis/style-extraction.json)) e dai flussi reali
del prodotto (docs/ux-flows.md). I token eseguibili sono in [tokens.css](tokens.css): **nel codice si
citano i ruoli (`var(--accent)`), mai un esadecimale.**

| | |
|---|---|
| **Token** | [`tokens.css`](tokens.css) |
| **Mascotte** | [`mascot/pecorella.svg`](mascot/pecorella.svg) + componente animato in `mascot/react/` |
| **Logo** | [`logo/`](logo/) |
| **Analisi immagini** | [`../analysis/style-extraction.json`](../analysis/style-extraction.json) |
| **Foto reali** | [`../photos/`](../photos/) (25 scatti Pexels, crediti in `../CREDITS.md`) |

---

## 0. L'idea in una riga

**La pecorella ritrova il suo gregge — tu ritrovi le tue foto.**
A un evento da 150.000 scatti ognuno è una pecorella nel gregge: fai un selfie e Frames of Me ti
riporta a casa i tuoi ricordi. Da qui discende tutto: neutre calde di **lana** (crema, talpa, cacao
— i colori esatti della mascotte), **un solo accento verde prato**, forme rotonde come ricci di
lana, fotografia vera al posto della decorazione.

Personalità in 5 aggettivi: **tenero, affidabile, arioso, concreto, giocoso-senza-infantilismo.**
Il tono scrive come un amico preciso: «Trovate 47 foto con te», mai «Oops! Qualcosa è andato storto».

---

## 1. Logo e mascotte

### 1.1 Il marchio

Il logo è la **pecorella in miniatura + wordmark** «frames of me» minuscolo in Bricolage Grotesque
semibold, colore `--text-primary`. Versioni in [`logo/`](logo/):

| File | Uso |
|---|---|
| `logo.svg` | lockup orizzontale: navbar landing, email, footer |
| `mark.svg` | solo pecorella (testa): favicon, FAB, avatar di sistema, timbro foto |
| `logo-inverse.svg` | su `--surface-inverse` / `--surface-night` |

Regole: il marchio non si ricolora (lana e talpa restano lana e talpa, su qualsiasi fondo); area di
rispetto = altezza della testa; sotto i 20 px si usa solo `mark.svg`; niente ombra, niente gradiente,
niente rotazioni decorative. Il wordmark non va mai in maiuscolo.

### 1.2 La mascotte è un'attrice, non un timbro

La pecorella **vive** nei momenti del flusso, sempre con un ruolo preciso — mai riempitivo:

| Momento | Cosa fa |
|---|---|
| Login / onboarding | idle: respira, sbatte le palpebre, ogni tanto inclina la testa |
| Attesa (galleria `queued`, upload) | **cammina** da sinistra a destra — è la progress bar emotiva |
| Match trovato / galleria pronta | si **scuote** di gioia (shake lana) + accento prato |
| Errore / zero risultati | testa inclinata, orecchio pendente che oscilla: dispiaciuta, mai colpevolizzante |
| Empty state | guarda l'azione suggerita (testa ruotata verso il bottone) |

Divieti: mai due pecorelle nella stessa schermata; mai sopra le fotografie dei partecipanti (le
foto sono sacre); mai come icona di sistema (per quelle c'è Lucide); con `prefers-reduced-motion`
resta ferma con il solo respiro d'opacità.

---

## 2. Colore

Base **lana** + un accento. Il verde prato è l'unico colore «di marca» della UI.

- `--surface-page #F4F1E9` carta avorio calda. Niente bianco puro come fondo pagina, niente grigio
  freddo: le neutre virano tutte verso il cacao (tono caldo), come la lana della mascotte.
- `--surface-raised #FFFFFF` solo per card, input, pannelli: l'elevazione è il contrasto
  carta→bianco, non l'ombra.
- `--surface-inverse #2A241E` (cacao) è il **bottone primario**, il toast, il footer. Il primario
  NON è verde: è inchiostro-cacao, come il pelo scuro degli occhi della pecorella.
- `--accent #3F7D2C` (prato) è selezione, focus, link, interruttore acceso, badge «match», il
  momento di festa. **Il verde non decora**: se una schermata ha verde ovunque, è sbagliata.
- `--surface-night #3B332B` è il palco della mascotte (il fondo dell'illustrazione originale) e
  l'eventuale hero scuro della landing.
- Stati: ambra = attenzione, rosso = solo bloccante/irreversibile, verde successo = lo stesso prato.
- Nessuno stato comunicato dal solo colore: sempre forma + parola (pallino, icona, testo).
- Contrasti: corpo ≥ 4.5:1, grandi/controlli ≥ 3:1 (già misurati nei token).

Le **fotografie** sono il vero colore dell'interfaccia: l'app è neutra apposta, perché il rullino
dei partecipanti porti il colore. Mai filtri colorati sulle foto in UI (le cornici/filtri ufficiali
dell'evento sono contenuto, non chrome).

---

## 3. Tipografia

| Ruolo | Font | Dove |
|---|---|---|
| Display | **Bricolage Grotesque** (variable, opsz) | wordmark, titoli landing, titoli pagina app |
| UI / corpo | **Plus Jakarta Sans** | tutto il resto: bottoni, corpo, form, dati |
| Mono | `--font-mono` di sistema | ID, hash, conteggi tecnici admin |

Scala in `tokens.css` (`--text-xs` 12 → `--text-3xl` fluido). Gerarchia tipo immagine 1: titolo
pagina 28 bold → titolo card 17 semibold → meta 13 terziario. Landing tipo immagine 2: display
enorme con **una sola parola enfatizzata** (in `--accent-text` o in Bricolage italic), sottotitolo
max 52ch. Numeri sempre `tabular-nums`, formato it-IT, assente = `—`.

Pesi: 400 / 540 / 640 / 760. Niente light. Interlinea 1.12 display, 1.5 corpo.

---

## 4. Forma, spazio, profondità, movimento

- **Raggi**: controlli pill (999), card album 22, foto 12–16, sheet mobile 32 (vedi token). Angoli
  vivi non esistono. Le card album hanno la **cornice tratteggiata** «ritaglio» (da immagine 1):
  `border: 1.5px dashed var(--line-strong)` su un padding interno 8.
- **Le postcard si impilano**: pile di 2-3 con rotazioni ±3–6°, ombra `--shadow-card`. È l'unico
  posto dove le cose ruotano.
- **Spazio** base 4: 8 dentro il gruppo, 16 tra campi, 24 tra blocchi, 96–128 tra sezioni landing.
  Densità bassa: l'app partecipante è una colonna da max 520 px; la landing max 1120.
- **Ombre**: quasi-flat. `--shadow-raised` sui controlli, `--shadow-card` su pile e FAB,
  `--shadow-float` solo menu/toast. Mai ombra + bordo pesante insieme.
- **Movimento** (regole Emil Kowalski, già nei token): feedback 120–160ms, routine 220ms, sheet
  300ms con `--ease-sheet`, reveal allo scroll 480ms una volta sola. Press = `scale(0.97)`.
  Uscite più veloci delle entrate. **`--ease-bounce` è riservato a mascotte e momento-match.**
  La mascotte è l'eccezione nominata: 600–1200ms, loop ammessi (camminata, respiro).
  `prefers-reduced-motion`: tutto si riduce a dissolvenze ≤150ms, pecorella ferma.

---

## 5. Componenti chiave

- **Bottone**: alto 48 (40 desktop), pill, peso 640. Primario = cacao pieno, testo lana. Secondario
  = bianco, bordo `--line-strong`. Accento (uno per flusso, solo nel momento-prodotto: «Scatta il
  selfie») = `--accent` pieno. Ghost e link come da token. Verbo + oggetto: «Trova le mie foto»,
  non «Continua».
- **Input**: pill, alto 48, bordo `--line-control`, focus bordo `--accent` + alone 3px
  `--accent-soft`. Etichetta sopra, 13/540. Errore sotto in `--danger-text`: cosa e come rimediare.
- **Card album** (immagine 1): cornice tratteggiata, dentro collage 1 grande + 2 piccole, raggio
  12, titolo 17/640 sotto, data 13 terziaria.
- **Chip-filtro**: pill bianca con icona, selezionata = fondo `--surface-pressed`.
- **FAB**: cerchio 56, `--accent`, icona +, ombra card. Uno solo, solo nell'app.
- **Sponsor marquee** (landing): strip su `--surface-sunken`, loghi monocromi `--text-tertiary`,
  scorrimento continuo 30s linear, pausa su hover, duplicazione aria-hidden per il loop.
- **Toast**: pillola cacao, testo lana, entra dal basso 300ms.
- **Selfie frame**: il mirino di scatto è un cerchio con 4 tacche `--accent` che si «aggancia» al
  volto (il momento corallo→prato della vecchia proposta, ora prato).

---

## 6. Le superfici del prodotto

| Superficie | Mood | Riferimento |
|---|---|---|
| **Landing** (pubblica) | immagine 2: hero display + mondo visivo, strip sponsor in marquee, sezioni «come funziona» con foto reali, CTA una sola | `--surface-page`, hero può usare `--surface-night` |
| **Login partecipante / fotografo** (`/accedi`) | immagine 4: colonna centrata, pecorella idle sopra il titolo, email+password, «Continua con Google», magic link; toggle Partecipante/Fotografo come segmented pill | tutto pill, un bottone acceso |
| **Accesso admin** (`/staff`, non linkato) | sobrio, niente mascotte grande: mark + form. È un luogo di lavoro | |
| **App partecipante** | immagine 1: «La tua galleria», segmented Album/Postcards, griglia 2 col, FAB upload, tab bar pill flottante | |
| **Gestionale admin/fotografo** | densità maggiore, stessa palette, tabelle con righe 44, pattern RBAC/audit (da tvoMoka: ruoli OWNER/ADMIN/MEMBER/VIEWER → Super-admin/Editor/Moderatore/Sola lettura) | |

Lingue: IT prima, poi RO/EN. Mobile-first sempre (il partecipante è al 90% su telefono).

---

## 7. Accessibilità e checklist

WCAG 2.2 AA. Focus visibile `--focus-ring` 2px offset 2. Target touch ≥ 44px. Zoom 200% senza
scroll orizzontale. Stati mai solo-colore. Alt text sulle foto («Foto dell'evento, 12 persone»).

Prima di chiudere una PR di UI:
- [ ] un solo primario cacao per schermata; il verde non decora
- [ ] nessun esadecimale nuovo nei componenti
- [ ] pill sui controlli, tratteggio solo sulle card album
- [ ] foto reali, mai placeholder grigi
- [ ] mascotte: una sola, con un ruolo, ferma se reduced-motion
- [ ] testi verbo+oggetto, numeri tabulari it-IT
- [ ] verificato a 390px (iPhone) e 1280px
