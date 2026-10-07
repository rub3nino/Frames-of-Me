import { Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Verify from "./pages/Verify";
import Upload from "./pages/Upload";
import Album from "./pages/Album";
import Copertura from "./pages/Copertura";
import Statistiche from "./pages/Statistiche";
import Qualita from "./pages/Qualita";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
      <Route path="/verifica" element={<Verify />} />
      <Route path="/upload" element={<Upload />} />
      <Route path="/album" element={<Album />} />
      <Route path="/copertura" element={<Copertura />} />
      <Route path="/statistiche" element={<Statistiche />} />
      <Route path="/qualita" element={<Qualita />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
