# Regole — cosa si fa, cosa non si fa, e quando un pezzo non va usato

Le misure stanno in `frontend/packages/ui/tokens.css` e `components.css`. Qui c'è il
**giudizio**: quale pezzo si usa per quale bisogno, e perché la scelta sbagliata è sbagliata.

---

## 1. Come deve agire chi tocca la UI

1. Si usa un **ruolo** già in `tokens.css`. Un colore scritto nel componente è un difetto.
   `components.css` non contiene colori propri, solo `var(--…)`.
2. **Una sola azione primaria per schermata**, in inchiostro (`btn--primary`), non in blu.
   Il blu è link, selezione, fuoco, interruttore acceso.
3. **Nessuno stato è solo colore**: forma e parola insieme (cerchio vuoto, mezzo pieno,
   pieno, rombo, trattino). Un daltonico deve leggere lo stato.
4. Il **rosso è raro**: eccezione confermata, errore bloccante, azione irreversibile.
   «Guarda qui» è **ambra**.
5. I numeri sono **tabellari**, formato italiano, mai troncati. Un dato assente è `—`, mai `0`.
6. **Niente riquadro dentro un riquadro.** Dentro un pannello si separa con una linea o con
   lo spazio.
7. **Niente animazione** sulle azioni da tastiera, sul cambio scheda, sul filtro, sulla riga.
   Il movimento sta sotto i 300 ms e solo su ciò che capita di rado.
8. Il pulsante dice **verbo e oggetto**: «Crea l'incarico», non «OK» o «Procedi».
9. Se la regola cambia, si aggiornano **queste pagine e i token insieme**.

**Non si fa:** gradienti, vetro, emoji come icone, etichetta maiuscoletta sopra un titolo,
bordo colorato spesso a sinistra di un riquadro, ombra e bordo insieme sullo stesso blocco,
una griglia di «numeri grandi» al posto di una riga di riepilogo, font da scaricare.

**Icone:** una libreria, un peso, SVG a `currentColor`. Il marchio non è un'icona della
libreria.

---

## 2. Casella, interruttore, segmentato, schede — l'errore più frequente

| Bisogno | Si usa | Non si usa |
|---|---|---|
| Scelta binaria che resta nella frase («ho letto», «includi i chiusi») | `.check` | un interruttore |
| Accendere una modalità con effetto immediato e reversibile | `.switch` | una casella senza frase, un primario |
| Scelta nominata ed esclusiva, poche voci («Sì / No») | `.segmented` | un interruttore muto, cinque caselle |
| Cambiare **quale elenco** si guarda | `.tabs` con filetto inchiostro | un segmentato che sembra un titolo |

- La **casella** non è uno stato: «Chiarita» è un esito, con forma e parola. Non accende una
  modalità dell'interfaccia. Non fa partire un calcolo. Non si colora di rosso o verde: il
  segno è sempre blu, il significato sta nella frase accanto.
- L'**interruttore** non sostituisce «Sì / No» quando la scelta è obbligatoria e va nominata.
  Non conferma un'azione distruttiva: spegnere non cancella. Non sta nel piede di un pannello
  al posto del primario. Da spento non è rosso e da acceso non è verde: **acceso è blu**, e la
  posizione del pomello dice lo stato anche senza colore.
- Il **segmentato** non si usa per più di cinque voci (a quel punto è un menu o un select) né
  per una scelta irreversibile.
- Le **schede** hanno il filetto inferiore inchiostro, non uno sfondo blu, e il conteggio è un
  `.chip`, non un badge colorato.

---

## 3. Primario, secondario, pericolo

- **Uno solo** primario in vista, e sta nel posto dell'azione del momento: nell'intestazione
  di una lista, nella barra in fondo a un passo, nel piede di un pannello.
- **Mentre un pannello è aperto**, il primario della pagina perde `btn--primary` e resta
  secondario: non ci sono due neri. Quando il pannello si chiude, torna.
- `btn--primary.btn--danger` è il primario di una **conferma irreversibile**, e non è il colore
  di «Annulla». Annulla è secondario o ghost e sta **a destra** del primario.
- Un pulsante icona **deve** avere `aria-label`: l'icona da sola non è un nome.
- Un primario disabilitato non resta muto: dice **perché** non si può premere (`title`).

---

## 4. Pannello laterale, menu, palette, toast, callout

- Il **pannello** non è un dialogo: la pagina dietro resta usabile, non c'è velo, il clic fuori
  è un clic sulla pagina. Uno alla volta, non si impilano. Esc chiude e **il fuoco torna** a
  chi l'ha aperto. Nel piede: **primario a sinistra**, Annulla subito dopo.
- Il **menu** è un elenco breve e non intrappola il fuoco. Se servono gruppi e ricerca, è la
  palette.
- La **palette** è modale, si apre con ⌘K, non spinge la pagina, non si ridimensiona.
- Il **toast** dice «è fatto» o «non è riuscito» **dopo** un gesto già compiuto. Non chiede una
  decisione. Non si colora di verde o di rosso: il fondo resta inchiostro, cambia solo l'icona.
- Il **callout** resta nella pagina e porta l'azione che risolve. Non galleggia. Rosso solo se
  il lavoro è bloccato.

| Bisogno | Si usa | Non si usa |
|---|---|---|
| Dettaglio senza lasciare la lista | pannello laterale | un dialogo, una pagina nuova per tre campi |
| Conferma irreversibile | dialogo, poi primario pericolo | un toast con «Annulla» |
| «È riuscito» dopo un clic | toast | un callout permanente |
| Qualcosa che blocca il lavoro | callout errore con l'azione | un toast rosso che sparisce |
| Nessun dato | `.empty` con un verbo | una tabella di zeri, un'illustrazione |
| Attendere un clic già fatto | `.btn-spin` nel bottone | uno scheletro al posto del bottone |
| Attendere una lista | `.skel` nelle righe | uno spinner a tutto schermo |

---

## 5. Campi ed errori

- Il **placeholder non è un'etichetta**. L'etichetta sta sopra; l'errore sotto e dice **cosa
  correggere** («Manca il periodo»), non «Campo non valido».
- Al fuoco il campo sostituisce l'anello esterno con **bordo accento e alone**: non si sommano.
- Un campo vuoto mostrato come dato è `—`.

---

## 6. Accessibilità — non è un passaggio finale

- Testo ≥ 4.5:1, testo grande e controlli ≥ 3:1, **anche in hover**.
- **Il fuoco visibile non si toglie.**
- Ogni controllo ha un nome. Le voci non attive restano raggiungibili e **dicono perché**.
- Un passo non ancora apribile usa `aria-disabled`, non `disabled`, così può spiegarsi.
- `prefers-reduced-motion` rispettato: il pannello dissolve invece di scorrere, lo scheletro
  sta fermo, niente scala sui menu.
- Zoom 200% leggibile; sotto i 768 px la vista passa a schede.

---

## 7. Lingua e formati

Interfaccia in **italiano**. Date `gg/mm/aaaa`. Importi e numeri `it-IT` con `Intl`, tabellari,
allineati a destra, mai troncati. Assente `—`.

Il pulsante è verbo + oggetto. L'errore dice **cosa**, **perché** e **come si rimedia**.

---

## 8. Soglie responsive

| Sotto | Cambia |
|---|---|
| 1280 px | padding di pagina da 32 a 24; il pannello smette di spingere e si sovrappone |
| 1024 px | la barra laterale diventa un cassetto; il pannello va a tutto schermo |
| 768 px | padding 16; corpo 14→16; campi alti 40 e testo 16 (si leggono col pollice); le tabelle dense diventano schede; la griglia a due colonne diventa una |
| 480 px | è la soglia nominata: sotto i 768 le regole sopra valgono già. **Non si progetta un terzo layout** |

Si verifica a 1440, 1280, 1024 e 768. Un controllo che a 768 esce dallo schermo **non è finito**.

---

## 9. Checklist prima di consegnare

- Un solo `btn--primary` in vista, in inchiostro.
- Il blu non colora un pulsante di azione.
- Ogni esito ha forma e parola.
- Il rosso non è un avviso generico.
- **Nessun esadecimale nuovo**, nessun alias nuovo: si usa un ruolo.
- Numeri tabellari, it-IT, non troncati. Assente `—`.
- Niente card annidate. Niente titolo con etichetta sopra.
- Niente animazione su filtro, scheda, riga, tasto.
- Pulsante = verbo + oggetto. Errore = cosa, perché, come si rimedia.
- Il fuoco si vede su ogni controllo, da tastiera.
