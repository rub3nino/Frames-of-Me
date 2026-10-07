import { Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Verify from "./pages/Verify";
import Dashboard from "./pages/Dashboard";
import Eventi from "./pages/Eventi";
import LinkAccesso from "./pages/LinkAccesso";
import Foto from "./pages/Foto";
import Gallerie from "./pages/Gallerie";
import Gestione from "./pages/Gestione";
import Contenuti from "./pages/Contenuti";
import Gdpr from "./pages/Gdpr";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
      <Route path="/verifica" element={<Verify />} />
      <Route path="/admin" element={<Dashboard />} />
      <Route path="/admin/eventi" element={<Eventi />} />
      <Route path="/admin/foto" element={<Foto />} />
      <Route path="/admin/gallerie" element={<Gallerie />} />
      <Route path="/admin/gestione" element={<Gestione />} />
      <Route path="/admin/contenuti" element={<Contenuti />} />
      <Route path="/admin/gdpr" element={<Gdpr />} />
      <Route path="/admin/link" element={<LinkAccesso />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
