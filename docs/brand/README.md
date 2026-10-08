# Identità — la norma del frontend

Queste regole sono **la legge** per chiunque tocchi la UI di Frames of Me. Vengono da un
manuale di design consegnato dal proprietario del prodotto e sono state adottate interamente:
non sono una proposta, non sono un punto di partenza da interpretare.

| Dove sta cosa | |
|---|---|
| **Le regole** | [`REGOLE.md`](REGOLE.md) — come agire, cosa non si fa, quando un pezzo non va usato |
| **I token eseguibili** | [`../../frontend/packages/ui/tokens.css`](../../frontend/packages/ui/tokens.css) |
| **L'anatomia dei componenti** | [`../../frontend/packages/ui/components.css`](../../frontend/packages/ui/components.css) |

Le **misure** stanno nei due CSS, con il perché scritto accanto a ognuna. Questo documento non
le ripete: se una misura serve, si legge lì. Dove il CSS non fissa un comportamento, qui è
scritto «non è specificato» — e **non si inventa**.

## Le due differenze dal manuale originale

Il manuale descriveva uno strumento professionale per circa cento revisori, usato otto ore di
fila, dove «lo strumento deve sparire». Frames of Me ha due superfici che quel manuale non
aveva, e la decisione su entrambe è presa:

1. **Il flusso partecipante è consumer e sta su un telefono**: 6.000 persone, due minuti,
   una volta sola, in sala. Si applica **la lingua** (colore, tipografia, spazio, movimento,
   anatomia dei componenti, i divieti) e **non il guscio** da strumento desktop: niente barra
   laterale da 240 px addosso a chi fa un selfie. Il guscio desktop vive in **admin** e
   **fotografi**, che sono esattamente il caso del manuale.
2. **Esiste una landing pubblica**, che il manuale non prevedeva. **Segue l'identità come
   tutto il resto**: nessuna eccezione pastello, nessun serif, nessun titolo oltre la scala.

Tutto il resto si applica alla lettera.
