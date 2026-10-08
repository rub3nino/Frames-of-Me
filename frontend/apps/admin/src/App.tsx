import { Navigate, Route, Routes } from "react-router-dom";
import { Guscio } from "./guscio";
import { AvvisiProvider, InchiostroProvider } from "./parti";
import { ProviderEventi } from "./lib/eventi";
import Accesso from "./pages/Accesso";
import Verifica from "./pages/Verifica";
import Diretta from "./pages/Diretta";
import Moderazione from "./pages/Moderazione";
import Codici from "./pages/Codici";
import AlbumPagina from "./pages/Album";
import Foto from "./pages/Foto";
import Gallerie from "./pages/Gallerie";
import Partecipanti from "./pages/Partecipanti";
import Accessi from "./pages/Accessi";
import Eventi from "./pages/Eventi";
import Contenuti from "./pages/Contenuti";
import Privacy from "./pages/Privacy";
import Operazioni from "./pages/Operazioni";

/**
 * Le rotte.
 *
 * `InchiostroProvider` avvolge tutto, perché la regola «un solo inchiostro in
 * vista» vale anche sull'accesso, dove non c'è guscio. `ProviderEventi` sta
 * dentro il router — gli serve `useNavigate` per rimandare all'accesso su una
 * 401 — e fuori dalle schermate, perché l'evento scelto è uno per tutta la
 * sessione e cambiando schermata non si rilegge.
 *
 * Gli indirizzi della console precedente non diventano un 404 muto:
 * «gestione» sono le impostazioni dentro «Eventi», «link» è «Accessi»,
 * «gdpr» è «Privacy». Il segnalibro di chi lavorava qui ieri atterra dove è
 * finita la cosa che cercava.
 */
export default function App() {
  return (
    <InchiostroProvider>
      <AvvisiProvider>
        <Routes>
          <Route path="/" element={<Accesso />} />
          <Route path="/verifica" element={<Verifica />} />
          <Route path="/admin/*" element={<Console />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AvvisiProvider>
    </InchiostroProvider>
  );
}

function Console() {
  return (
    <ProviderEventi>
      <Guscio>
        <Routes>
          <Route index element={<Diretta />} />
          <Route path="moderazione" element={<Moderazione />} />
          <Route path="codici" element={<Codici />} />
          <Route path="album" element={<AlbumPagina />} />
          <Route path="foto" element={<Foto />} />
          <Route path="gallerie" element={<Gallerie />} />
          <Route path="partecipanti" element={<Partecipanti />} />
          <Route path="accessi" element={<Accessi />} />
          <Route path="eventi" element={<Eventi />} />
          <Route path="contenuti" element={<Contenuti />} />
          <Route path="privacy" element={<Privacy />} />
          <Route path="operazioni" element={<Operazioni />} />

          {/* Indirizzi della console precedente. */}
          <Route path="gestione" element={<Navigate to="/admin/eventi" replace />} />
          <Route path="link" element={<Navigate to="/admin/accessi" replace />} />
          <Route path="gdpr" element={<Navigate to="/admin/privacy" replace />} />
          <Route path="moderation" element={<Navigate to="/admin/moderazione" replace />} />

          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </Guscio>
    </ProviderEventi>
  );
}
