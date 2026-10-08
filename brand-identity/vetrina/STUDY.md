---
name: Frames of Me — Vetrina "Cielo"
description: Sito vetrina pastello, stile Cloudflare, per framesofme.com
mode: Persuade
world: "Le tue foto vivono nel cielo dell'evento; un selfie dirada le nuvole e ti ritrovi."
sources:
  - impeccable (pbakaus/impeccable) — colorize, craft-floor, new-work, modes
  - emil-design-eng (emilkowalski/skills) — motion, curve & durata, interruzioni, stagger
colors:
  canvas:   "#F7F9FF"   # ground, blu tenue
  surface:  "#FFFFFF"   # card / nuvole
  sunken:   "#EEF1FB"   # well / track
  ink:      "#20233A"   # testo (night-sky, non nero)
  ink-2:    "#565C7A"
  ink-3:    "#8A90AC"
  line:     "#E5E8F4"
  indigo:   "#4A54D8"   # link / focus / selezione
  coral:    "#FF8A66"   # delight / "match" / mark
  coral-ink:"#C7502E"   # coral come testo leggibile
  weather:  ["#DDE3FF peri","#ECE2FF lilac","#FFE7D6 peach","#DCF2EA mint","#D9ECFF sky"]
typography:
  display: "Bricolage Grotesque (opsz) — titoli, wordmark"
  ui/body: "Hanken Grotesk — tutto il resto, dati"
radius: { sm:10, md:16, lg:24, xl:34, pill:999 }
---

# Studio del sito vetrina — "Cielo"

> Perché questo mondo, e perché **ogni** componente è fatto così. Niente è stato creato senza
> una regola presa da **impeccable** (`colorize`, `craft-floor`, `new-work`, i *modes*) o dalla
> **design-engineering di Emil Kowalski** (motion, curve, durate, interruzioni).

## 0. Il mondo e il *mode*

impeccable impone di scegliere il **visitor mode** dalla superficie, non dal prodotto: una landing
è sempre **Persuade** (*"il visitatore decide e agisce; il design è il prodotto"*). Quindi qui il
colore può **possedere intere regioni** e portare la voce — cosa vietata in Operate/Read.

Il mondo non nasce dalla categoria ("app di foto → griglia fredda"), ma dal **significato**
(`new-work` + `colorize`: *"scegli la tinta dal significato del prodotto, mai da un'associazione di
categoria"*). Significato scelto: **le tue foto vivono nel cielo dell'evento; un selfie dirada le
nuvole e ti ritrovi.** Da lì discendono: cielo pastello, nuvole, la cornice-mirino che "mette a
fuoco" te. Cloudflare è il riferimento di *struttura e chiarezza* (sezioni ampie, una CTA, nuvole);
il pastello e il calore umano sono la nostra diffusione da quel riferimento.

---

## 1. Colore — "I pastelli sono meteo, non controlli"

**Regola nominata (nostra, da `colorize`).** I pastelli (peri/lilla/pesca/menta/cielo) sono
**atmosfera**: possiedono *intere sezioni* come sfondo, mai un bordo o un testo. L'interfaccia
(testo, bottoni, campi) resta **inchiostro su quasi-bianco**. Così i pastelli restano tanti e
"cielo" senza diventare caramella — il rischio che `colorize` chiama *"un sacchetto di campioni"*.

- **Una sola azione, un solo delight** (`colorize`: *"la rarità dà forza a un accento… non spendere
  il colore dell'azione in decorazione"*). Azione primaria = **inchiostro** (sempre trovabile, alto
  contrasto). Delight = **corallo**, speso con rarità sul momento che è *il prodotto*: il "match"
  del riconoscimento, la cornice-mirino, il focus, il puntino del logo.
- **Nessun bianco/nero puro** (`craft-floor` + la *Cream-Family Rule* del demo impeccable, qui
  trasposta al blu): le neutre sono **tinte verso il blu notte** (`#20233A`, non `#000`; ground
  `#F7F9FF`, non `#FFF` ovunque).
- **Link/testo colorato deriva dalla tinta** e passa il contrasto: `indigo #4A54D8` (~4.6:1) per i
  link, `coral-ink #C7502E` quando serve corallo leggibile — mai corallo chiaro come testo.
- **Contrasto verificato** (`colorize`): corpo ≥ 4.5:1, large ≥ 3:1, controlli/focus ≥ 3:1. Lo stato
  è sempre **icona/puntino + etichetta + colore**, mai colore da solo.

## 2. Tipografia — due voci, ruoli separati

Scelte *contro* i default AI (il demo impeccable marca **Fraunces/Inter/cream** come il cluster da
cui diffondere). Qui:

- **Bricolage Grotesque** (display, asse ottico): voce emotiva e caratteriale — titoli e wordmark.
  Ha personalità "umana/da designer", esattamente il *"nuovo, simpatico, professionale"* chiesto.
- **Hanken Grotesk** (UI/corpo/dati): grottesca pulita e amichevole, ottima leggibilità.
- La gerarchia nasce da **dimensione + peso + spazio**; i titoli fluidi usano `clamp()`
  (con spazi attorno al `+`, obbligatori quando il valore passa da una `var()`).
- **Una enfasi sola** nell'headline (*One-emphasis*, dal demo impeccable): la parola `selfie` in
  corallo. Nient'altro colorato nel titolo.

## 3. Forma, profondità, spazio

- **Le nuvole sono rotonde** → raggi generosi (card 24, campi/bottoni pill, foto 18–34). Coerenza
  forma↔mondo.
- **Profondità soffice ma onesta** (`craft-floor`: ombra = *offset + blur*, mai un alone piatto a
  offset 0). Le ombre sono tinte indaco e bassissime: le cose "galleggiano" come nuvole. È una
  deroga consapevole al *flat* del demo Lumina, giustificata dal mondo (nuvole = morbidezza).
- Ritmo: **più spazio sopra un titolo che sotto**; stretto dentro un gruppo, generoso tra gruppi.

## 4. Motion — un momento d'autore, poi feedback (Emil Kowalski)

- **Il momento d'autore = "le nuvole si diradano".** Nell'hero due nuvole coprono la foto e
  **si aprono** una volta, poi la **cornice-mirino corallo** si aggancia al volto e appare il tag
  "Trovata in 1,2s". È *specifico del prodotto* (impeccable: non un fade generico), e **non si
  ripete**.
- **Curve forti** (Emil: le easing native sono deboli): `--ease-out cubic-bezier(.23,1,.32,1)` per
  entrate; durate 100–160ms feedback, 150–250ms routine, <300ms overlay, ~1,5s il solo ingresso
  d'autore. **Uscita più veloce dell'entrata.**
- **Press = scale(.97)** su ogni elemento premibile (Emil: *"i bottoni devono sembrare che
  ascoltino"*). Niente `scale(0)`: nulla appare dal nulla.
- **Reveal allo scroll capped** (`.reveal` → `.in`): comparsa singola per elemento via
  IntersectionObserver, **non** un fade su ogni cosa ad ogni scroll (impeccable: *"un momento
  d'autore, non reveal sparsi"*; Emil: lo stagger resta 30–80ms e non blocca l'interazione).
- **FAQ**: `grid-template-rows: 0fr → 1fr` in transizione (interrompibile, Emil preferisce
  transizioni ai keyframe per UI dinamica); l'icona `+` ruota a `×`.
- **Nuvole alla deriva**: solo `transform: translateX` (compositor-safe), lentissime.
- **`prefers-reduced-motion`**: tutto lo stato finale resta visibile (nuvole già aperte, ring già
  agganciato); si tolgono solo i movimenti. Nessun contenuto nascosto *solo* dall'animazione.

## 5. Browser surfaces (`craft-floor` — "il segnale più economico di cura")

Temati dalla palette: **selezione** indaco-soft, **caret** indaco, **scrollbar** neutra,
**focus ring** a 3px indaco su ogni elemento interattivo, underline-offset sui link, tabular sui dati.

---

## 6. Componenti — specifiche e *perché*

### Navbar (sticky, translucida)
Striscia `rgba(247,249,255,.78)` + `backdrop-filter: blur` e 1px di hairline (dal demo impeccable: la
nav "vive sopra" il contenuto; l'unico blur strutturale). Link pill ink-2→ink; **una** CTA inchiostro.
Sotto 860px: hamburger + pannello a tendina con la CTA a larghezza piena. *Perché*: Persuade vuole
l'azione sempre a portata, mobile-first.

### Hero + "stage" che si dirada
Gradiente **cielo → lilla → pesca** (Persuade: il colore possiede la regione). Headline Bricolage
fluida, **una** parola corallo. Form email centrato. Lo **stage** ha `overflow:hidden` + raggio: le
nuvole-sipario si aprono e vengono **tagliate dalla cornice** (fix anche dell'overflow orizzontale su
mobile). *Perché*: prova il meccanismo nel primo viewport invece di affermarlo (impeccable Persuade).

### Eyebrow chip
Pillola `surface + hairline + ombra piccola`, con un puntino **corallo** (il "sole"). *Perché*: non è
il kicker-sopra-il-titolo vietato (è un badge di prova sociale, "4.000+ foto già online"), e dà al
corallo una presenza rara.

### Bottoni
`pill`, press `scale(.97)` (Emil), transizioni su proprietà **esplicite** (mai `transition:all`).
Primario = ink pieno + ombra soft; secondario = surface + hairline; freccia che scorre di 3px in hover.

### Campi + validazione
Campo pill, focus = bordo **indaco** + anello soft (focus ≥ 3:1). La form valida **inline**: email
non valida → bordo corallo/errore + messaggio; valida → stato **success verde** e placeholder
"Controlla la tua email ✦". *Perché*: `harden`/Persuade — una landing usabile ha stati reali
(errore, successo), non un bottone finto.

### Step card ("Come funziona")
Tre card con **tile icona pastello** (pesca/peri/menta) + numero. *Perché*: le tile portano i
pastelli come *atmosfera dentro un componente*, non come bordi; il numero dà sequenza senza frecce
decorative.

### Feature split + griglia "Recognition"
Testo + visual alternati (`.rev` inverte l'ordine su desktop, impila su mobile). La griglia
riconoscimento: i **match** (stessa persona) tornano a colori con cornice **corallo**, gli altri
restano grigi/scuri. *Perché*: mostra *letteralmente* la promessa ("ti trova"), con il delight speso
esattamente lì.

### Sezione Privacy ("Il tuo viso resta tuo")
Card bianca su wash **menta→cielo**, scudo, 4 garanzie (il selfie si cancella / consenso esplicito /
esporti e cancelli / GDPR Art. 9). *Perché*: tratta dati biometrici; impeccable chiede onestà e
nessun dark pattern — qui la fiducia è un **componente**, non una riga di footer.

### Galleria (strip masonry)
Colonne CSS, foto reali, ombra soft, **hover-lift** solo dietro `@media (hover:hover)` (Emil: niente
hover-su-tap sul touch). *Perché*: un momento "Experience" dentro la Persuade — l'artefatto guida.

### Sezione Fotografi (night sky)
Unico blocco **scuro** (radial night + stelle): contrasto deliberato che segna "l'altro lato"
(upload) senza cambiare brand. Drop-zone tratteggiata + metriche mono. *Perché*: ritmo tonale, come
il demo impeccable alterna ground chiaro e sezione scura.

### FAQ (accordion)
`aria-expanded` sul contenitore, `grid-rows 0fr→1fr`, `+`→`×`. Accessibile da tastiera, focus ring.

### Final CTA + Footer
CTA su **alba** pastello con nuvole, stessa form (seconda occasione d'azione). Footer inchiostro, 4
colonne → 2 su mobile, credito foto e "nuvole generate".

---

## 7. Foto & nuvole
Foto **reali** da Pexels (ritratti + eventi; vedi `../CREDITS.md`). Due cieli reali
(`clouds.jpg`, `sunset.jpg`) tenuti come texture; le **nuvole del sito sono generate** in SVG
(ellissi bianche con blur gaussiano) — così sono perfettamente pastello, leggere e on-brand, come
chiesto ("prendere *oppure* generare"). Scartata una foto-evento perché aveva marchi "Canva/pexels"
nella scena (non adatta a una vetrina).

## 8. Do / Don't
**Do:** pastelli come atmosfera; una azione ink + un delight corallo; nuvole che si diradano una
volta; curve forti di Emil; stati reali del form; hairline + ombre soffici tinte; mobile-first.
**Don't:** pastelli come bordi/testo; corallo sparso; `transition:all`; `scale(0)`; fade su ogni
sezione; bianco/nero puri; kicker sopra i titoli; marchi di terzi nelle foto.
