# `packages/ui` — il kit condiviso

Tre file, caricati in quest'ordine, e sono la verità eseguibile del design:

| File | Cosa contiene |
|---|---|
| [`tokens.css`](tokens.css) | i **ruoli** (colore, tipografia, spazio, raggi, profondità, movimento, misure), ognuno con il perché accanto |
| [`base.css`](base.css) | reset e difetti degli elementi: fuoco visibile, numeri tabellari, selezione |
| [`components.css`](components.css) | l'**anatomia** dei componenti, con scritto dentro perché una misura è quella |

Le regole di giudizio — quale pezzo per quale bisogno, e perché la scelta
sbagliata è sbagliata — stanno in **[`../../../docs/brand/REGOLE.md`](../../../docs/brand/REGOLE.md)**.

## Due cose da sapere prima di scrivere una riga

**Si cita un ruolo, non un colore.** Un esadecimale in un componente è un
difetto. Se serve una tinta che non è un ruolo, il ruolo manca: si aggiunge a
`tokens.css`, non al componente.

**In fondo a `tokens.css` c'è un blocco di alias di transizione. Non si usa.**
Le quattro app (`landing`, `partecipanti`, `fotografi`, `admin`) non ne citano
nemmeno uno, verificato a macchina. Quel blocco resta in vita solo per
`_reference/vetrina/**` — la copia del sito dell'evento reale, che non è nostra
UI — e per `styleguide.html` e `logo-explorations.html`, due pagine di sviluppo
che descrivono il sistema precedente. Quando spariscono, il blocco si cancella.

## Le eccezioni, e sono due sole

**Le email.** I client di posta non supportano le variabili CSS, quindi in
`frontend/emails/**` il valore letterale è corretto. Si copia dai **commenti**
di `tokens.css`, non si scegle a occhio, e un colore che non ha un ruolo si
segnala invece di inventarlo.

**`<meta name="theme-color">`.** Un meta tag non accetta una variabile. È
l'unico esadecimale ammesso in una pagina, e porta il commento che dice di
quale ruolo è la copia.

## Ritirato

`DESIGN.md` descriveva il sistema precedente e ora rimanda qui: insegnava
Geist da Google Fonts, `#0071E3`, raggi fino a 18, display fino a 6rem e
«Primary = solid accent, white text» — l'inversione della regola attuale.
`styleguide.html` e `logo-explorations.html` sono della stessa epoca e non
sono stati aggiornati: non si usano come riferimento.
