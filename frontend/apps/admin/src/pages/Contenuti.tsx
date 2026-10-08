import { Testa } from "../guscio";
import { Vuoto } from "../parti";

/**
 * Contenuti del sito.
 *
 * Questa schermata era un CMS finto: sei schede, tabelle di blocchi, agende,
 * relatori e traduzioni, tutto inventato, con un avviso in cima che diceva
 * «dati di esempio». In una console che si usa per lavorare è la cosa
 * peggiore che si possa lasciare: un operatore che legge «Hero · bozza» non
 * ha modo di sapere che quella riga non esiste, e prima o poi dirà a qualcuno
 * che la home è in bozza.
 *
 * Quindi qui non c'è una tabella. C'è il nome di quello che manca, perché il
 * giorno in cui le rotte esisteranno chi le scrive sa già cosa deve rispondere
 * (REGOLE §4: lo stato vuoto dice perché è vuoto).
 */

export default function Contenuti() {
  return (
    <>
      <Testa
        titolo="Contenuti del sito"
        dek="La vetrina pubblica multilingue dell'evento: home, agenda, relatori, alloggi, domande frequenti."
      />
      <Vuoto titolo="Il sito non si modifica ancora da qui">
        Non esiste la parte di api che tiene i contenuti: servono le tabelle{" "}
        <span className="mono">site_pages</span>, <span className="mono">content_blocks</span> e{" "}
        <span className="mono">translations</span>, le rotte{" "}
        <span className="mono">/v1/admin/cms/*</span> e la pubblicazione{" "}
        <span className="mono">POST /v1/admin/cms/pages/:id/publish</span>. Finché non ci sono,
        questa schermata resta vuota di proposito: una tabella di contenuti inventati farebbe
        credere di aver pubblicato qualcosa.
      </Vuoto>
    </>
  );
}
