import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './lib/session';
import {
  IconoAjustes,
  IconoAnalisis,
  IconoMovimientos,
  IconoReparto,
  IconoResumen,
  Logo,
} from './components/Icons';
import Acceso from './pages/Acceso';
import Hogar from './pages/Hogar';
import Resumen from './pages/Resumen';
import Movimientos from './pages/Movimientos';
import Liquidacion from './pages/Liquidacion';
import Reportes from './pages/Reportes';
import Ajustes from './pages/Ajustes';

const TABS = [
  { to: '/', Icono: IconoResumen, label: 'Resumen', end: true },
  { to: '/movimientos', Icono: IconoMovimientos, label: 'Movimientos', end: false },
  { to: '/liquidacion', Icono: IconoReparto, label: 'Reparto', end: false },
  { to: '/reportes', Icono: IconoAnalisis, label: 'Análisis', end: false },
  { to: '/ajustes', Icono: IconoAjustes, label: 'Ajustes', end: false },
];

export default function App() {
  const { user, household, loading } = useSession();

  if (loading) {
    return (
      <div className="app">
        <div style={{ display: 'grid', placeItems: 'center', paddingTop: '28vh', gap: 14 }}>
          <Logo size={56} />
          <span className="muted">Cargando tus cuentas…</span>
        </div>
      </div>
    );
  }

  // Las dos pantallas de entrada se montan como rutas para poder leer el código
  // de invitación de un link /unirse/ABC123.
  if (!user) {
    return (
      <Routes>
        <Route path="/unirse/:code" element={<Acceso />} />
        <Route path="*" element={<Acceso />} />
      </Routes>
    );
  }

  if (!household) {
    return (
      <Routes>
        <Route path="/unirse/:code" element={<Hogar />} />
        <Route path="*" element={<Hogar />} />
      </Routes>
    );
  }

  return (
    <>
      <div className="app">
        <Routes>
          <Route path="/" element={<Resumen />} />
          <Route path="/movimientos" element={<Movimientos />} />
          <Route path="/liquidacion" element={<Liquidacion />} />
          <Route path="/reportes" element={<Reportes />} />
          <Route path="/ajustes/*" element={<Ajustes />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>

      <nav className="tabbar">
        {TABS.map(({ to, Icono, label, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icono size={21} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}
