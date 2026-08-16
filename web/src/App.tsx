import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './lib/session';
import Acceso from './pages/Acceso';
import Hogar from './pages/Hogar';
import Resumen from './pages/Resumen';
import Movimientos from './pages/Movimientos';
import Liquidacion from './pages/Liquidacion';
import Reportes from './pages/Reportes';
import Ajustes from './pages/Ajustes';

const TABS = [
  { to: '/', glyph: '◈', label: 'Resumen', end: true },
  { to: '/movimientos', glyph: '≡', label: 'Movimientos', end: false },
  { to: '/liquidacion', glyph: '⇄', label: 'Reparto', end: false },
  { to: '/reportes', glyph: '▤', label: 'Reportes', end: false },
  { to: '/ajustes', glyph: '⚙', label: 'Ajustes', end: false },
];

export default function App() {
  const { user, household, loading } = useSession();

  if (loading) {
    return (
      <div className="app">
        <p className="muted">Cargando…</p>
      </div>
    );
  }

  if (!user) return <Acceso />;
  if (!household) return <Hogar />;

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
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="glyph" aria-hidden="true">{tab.glyph}</span>
            <span>{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}
