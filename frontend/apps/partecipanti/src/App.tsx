import { Routes, Route, Navigate } from "react-router-dom";
import Iscrizione from "./pages/Iscrizione";
import ConsensoGenitore from "./pages/ConsensoGenitore";
import Attesa from "./pages/Attesa";
import Verify from "./pages/Verify";
import Selfie from "./pages/Selfie";
import Galleria from "./pages/Galleria";
import IMieiDati from "./pages/IMieiDati";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Iscrizione />} />
      <Route path="/consenso-genitore" element={<ConsensoGenitore />} />
      <Route path="/attesa" element={<Attesa />} />
      <Route path="/verifica" element={<Verify />} />
      <Route path="/selfie" element={<Selfie />} />
      <Route path="/e/:slug" element={<Galleria />} />
      <Route path="/i-miei-dati" element={<IMieiDati />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
