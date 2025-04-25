
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from 'sonner';
import Dashboard from "./pages/Dashboard";
import NotFound from "./pages/NotFound";
import "./App.css";

export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-center" />
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
